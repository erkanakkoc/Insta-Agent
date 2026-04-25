import { NextRequest, NextResponse, after } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase";
import { fetchInstagramProfile, sendInstagramMessage } from "@/lib/instagram";
import { getAIResponse } from "@/lib/ai";
import { executeTool, ToolContext } from "@/lib/tools";
import { SYSTEM_PROMPT_TEMPLATE } from "@/lib/systemPrompt";

export const dynamic = "force-dynamic";

const NO_CACHE_HEADERS = {
  "Cache-Control": "no-store, no-cache, must-revalidate",
  Pragma: "no-cache",
};

// GET — Meta webhook verification (unchanged)
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

// POST — receive Instagram DM, return 200 immediately, process in background
export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new NextResponse("Bad Request", { status: 400 });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const messaging = (body as any)?.entry?.[0]?.messaging?.[0];

  // Fast guard before spawning background work
  if (!messaging || messaging.message?.is_echo || !messaging.message?.text) {
    return new NextResponse("OK", { status: 200, headers: NO_CACHE_HEADERS });
  }

  const senderIgsid: string = messaging.sender.id;
  const text: string = messaging.message.text;
  const instagramMsgId: string = messaging.message.mid;

  // `after` tells Next.js/Vercel to keep the function alive until the callback
  // settles — the HTTP response is already sent at this point.
  after(() => {
    processInBackground(senderIgsid, text, instagramMsgId).catch((err) =>
      console.error("[bg] unhandled error:", err)
    );
  });

  return new NextResponse("OK", { status: 200, headers: NO_CACHE_HEADERS });
}

// ---------------------------------------------------------------------------
// Background processor — runs after 200 is returned to Instagram
// ---------------------------------------------------------------------------

type HistoryRow = { role: string; content: string };

async function processInBackground(
  senderIgsid: string,
  text: string,
  instagramMsgId: string
): Promise<void> {
  const db = createServerSupabaseClient();

  // 1. Find or create conversation — also select cached profile fields
  let { data: conversation } = await db
    .from("instagram_conversations")
    .select("id, mode, name, username")
    .eq("igsid", senderIgsid)
    .single();

  if (!conversation) {
    const { data: newConv } = await db
      .from("instagram_conversations")
      .insert({ igsid: senderIgsid })
      .select("id, mode, name, username")
      .single();
    conversation = newConv;
  }

  if (!conversation) return;

  // 2. Save user message — unique constraint on instagram_msg_id = idempotency
  const { error: insertError } = await db.from("instagram_messages").insert({
    conversation_id: conversation.id,
    role: "user",
    content: text,
    instagram_msg_id: instagramMsgId,
  });

  if (insertError?.code === "23505") return; // Already processed, skip

  // 3. Human mode — no auto-reply
  if (conversation.mode === "human") {
    await db
      .from("instagram_conversations")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", conversation.id);
    return;
  }

  // 4. Fetch recent history (single await — no need for allSettled wrapper)
  const { data: historyData } = await db
    .from("instagram_messages")
    .select("role, content")
    .eq("conversation_id", conversation.id)
    .order("created_at", { ascending: true })
    .limit(10);

  const history: HistoryRow[] = historyData ?? [];

  // Refresh profile only when we don't have it yet — avoids an Instagram API
  // call on every message. Cached name/username is used for this request.
  const conv = conversation as { name?: string | null; username?: string | null };
  if (!conv.name && !conv.username) {
    refreshProfile(db, senderIgsid).catch(() => {});
  }

  const toolContext: ToolContext = {
    igsid: senderIgsid,
    name: (conversation as { name?: string | null }).name ?? null,
    username: (conversation as { username?: string | null }).username ?? null,
    conversationId: conversation.id,
  };

  // 5. Run AI (single-turn template prompt, tool loop, no routing overhead)
  const aiReply = await runAI(history, text, toolContext);

  // 6. Send reply + persist — parallel, non-blocking each other
  const [sendResult] = await Promise.allSettled([
    sendInstagramMessage(senderIgsid, aiReply),
    db.from("instagram_messages").insert({
      conversation_id: conversation.id,
      role: "assistant",
      content: aiReply,
    }),
    db
      .from("instagram_conversations")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", conversation.id),
  ]);

  if (sendResult.status === "fulfilled" && sendResult.value.error) {
    console.error("[bg] send failed:", sendResult.value.error);
  }
}

// Best-effort Instagram profile refresh — never blocks the reply path
async function refreshProfile(
  db: ReturnType<typeof createServerSupabaseClient>,
  senderIgsid: string
): Promise<void> {
  const profile = await fetchInstagramProfile(senderIgsid);
  await db
    .from("instagram_conversations")
    .update({ ...profile, updated_at: new Date().toISOString() })
    .eq("igsid", senderIgsid);
}

// ---------------------------------------------------------------------------
// Prompt building
// ---------------------------------------------------------------------------

function buildPrompt(history: HistoryRow[], currentMessage: string): string {
  // history already includes the just-inserted current message as the last entry
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

// ---------------------------------------------------------------------------
// Tool call extraction
// ---------------------------------------------------------------------------

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
      return { action: parsed.action, parameters: parsed.parameters ?? {}, preamble: text.slice(0, xmlMatch.index ?? 0).trim() };
    }
  }

  const stripped = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
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
      if (parsed) return { action: parsed.action, parameters: parsed.parameters ?? {}, preamble: text.slice(0, startIdx).trim() };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// AI runner — single-turn template, tool loop, no routing overhead
// ---------------------------------------------------------------------------

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

async function runAI(
  history: HistoryRow[],
  currentMessage: string,
  toolContext: ToolContext
): Promise<string> {
  const MAX_ITERS = 3;

  let messages: ChatMessage[] = [
    { role: "user", content: buildPrompt(history, currentMessage) },
  ];

  for (let i = 0; i < MAX_ITERS; i++) {
    const response = await getAIResponse(messages);

    const extracted = extractToolCall(response);
    if (!extracted) return response;

    console.log(`[bg] tool call: ${extracted.action}`);

    const toolResult = await executeTool(extracted.action, extracted.parameters, toolContext);

    messages = [
      ...messages,
      { role: "assistant", content: response },
      {
        role: "user",
        content: `[Fiyat bilgisi]\n${toolResult.result}\n\nBu fiyatları kullanarak kullanıcıya kısa ve doğal Türkçe ile yanıt ver. Fiyat uydurma.`,
      },
    ];
  }

  return getAIResponse(messages);
}
