export type Conversation = {
  id: string;
  igsid: string;
  name: string | null;
  username: string | null;
  profile_pic: string | null;
  follower_count: number | null;
  is_user_follow_business: boolean | null;
  is_business_follow_user: boolean | null;
  mode: "agent" | "human";
  updated_at: string;
  created_at: string;
  last_message?: {
    content: string;
    role: string;
    created_at: string;
  } | null;
};

export type Message = {
  id: string;
  conversation_id: string;
  role: "user" | "assistant";
  content: string;
  instagram_msg_id: string | null;
  created_at: string;
};
