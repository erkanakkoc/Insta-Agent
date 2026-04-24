import { NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase";

export async function GET() {
  const db = createServerSupabaseClient();

  const { data, error } = await db
    .from("instagram_conversations")
    .select(`
      id, igsid, name, username, profile_pic,
      follower_count, is_user_follow_business, is_business_follow_user,
      mode, updated_at, created_at,
      instagram_messages (
        content, role, created_at
      )
    `)
    .order("updated_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Attach last message to each conversation
  const conversations = (data ?? []).map((conv) => {
    const msgs = (conv.instagram_messages as { content: string; role: string; created_at: string }[]) ?? [];
    const sorted = [...msgs].sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    );
    const { instagram_messages: _, ...rest } = conv;
    return { ...rest, last_message: sorted[0] ?? null };
  });

  return NextResponse.json(conversations);
}
