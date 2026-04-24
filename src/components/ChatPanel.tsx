"use client";

import { useEffect, useRef, useState } from "react";
import { Conversation, Message } from "@/types";
import { supabase } from "@/lib/supabase";
import Avatar from "./Avatar";

type Props = {
  conversation: Conversation;
  onModeChange: (id: string, mode: "agent" | "human") => void;
};

function formatTime(dateStr: string): string {
  return new Date(dateStr).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function ChatPanel({ conversation, onModeChange }: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [togglingMode, setTogglingMode] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Load messages on conversation change
  useEffect(() => {
    setMessages([]);
    fetch(`/api/conversations/${conversation.id}/messages`)
      .then((r) => r.json())
      .then((data) => {
        if (Array.isArray(data)) setMessages(data);
      });
  }, [conversation.id]);

  // Polling fallback — fires every 3s to catch messages when Realtime is
  // blocked by RLS SELECT policies denying the anon key.
  useEffect(() => {
    const interval = setInterval(() => {
      fetch(`/api/conversations/${conversation.id}/messages`)
        .then((r) => r.json())
        .then((data: unknown) => {
          if (!Array.isArray(data)) return;
          setMessages((prev) => {
            const existingIds = new Set(prev.map((m) => m.id));
            const newMsgs = (data as Message[]).filter((m) => !existingIds.has(m.id));
            return newMsgs.length > 0 ? [...prev, ...newMsgs] : prev;
          });
        })
        .catch(() => {});
    }, 3000);
    return () => clearInterval(interval);
  }, [conversation.id]);

  // Realtime subscription for new messages
  useEffect(() => {
    const channel = supabase
      .channel(`messages:${conversation.id}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "instagram_messages",
          filter: `conversation_id=eq.${conversation.id}`,
        },
        (payload) => {
          setMessages((prev) => {
            if (prev.some((m) => m.id === payload.new.id)) return prev;
            return [...prev, payload.new as Message];
          });
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [conversation.id]);

  // Scroll to bottom on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSend = async () => {
    const text = input.trim();
    if (!text || sending) return;

    setSending(true);
    setInput("");

    try {
      await fetch(`/api/conversations/${conversation.id}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
    } finally {
      setSending(false);
    }
  };

  const handleToggleMode = async () => {
    const newMode = conversation.mode === "agent" ? "human" : "agent";
    setTogglingMode(true);
    try {
      await fetch(`/api/conversations/${conversation.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: newMode }),
      });
      onModeChange(conversation.id, newMode);
    } finally {
      setTogglingMode(false);
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-3 px-5 py-3 border-b border-white/10 flex-shrink-0">
        <Avatar
          src={conversation.profile_pic}
          name={conversation.name}
          username={conversation.username}
          size={40}
        />

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-white/90">
              {conversation.name ?? conversation.username ?? conversation.igsid}
            </span>
            {conversation.username && (
              <span className="text-sm text-white/40">@{conversation.username}</span>
            )}
            {conversation.follower_count != null && (
              <span className="text-xs text-white/30">
                {conversation.follower_count.toLocaleString()} followers
              </span>
            )}
          </div>

          <div className="flex items-center gap-2 mt-0.5 flex-wrap">
            {conversation.is_user_follow_business && (
              <span className="text-[10px] bg-purple-500/20 text-purple-300 px-1.5 py-0.5 rounded-full">
                Follows you
              </span>
            )}
            {conversation.is_business_follow_user && (
              <span className="text-[10px] bg-pink-500/20 text-pink-300 px-1.5 py-0.5 rounded-full">
                You follow
              </span>
            )}
          </div>
        </div>

        <button
          onClick={handleToggleMode}
          disabled={togglingMode}
          className={`text-xs px-3 py-1.5 rounded-full font-medium transition-all flex-shrink-0 ${
            conversation.mode === "agent"
              ? "bg-purple-500/20 text-purple-300 hover:bg-purple-500/30"
              : "bg-amber-500/20 text-amber-300 hover:bg-amber-500/30"
          } disabled:opacity-50`}
        >
          {togglingMode ? "..." : conversation.mode === "agent" ? "AI Mode" : "Human Mode"}
        </button>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
        {messages.length === 0 && (
          <div className="flex items-center justify-center h-full text-white/20 text-sm">
            No messages yet
          </div>
        )}

        {messages.map((msg) => {
          const isUser = msg.role === "user";

          return (
            <div
              key={msg.id}
              className={`flex items-end gap-2 ${isUser ? "flex-row" : "flex-row-reverse"}`}
            >
              {isUser && (
                <Avatar
                  src={conversation.profile_pic}
                  name={conversation.name}
                  username={conversation.username}
                  size={28}
                />
              )}

              <div className={`max-w-[70%] ${isUser ? "" : "items-end"} flex flex-col`}>
                <div
                  className={`px-3.5 py-2 rounded-2xl text-sm leading-relaxed break-words ${
                    isUser
                      ? "bg-white/10 text-white/90 rounded-bl-sm"
                      : "text-white rounded-br-sm bg-gradient-to-br from-purple-600 to-pink-600"
                  }`}
                >
                  {msg.content}
                </div>
                <div className={`flex items-center gap-1 mt-1 ${isUser ? "" : "flex-row-reverse"}`}>
                  <span className="text-[10px] text-white/20">
                    {formatTime(msg.created_at)}
                  </span>
                  {!isUser && (
                    <span className="text-[10px] text-white/20">AI ·</span>
                  )}
                </div>
              </div>
            </div>
          );
        })}

        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="px-4 py-3 border-t border-white/10 flex-shrink-0">
        <div className="flex items-center gap-2 bg-white/5 rounded-2xl px-4 py-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
            placeholder={
              conversation.mode === "human"
                ? "Type a message as yourself..."
                : "Send a manual message..."
            }
            className="flex-1 bg-transparent text-sm text-white/90 placeholder-white/25 outline-none"
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || sending}
            className="w-8 h-8 rounded-full bg-gradient-to-br from-purple-500 to-pink-500 flex items-center justify-center disabled:opacity-30 transition-opacity flex-shrink-0"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M22 2L11 13" />
              <path d="M22 2L15 22L11 13L2 9L22 2Z" />
            </svg>
          </button>
        </div>
        {conversation.mode === "agent" && (
          <p className="text-[10px] text-white/20 text-center mt-1.5">
            AI is auto-replying · Switch to Human Mode to reply manually
          </p>
        )}
      </div>
    </div>
  );
}
