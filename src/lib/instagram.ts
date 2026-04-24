export type InstagramProfile = {
  name: string | null;
  username: string | null;
  profile_pic: string | null;
  follower_count: number | null;
  is_user_follow_business: boolean | null;
  is_business_follow_user: boolean | null;
};

export async function fetchInstagramProfile(igsid: string): Promise<InstagramProfile> {
  const url = new URL(`https://graph.instagram.com/v24.0/${igsid}`);
  url.searchParams.set(
    "fields",
    "name,username,profile_pic,follower_count,is_user_follow_business,is_business_follow_user"
  );
  url.searchParams.set("access_token", process.env.INSTAGRAM_ACCESS_TOKEN!);

  const res = await fetch(url.toString());

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Instagram profile API ${res.status}: ${body}`);
  }

  const data = await res.json();

  if (data.error) {
    throw new Error(`Instagram profile API error: ${JSON.stringify(data.error)}`);
  }

  console.log(`[instagram] profile for ${igsid}:`, JSON.stringify(data));

  return {
    name: data.name ?? null,
    username: data.username ?? null,
    profile_pic: data.profile_pic ?? null,
    follower_count: data.follower_count ?? null,
    is_user_follow_business: data.is_user_follow_business ?? null,
    is_business_follow_user: data.is_business_follow_user ?? null,
  };
}

export async function sendInstagramMessage(
  recipientIgsid: string,
  text: string
): Promise<{ message_id?: string; error?: { message: string; code: number } }> {
  const url = new URL("https://graph.instagram.com/v24.0/me/messages");
  url.searchParams.set("access_token", process.env.INSTAGRAM_ACCESS_TOKEN!);

  const res = await fetch(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      recipient: { id: recipientIgsid },
      message: { text },
    }),
  });

  const data = await res.json();

  if (!res.ok || data.error) {
    console.error(`[instagram] sendMessage failed (${res.status}):`, JSON.stringify(data));
  }

  return data;
}
