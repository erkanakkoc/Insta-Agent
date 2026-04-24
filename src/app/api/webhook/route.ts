import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase";
import { fetchInstagramProfile, sendInstagramMessage } from "@/lib/instagram";
import { getAIResponse, callWithModel } from "@/lib/ai";
import { executeTool, ToolContext } from "@/lib/tools";
import { SYSTEM_PROMPT_TEMPLATE } from "@/lib/systemPrompt";
import { routeMessage, RoutingResult } from "@/lib/router";

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

// Fill the prompt template with inline conversation history and current message.
// Embedding history as text (rather than separate chat turns) ensures even
// small/free models see the full context in one shot.
function buildPrompt(history: HistoryMessage[], currentMessage: string): string {
  // history already includes the current user message as the last entry
  // (it was inserted before the history fetch). Exclude it from {{HISTORY}}.
  const previous = history.slice(0, -1);

  const historyStr =
    previous.length === 0
      ? "(No previous messages — this is the first message)"
      : previous
          .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
          .join("\n");

  return SYSTEM_PROMPT_TEMPLATE
    .replace("{{HISTORY}}", historyStr)
    .replace("{{MESSAGE}}", currentMessage);
}

function callAI(messages: ChatMessage[], routing: RoutingResult | null): Promise<string> {
  if (routing) {
    return callWithModel(routing.model, routing.fallback_model, messages);
  }
  return getAIResponse(messages);
}

// Single-turn prompt → tool loop → final reply
async function runAI(
  history: HistoryMessage[],
  currentMessage: string,
  toolContext: ToolContext,
  routing: RoutingResult | null
): Promise<string> {
  const MAX_ITERS = 4;

  // Start with the fully-filled single-turn prompt
  let messages: ChatMessage[] = [
    { role: "user", content: buildPrompt(history, currentMessage) },
  ];

  for (let i = 0; i < MAX_ITERS; i++) {
    const response = await callAI(messages, routing);

    const extracted = extractToolCall(response);
    if (!extracted) {
      return response;
    }

    console.log(`[webhook] tool call: ${extracted.action}`, extracted.parameters);

    const toolResult = await executeTool(
      extracted.action,
      extracted.parameters,
      toolContext
    );

    // Continue the conversation with the tool result
    messages = [
      ...messages,
      { role: "assistant", content: response },
      {
        role: "user",
        content: `[Fiyat bilgisi]\n${toolResult.result}\n\nBu fiyatları kullanarak kullanıcıya kısa ve doğal Türkçe ile yanıt ver. Fiyat uydurmа.`,
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

    const toolContext: ToolContext = {
      igsid: senderIgsid,
      name: profileName,
      username: profileUsername,
      conversationId: conversation.id,
    };

    const aiReply = await runAI(history, text, toolContext, routing);

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
