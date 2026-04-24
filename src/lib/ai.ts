import OpenAI from "openai";

function getOpenAI() {
  return new OpenAI({
    baseURL: "https://openrouter.ai/api/v1",
    apiKey: process.env.OPENROUTER_API_KEY ?? "placeholder",
  });
}

function getFallbackModels(): string[] {
  return [
    process.env.AI_MODEL,
    "meta-llama/llama-3.1-8b-instruct:free",
    "meta-llama/llama-3.2-3b-instruct:free",
    "qwen/qwen-2-7b-instruct:free",
    "deepseek/deepseek-r1-distill-qwen-7b:free",
    "microsoft/phi-3-mini-128k-instruct:free",
    "google/gemma-3-12b-it:free",
    "google/gemma-3-4b-it:free",
    "mistralai/mistral-7b-instruct:free",
  ].filter(Boolean) as string[];
}

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

// Fallback for models that don't support the "system" role (e.g. Gemma via
// Google AI Studio). Prepends system content into the first user message so
// the instructions still reach the model.
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

// Try models in order. For each model, first attempt with the original
// messages (preserving the system role). If the model returns 400 (e.g.
// Gemma rejecting "developer instructions"), retry once with the system
// role stripped and prepended to the first user message instead.
async function tryModels(models: string[], messages: ChatMessage[]): Promise<string> {
  const openai = getOpenAI();
  const normalizedMessages = normalizeMessages(messages); // computed once

  for (const model of models) {
    let payload = messages;
    let retriedNormalized = false;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        const completion = await openai.chat.completions.create({ model, messages: payload });
        console.log(`[ai] responded with model: ${model}`);
        return completion.choices[0]?.message?.content || "Üzgünüm, şu an bir yanıt oluşturamadım.";
      } catch (err: unknown) {
        const status = (err as { status?: number })?.status;

        if (status === 400 && !retriedNormalized) {
          // Model rejected system role — retry without it
          console.warn(`[ai] ${model} rejected system role (400), retrying normalized...`);
          payload = normalizedMessages;
          retriedNormalized = true;
          continue;
        }

        if (status === 429 || status === 404 || status === 400) {
          console.warn(`[ai] Model ${model} failed with ${status}, trying next...`);
          break; // move to next model
        }

        throw err; // unexpected error — propagate
      }
    }
  }

  return "Üzgünüm, şu anda geçici olarak hizmet veremiyorum. Lütfen biraz sonra tekrar deneyin";
}

// Default fallback chain — used when no specific model is routed
export async function getAIResponse(messages: ChatMessage[]): Promise<string> {
  return tryModels(getFallbackModels(), messages);
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
    ...getFallbackModels().filter((m) => m !== primaryModel && m !== fallbackModel),
  ];
  return tryModels(chain, messages);
}
