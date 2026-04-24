import { createServerSupabaseClient } from "./supabase";

export type ToolCallResult = {
  tool: string;
  success: boolean;
  result: string;
};

export type ToolContext = {
  igsid: string;
  name: string | null;
  username: string | null;
  conversationId: string;
};

export async function executeTool(
  action: string,
  parameters: Record<string, unknown>,
  context: ToolContext
): Promise<ToolCallResult> {
  console.log(`[tools] executing: ${action}`, parameters);

  switch (action) {
    case "get_prices":
      return getPrices();
    case "create_lead":
      return createLead(parameters, context);
    default:
      return { tool: action, success: false, result: `Bilinmeyen tool: ${action}` };
  }
}

async function getPrices(): Promise<ToolCallResult> {
  const sheetUrl = process.env.GOOGLE_SHEETS_PRICES_URL;

  if (!sheetUrl) {
    return {
      tool: "get_prices",
      success: true,
      result: "Fiyat bilgisi şu an sistemde tanımlı değil. Kullanıcıya koçla doğrudan iletişime geçmesini söyle.",
    };
  }

  try {
    const res = await fetch(sheetUrl);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    return {
      tool: "get_prices",
      success: true,
      result: `Güncel fiyat listesi:\n${text}`,
    };
  } catch (err) {
    console.error("[tools] get_prices failed:", err);
    return {
      tool: "get_prices",
      success: false,
      result: "Fiyatlar şu an alınamadı. Kullanıcıya yakında bilgi verileceğini söyle.",
    };
  }
}

async function createLead(
  params: Record<string, unknown>,
  context: ToolContext
): Promise<ToolCallResult> {
  const db = createServerSupabaseClient();

  const { error } = await db.from("instagram_leads").insert({
    igsid: context.igsid,
    conversation_id: context.conversationId,
    name: context.name ?? null,
    username: context.username ?? null,
    interest: params.interest ?? null,
    location: params.location ?? null,
    lesson_type: params.lesson_type ?? null,
    notes: params.notes ?? null,
  });

  if (error) {
    console.error("[tools] create_lead failed:", error);
    return { tool: "create_lead", success: false, result: "Lead kaydedilemedi." };
  }

  return { tool: "create_lead", success: true, result: "Potansiyel müşteri kaydedildi." };
}
