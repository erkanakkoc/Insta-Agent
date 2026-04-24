"use client";

import { useEffect, useState, useCallback } from "react";
import { Conversation } from "@/types";
import { supabase } from "@/lib/supabase";
import ConversationList from "@/components/ConversationList";
import ChatPanel from "@/components/ChatPanel";

export default function DashboardPage() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const loadConversations = useCallback(async () => {
    const res = await fetch("/api/conversations");
    const data = await res.json();
    if (Array.isArray(data)) {
      setConversations(data);
    }
  }, []);

  useEffect(() => {
    loadConversations();
  }, [loadConversations]);

  // Polling fallback every 5s for when Realtime is blocked by RLS
  useEffect(() => {
    const interval = setInterval(loadConversations, 5000);
    return () => clearInterval(interval);
  }, [loadConversations]);

  // Realtime: refresh conversation list on any conversation/message change
  useEffect(() => {
    const channel = supabase
      .channel("conversations-feed")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "instagram_conversations" },
        () => loadConversations()
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "instagram_messages" },
        () => loadConversations()
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [loadConversations]);

  const handleModeChange = (id: string, mode: "agent" | "human") => {
    setConversations((prev) =>
      prev.map((c) => (c.id === id ? { ...c, mode } : c))
    );
  };

  const selectedConversation = conversations.find((c) => c.id === selectedId) ?? null;

  return (
    <div className="flex h-screen bg-[#0f0f0f]">
      {/* Sidebar */}
      <div className="w-80 flex-shrink-0 border-r border-white/10 flex flex-col bg-[#111]">
        <ConversationList
          conversations={conversations}
          selectedId={selectedId}
          onSelect={setSelectedId}
        />
      </div>

      {/* Chat area */}
      <div className="flex-1 flex flex-col">
        {selectedConversation ? (
          <ChatPanel
            key={selectedConversation.id}
            conversation={selectedConversation}
            onModeChange={handleModeChange}
          />
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center text-white/20 select-none">
            <svg
              width="64"
              height="64"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1"
              className="mb-4 opacity-30"
            >
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
            <p className="text-sm">Select a conversation to start</p>
          </div>
        )}
      </div>
    </div>
  );
}
