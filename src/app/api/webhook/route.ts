import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase";
import { fetchInstagramProfile, sendInstagramMessage } from "@/lib/instagram";
import { getAIResponse, callWithModel } from "@/lib/ai";
import { executeTool, ToolContext } from "@/lib/tools";
import { SYSTEM_PROMPT } from "@/lib/systemPrompt";
import { routeMessage, RoutingResult } from "@/lib/router";

// Prevent Next.js from caching this route — Meta webhooks must always be
// handled dynamically. Caching causes 304 responses which break verification.
export const dynamic = "force-dynamic";

const NO_CACHE_HEADERS = {
  "Cache-Control": "no-store, no-cache, must-revalidate",
  Pragma: "no-cache",
};

// GET — Meta webhook verification
export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const mode = searchParams.get("hub.mode");
  const token = searchParams.get("hub.verify_token");
  const challenge = searchParams.get("hub.challenge");

  if (mode === "subscribe" && token === process.env.INSTAGRAM_VERIFY_TOKEN) {
    return new NextResponse(challenge, { status: 200, headers: NO_CACHE_HEADERS });
  }

  return new NextResponse("Forbidden", { status: 403, headers: NO_CACHE_HEADERS });
}

type ExtractedToolCall = {
  action: string;
  parameters: Record<string, unknown>;
  preamble: string;
};

function extractToolCall(text: string): ExtractedToolCall | null {
  const tryParse = (s: string) => {
    try {
      const p = JSON.parse(s.trim());
      if (typeof p.action === "string") return p;
    } catch {}
    return null;
  };

  const xmlMatch = text.match(/<function_calls>([\s\S]*?)<\/function_calls>/i);
  if (xmlMatch) {
    const parsed = tryParse(xmlMatch[1]);
    if (parsed) {
      return {
        action: parsed.action,
        parameters: parsed.parameters ?? {},
        preamble: text.slice(0, xmlMatch.index ?? 0).trim(),
      };
    }
  }

  const stripped = text.trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  if (stripped.startsWith("{")) {
    const parsed = tryParse(stripped);
    if (parsed) return { action: parsed.action, parameters: parsed.parameters ?? {}, preamble: "" };
  }

  const startIdx = text.indexOf('{"action"');
  if (startIdx !== -1) {
    let depth = 0, endIdx = -1;
    for (let i = startIdx; i < text.length; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}") { depth--; if (depth === 0) { endIdx = i; break; } }
    }
    if (endIdx !== -1) {
      const parsed = tryParse(text.slice(startIdx, endIdx + 1));
      if (parsed) {
        return {
          action: parsed.action,
          parameters: parsed.parameters ?? {},
          preamble: text.slice(0, startIdx).trim(),
        };
      }
    }
  }

  return null;
}

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };
type HistoryMessage = { role: string; content: string };

// --- Conversation state machine ---
// Instead of asking the AI to figure out what's been discussed, we extract the
// state ourselves from message history and inject exact instructions so that
// even small/free models can't accidentally restart the flow.

type ConversationState = {
  lesson_type: "ice" | "roller" | null;
  location: "bostanli" | "goztepe" | null;
  lesson_format: "individual" | "group" | null;
};

function extractConversationState(history: HistoryMessage[]): ConversationState {
  // Only look at user messages — assistant messages may echo back words
  const userText = history
    .filter((m) => m.role === "user")
    .map((m) => m.content.toLowerCase())
    .join(" ");

  return {
    lesson_type:
      /tekerlekli|roller/.test(userText)
        ? "roller"
        : /buz\s*paten|buz\s*kaym|ice\s*skat/.test(userText)
        ? "ice"
        : null,
    location:
      /bostanl/.test(userText)
        ? "bostanli"
        : /g[oö]ztepe|sahil/.test(userText)
        ? "goztepe"
        : null,
    lesson_format:
      /birebir|bireysel|[oö]zel/.test(userText)
        ? "individual"
        : /grup|group/.test(userText)
        ? "group"
        : null,
  };
}

function getNextStep(state: ConversationState): string {
  if (!state.lesson_type)
    return 'Kullanıcıya şunu sor: "Buz pateni mi tekerlekli paten mi düşünüyorsun?"';
  if (state.lesson_type === "ice")
    return "Buz pateni mevcut değil. Bunu nazikçe açıkla ve talep formunu gönder: https://forms.gle/7Cb9L3y63JEN869T8";
  if (!state.location)
    return 'Kullanıcıya şunu sor: "Bostanlı mı Göztepe mi?"';
  if (state.location === "goztepe")
    return "Kullanıcıya Göztepe formunu gönder: https://forms.gle/jyhmFVMZnvNxgSQu7";
  if (!state.lesson_format)
    return 'Kullanıcıya şunu sor: "Birebir mi grup dersi mi?"';
  if (state.lesson_format === "individual")
    return "Kullanıcıya Bostanlı birebir formunu gönder: https://forms.gle/MtYW78bTPpAQPF4r8";
  return "Kullanıcıya Bostanlı grup formunu gönder: https://forms.gle/EbcNkzQQbAxRms8E8";
}

function buildSystemPrompt(
  routing: RoutingResult | null,
  history: HistoryMessage[]
): string {
  const state = extractConversationState(history);

  // Summarise what we already know so AI never re-asks it
  const known: string[] = [];
  if (state.lesson_type)
    known.push(state.lesson_type === "roller" ? "Tekerlekli paten istediğini söyledi" : "Buz pateni istediğini söyledi");
  if (state.location)
    known.push(state.location === "bostanli" ? "Bostanlı tercih etti" : "Göztepe tercih etti");
  if (state.lesson_format)
    known.push(state.lesson_format === "individual" ? "Birebir ders istediğini söyledi" : "Grup dersi istediğini söyledi");

  const knownBlock =
    known.length > 0
      ? `\n\n## KULLANICININ DAHA ÖNCE SÖYLEDİKLERİ (bunları bir daha SORMA)\n${known.join("\n")}`
      : "";

  // Check if the current message is a price question — if so, don't inject a
  // flow step so the price tool instruction in SYSTEM_PROMPT takes over.
  const lastUserMsg = [...history].reverse().find((m) => m.role === "user")?.content.toLowerCase() ?? "";
  const isPriceQuery = /fiyat|ücret|kaç\s*para|ne\s*kadar/.test(lastUserMsg);

  const nextStepBlock = !isPriceQuery
    ? `\n\n## ŞIMDI YAPMAN GEREKEN\n${getNextStep(state)}`
    : "";

  console.log(`[webhook] state: lesson=${state.lesson_type} loc=${state.location} fmt=${state.lesson_format} priceQuery=${isPriceQuery}`);

  return SYSTEM_PROMPT + knownBlock + nextStepBlock;
}

// Call AI — uses routed model if available, otherwise standard fallback chain
function callAI(messages: ChatMessage[], routing: RoutingResult | null): Promise<string> {
  if (routing) {
    return callWithModel(routing.model, routing.fallback_model, messages);
  }
  return getAIResponse(messages);
}

// Run AI in a tool-use loop (max 4 iterations to prevent runaway)
async function runAI(
  messages: ChatMessage[],
  toolContext: ToolContext,
  routing: RoutingResult | null
): Promise<string> {
  const MAX_ITERS = 4;

  for (let i = 0; i < MAX_ITERS; i++) {
    const response = await callAI(messages, routing);

    const extracted = extractToolCall(response);
    if (!extracted) {
      return response;
    }

    console.log(`[webhook] tool call: ${extracted.action}`, extracted.parameters);
    if (extracted.preamble) {
      console.log(`[webhook] preamble stripped: "${extracted.preamble}"`);
    }

    const toolResult = await executeTool(
      extracted.action,
      extracted.parameters,
      toolContext
    );

    const preambleNote = extracted.preamble
      ? `[AI başlangıç metni: "${extracted.preamble}"]\n`
      : "";

    messages = [
      ...messages,
      { role: "assistant", content: response },
      {
        role: "user",
        content: `${preambleNote}[Araç sonucu: ${toolResult.tool}]\n${toolResult.result}\n\nBu bilgiyi kullanarak kullanıcıya doğal Türkçe ile yanıt ver. Kesinlikle kendi fiyat uydurma.`,
      },
    ];
  }

  return callAI(messages, routing);
}

// POST — incoming Instagram DMs
export async function POST(req: NextRequest) {
  const body = await req.json();

  const processMessage = async () => {
    const messaging = body?.entry?.[0]?.messaging?.[0];
    if (!messaging) return;

    if (messaging.message?.is_echo) return;

    const text: string | undefined = messaging.message?.text;
    if (!text) return;

    const senderIgsid: string = messaging.sender.id;
    const instagramMsgId: string = messaging.message.mid;

    const db = createServerSupabaseClient();

    let { data: conversation } = await db
      .from("instagram_conversations")
      .select("id, mode")
      .eq("igsid", senderIgsid)
      .single();

    if (!conversation) {
      const { data: newConv } = await db
        .from("instagram_conversations")
        .insert({ igsid: senderIgsid })
        .select("id, mode")
        .single();
      conversation = newConv;
    }

    if (!conversation) return;

    let profileName: string | null = null;
    let profileUsername: string | null = null;
    try {
      const profile = await fetchInstagramProfile(senderIgsid);
      profileName = profile.name;
      profileUsername = profile.username;
      await db
        .from("instagram_conversations")
        .update({ ...profile, updated_at: new Date().toISOString() })
        .eq("igsid", senderIgsid);
    } catch (err) {
      console.error("[webhook] Failed to fetch Instagram profile:", err);
    }

    const { error: insertError } = await db.from("instagram_messages").insert({
      conversation_id: conversation.id,
      role: "user",
      content: text,
      instagram_msg_id: instagramMsgId,
    });

    if (insertError?.code === "23505") return;

    await db
      .from("instagram_conversations")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", conversation.id);

    if (conversation.mode === "human") return;

    const [routingResult, historyResult] = await Promise.allSettled([
      routeMessage(text),
      db
        .from("instagram_messages")
        .select("role, content")
        .eq("conversation_id", conversation.id)
        .order("created_at", { ascending: true })
        .limit(20),
    ]);

    const routing =
      routingResult.status === "fulfilled" ? routingResult.value : null;

    const history =
      historyResult.status === "fulfilled" ? (historyResult.value.data ?? []) : [];

    const aiMessages: ChatMessage[] = [
      { role: "system", content: buildSystemPrompt(routing, history) },
      ...history.map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      })),
    ];

    const toolContext: ToolContext = {
      igsid: senderIgsid,
      name: profileName,
      username: profileUsername,
      conversationId: conversation.id,
    };

    const aiReply = await runAI(aiMessages, toolContext, routing);

    const sendResult = await sendInstagramMessage(senderIgsid, aiReply);
    if (sendResult.error) {
      console.error("[webhook] Failed to send message:", sendResult.error);
    }

    await db.from("instagram_messages").insert({
      conversation_id: conversation.id,
      role: "assistant",
      content: aiReply,
    });
  };

  processMessage().catch((err) => console.error("[webhook] processing error:", err));

  return new NextResponse("OK", { status: 200, headers: NO_CACHE_HEADERS });
}
