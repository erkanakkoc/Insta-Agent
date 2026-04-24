import OpenAI from "openai";

function getOpenAI() {
  return new OpenAI({
    baseURL: "https://openrouter.ai/api/v1",
    apiKey: process.env.OPENROUTER_API_KEY ?? "placeholder",
  });
}

function getFallbackModels(): string[] {
  return [
    // Primary model from env (set this to a reliable paid model for production)
    process.env.AI_MODEL,
    // Meta — separate provider, won't rate-limit together with Google
    "meta-llama/llama-3.1-8b-instruct:free",
    "meta-llama/llama-3.2-3b-instruct:free",
    // Qwen (Alibaba) — different provider
    "qwen/qwen-2-7b-instruct:free",
    // DeepSeek — different provider
    "deepseek/deepseek-r1-distill-qwen-7b:free",
    // Microsoft — different provider
    "microsoft/phi-3-mini-128k-instruct:free",
    // Google — original chain, now further down
    "google/gemma-3-12b-it:free",
    "google/gemma-3-4b-it:free",
    // Mistral
    "mistralai/mistral-7b-instruct:free",
  ].filter(Boolean) as string[];
}

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

// Gemma (Google AI Studio) doesn't support the "system" role — prepend it to
// the first user message so the prompt works across all free OpenRouter models.
function normalizeMessages(messages: ChatMessage[]): ChatMessage[] {
  const systemContent = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");

  const rest = messages.filter((m) => m.role !== "system");

  if (!systemContent) return rest;

  const firstUserIdx = rest.findIndex((m) => m.role === "user");
  if (firstUserIdx === -1) {
    return [{ role: "user", content: systemContent }, ...rest];
  }

  return rest.map((m, i) =>
    i === firstUserIdx
      ? { ...m, content: `${systemContent}\n\n${m.content}` }
      : m
  );
}

async function tryModels(models: string[], payload: ChatMessage[]): Promise<string> {
  const openai = getOpenAI();

  for (const model of models) {
    try {
      const completion = await openai.chat.completions.create({ model, messages: payload });
      console.log(`[ai] responded with model: ${model}`);
      return completion.choices[0]?.message?.content || "Üzgünüm, şu an bir yanıt oluşturamadım.";
    } catch (err: unknown) {
      const status = (err as { status?: number })?.status;
      if (status === 429 || status === 404 || status === 400) {
        console.warn(`Model ${model} failed with ${status}, trying next...`);
        continue;
      }
      throw err;
    }
  }
  return "Üzgünüm, şu anda geçici olarak hizmet veremiyorum. Lütfen biraz sonra tekrar deneyin";
}

// Default fallback chain — used when no specific model is routed
export async function getAIResponse(messages: ChatMessage[]): Promise<string> {
  return tryModels(getFallbackModels(), normalizeMessages(messages));
}

// Routed call — tries primaryModel first, then fallbackModel, then standard chain
export async function callWithModel(
  primaryModel: string,
  fallbackModel: string,
  messages: ChatMessage[]
): Promise<string> {
  const chain = [
    primaryModel,
    fallbackModel,
    // Append standard chain excluding already-listed models to avoid duplicates
    ...getFallbackModels().filter((m) => m !== primaryModel && m !== fallbackModel),
  ];
  return tryModels(chain, normalizeMessages(messages));
}
