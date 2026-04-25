import OpenAI from "openai";

function getOpenAI() {
  return new OpenAI({
    baseURL: "https://openrouter.ai/api/v1",
    apiKey: process.env.OPENROUTER_API_KEY ?? "placeholder",
  });
}

// Lean chain — 3 models max. Each gets 12 s before we move on.
// More models = more sequential latency when upstream is degraded.
function getFallbackModels(): string[] {
  return [
    process.env.AI_MODEL,
    "meta-llama/llama-3.1-8b-instruct:free",
    "qwen/qwen-2-7b-instruct:free",
  ].filter(Boolean) as string[];
}

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

// Hard per-model timeout — prevents one hung model from blocking the whole chain
const MODEL_TIMEOUT_MS = 12_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`model_timeout_${ms}ms`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

// Models that reject the "system" role (e.g. some Gemma variants) get the
// system content prepended to the first user message instead.
function normalizeMessages(messages: ChatMessage[]): ChatMessage[] {
  const systemContent = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");

  const rest = messages.filter((m) => m.role !== "system");
  if (!systemContent) return rest;

  const firstUserIdx = rest.findIndex((m) => m.role === "user");
  if (firstUserIdx === -1) return [{ role: "user", content: systemContent }, ...rest];

  return rest.map((m, i) =>
    i === firstUserIdx ? { ...m, content: `${systemContent}\n\n${m.content}` } : m
  );
}

async function tryModels(models: string[], messages: ChatMessage[]): Promise<string> {
  const openai = getOpenAI();
  const normalizedMessages = normalizeMessages(messages); // computed once

  for (const model of models) {
    let payload = messages;
    let retriedNormalized = false;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        const completion = await withTimeout(
          openai.chat.completions.create({ model, messages: payload }),
          MODEL_TIMEOUT_MS
        );
        console.log(`[ai] model: ${model}`);
        return completion.choices[0]?.message?.content ?? "Üzgünüm, şu an bir yanıt oluşturamadım.";
      } catch (err: unknown) {
        const status = (err as { status?: number })?.status;
        const msg = (err as Error)?.message ?? "";
        const isTimeout = msg.startsWith("model_timeout");

        if (status === 400 && !retriedNormalized) {
          // Model rejected system role — retry once without it
          payload = normalizedMessages;
          retriedNormalized = true;
          continue;
        }

        if (isTimeout || status === 429 || status === 404 || status === 400) {
          console.warn(`[ai] ${model} skipped (${isTimeout ? "timeout" : status})`);
          break; // try next model
        }

        throw err; // unexpected — propagate
      }
    }
  }

  return "Üzgünüm, şu anda geçici olarak hizmet veremiyorum. Lütfen biraz sonra tekrar deneyin.";
}

export async function getAIResponse(messages: ChatMessage[]): Promise<string> {
  return tryModels(getFallbackModels(), messages);
}

// Used by router or any caller that wants a specific primary model
export async function callWithModel(
  primaryModel: string,
  fallbackModel: string,
  messages: ChatMessage[]
): Promise<string> {
  const chain = [
    primaryModel,
    fallbackModel,
    ...getFallbackModels().filter((m) => m !== primaryModel && m !== fallbackModel),
  ].slice(0, 3);
  return tryModels(chain, messages);
}
