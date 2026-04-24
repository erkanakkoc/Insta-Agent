import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase";
import { fetchInstagramProfile, sendInstagramMessage } from "@/lib/instagram";
import { getAIResponse, callWithModel } from "@/lib/ai";
import { executeTool, ToolContext } from "@/lib/tools";
import { SYSTEM_PROMPT } from "@/lib/systemPrompt";
import { routeMessage, RoutingResult } from "@/lib/router";

// GET — Meta webhook verification
export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const mode = searchParams.get("hub.mode");
  const token = searchParams.get("hub.verify_token");
  const challenge = searchParams.get("hub.challenge");

  if (mode === "subscribe" && token === process.env.INSTAGRAM_VERIFY_TOKEN) {
    return new NextResponse(challenge, { status: 200 });
  }

  return new NextResponse("Forbidden", { status: 403 });
}

// Parse AI response for tool calls — handles plain JSON or ```json blocks
function parseToolCall(
  text: string
): { action: string; parameters: Record<string, unknown> } | null {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  if (!cleaned.startsWith("{")) return null;

  try {
    const parsed = JSON.parse(cleaned);
    if (typeof parsed.action === "string") {
      return { action: parsed.action, parameters: parsed.parameters ?? {} };
    }
  } catch {
    // Not valid JSON
  }
  return null;
}

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

// Inject routing strategy into system prompt so AI knows the goal for this message
function buildSystemPrompt(routing: RoutingResult | null): string {
  if (!routing) return SYSTEM_PROMPT;

  const strategyBlock = `

## CURRENT MESSAGE STRATEGY (follow this for your response)
Intent level: ${routing.intent.toUpperCase()}
Goal: ${routing.strategy.goal}
Tone: ${routing.strategy.tone}
Instructions: ${routing.strategy.instructions}`;

  return SYSTEM_PROMPT + strategyBlock;
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

    const toolCall = parseToolCall(response);
    if (!toolCall) {
      return response; // Plain text — send to user
    }

    console.log(`[webhook] tool call: ${toolCall.action}`, toolCall.parameters);

    const toolResult = await executeTool(
      toolCall.action,
      toolCall.parameters,
      toolContext
    );

    // Feed tool result back as a user turn so AI continues
    messages = [
      ...messages,
      { role: "assistant", content: response },
      {
        role: "user",
        content: `[Araç sonucu: ${toolResult.tool}]\n${toolResult.result}`,
      },
    ];
  }

  // Safety fallback after max iterations
  return callAI(messages, routing);
}

// POST — incoming Instagram DMs
export async function POST(req: NextRequest) {
  const body = await req.json();

  const processMessage = async () => {
    const messaging = body?.entry?.[0]?.messaging?.[0];
    if (!messaging) return;

    // Skip echo messages (sent by our own page)
    if (messaging.message?.is_echo) return;

    // Skip non-text messages
    const text: string | undefined = messaging.message?.text;
    if (!text) return;

    const senderIgsid: string = messaging.sender.id;
    const instagramMsgId: string = messaging.message.mid;

    const db = createServerSupabaseClient();

    // Find or create conversation
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

    // Fetch and upsert Instagram profile (refresh on every message)
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

    // Store user message (skip duplicate mid)
    const { error: insertError } = await db.from("instagram_messages").insert({
      conversation_id: conversation.id,
      role: "user",
      content: text,
      instagram_msg_id: instagramMsgId,
    });

    if (insertError?.code === "23505") return; // Duplicate — already processed

    // Update conversation updated_at
    await db
      .from("instagram_conversations")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", conversation.id);

    // Human mode — do not auto-reply
    if (conversation.mode === "human") return;

    // Route message to determine intent + model + strategy (run in parallel with history fetch)
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
      { role: "system", content: buildSystemPrompt(routing) },
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

    // Get AI response (routing-aware, with tool loop)
    const aiReply = await runAI(aiMessages, toolContext, routing);

    // Send reply via Instagram Graph API
    const sendResult = await sendInstagramMessage(senderIgsid, aiReply);
    if (sendResult.error) {
      console.error("[webhook] Failed to send message:", sendResult.error);
    }

    // Store AI response in DB
    await db.from("instagram_messages").insert({
      conversation_id: conversation.id,
      role: "assistant",
      content: aiReply,
    });
  };

  // Fire-and-forget so we return 200 immediately to Meta
  processMessage().catch((err) => console.error("[webhook] processing error:", err));

  return new NextResponse("OK", { status: 200 });
}
