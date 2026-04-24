import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase";
import { sendInstagramMessage } from "@/lib/instagram";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { text } = await req.json();

  if (!text?.trim()) {
    return NextResponse.json({ error: "Message text is required" }, { status: 400 });
  }

  const db = createServerSupabaseClient();

  // Get conversation to find igsid
  const { data: conversation, error: convError } = await db
    .from("instagram_conversations")
    .select("igsid")
    .eq("id", id)
    .single();

  if (convError || !conversation) {
    console.error("[send] conversation not found:", id, convError);
    return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
  }

  // Send via Instagram Graph API
  let result: Awaited<ReturnType<typeof sendInstagramMessage>>;
  try {
    result = await sendInstagramMessage(conversation.igsid, text.trim());
  } catch (err) {
    console.error("[send] sendInstagramMessage threw:", err);
    return NextResponse.json({ error: "Failed to reach Instagram API" }, { status: 500 });
  }

  if (result.error) {
    console.error("[send] Instagram API error:", result.error);
    return NextResponse.json({ error: result.error.message }, { status: 500 });
  }

  // Store message in DB
  const { data: message, error: insertError } = await db
    .from("instagram_messages")
    .insert({
      conversation_id: id,
      role: "assistant",
      content: text.trim(),
    })
    .select()
    .single();

  if (insertError) {
    console.error("[send] DB insert error:", insertError);
    return NextResponse.json({ error: insertError.message }, { status: 500 });
  }

  // Update conversation updated_at
  await db
    .from("instagram_conversations")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", id);

  return NextResponse.json(message);
}
