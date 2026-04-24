"use client";

import { Conversation } from "@/types";
import Avatar from "./Avatar";

type Props = {
  conversations: Conversation[];
  selectedId: string | null;
  onSelect: (id: string) => void;
};

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  return `${days}d`;
}

export default function ConversationList({ conversations, selectedId, onSelect }: Props) {
  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-4 border-b border-white/10">
        <h1 className="text-lg font-bold bg-gradient-to-r from-purple-400 to-pink-400 bg-clip-text text-transparent">
          Instagram DMs
        </h1>
        <p className="text-xs text-white/40 mt-0.5">{conversations.length} conversations</p>
      </div>

      <div className="flex-1 overflow-y-auto">
        {conversations.length === 0 && (
          <div className="flex items-center justify-center h-full text-white/30 text-sm">
            No conversations yet
          </div>
        )}
        {conversations.map((conv) => {
          const isSelected = conv.id === selectedId;
          const isAgent = conv.mode === "agent";

          return (
            <button
              key={conv.id}
              onClick={() => onSelect(conv.id)}
              className={`w-full flex items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-white/5 relative ${
                isSelected ? "bg-white/8" : ""
              }`}
            >
              {isSelected && (
                <div className="absolute left-0 top-0 bottom-0 w-0.5 bg-gradient-to-b from-purple-500 to-pink-500" />
              )}

              <Avatar
                src={conv.profile_pic}
                name={conv.name}
                username={conv.username}
                size={44}
              />

              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-1">
                  <span className="font-medium text-sm truncate text-white/90">
                    {conv.name ?? conv.username ?? conv.igsid}
                  </span>
                  <span className="text-xs text-white/30 flex-shrink-0">
                    {timeAgo(conv.updated_at)}
                  </span>
                </div>

                <div className="flex items-center gap-1.5 mt-0.5">
                  {conv.username && (
                    <span className="text-xs text-white/40 truncate">@{conv.username}</span>
                  )}
                  <span
                    className={`text-[10px] px-1.5 py-0.5 rounded-full flex-shrink-0 font-medium ${
                      isAgent
                        ? "bg-purple-500/20 text-purple-300"
                        : "bg-amber-500/20 text-amber-300"
                    }`}
                  >
                    {isAgent ? "AI" : "You"}
                  </span>
                </div>

                {conv.last_message && (
                  <p className="text-xs text-white/30 truncate mt-0.5">
                    {conv.last_message.role === "assistant" ? "You: " : ""}
                    {conv.last_message.content}
                  </p>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
