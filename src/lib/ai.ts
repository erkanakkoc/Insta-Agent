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

async function tryModels(models: string[], messages: ChatMessage[]): Promise<string> {
  const openai = getOpenAI();

  for (const model of models) {
    try {
      const completion = await withTimeout(
        openai.chat.completions.create({ model, messages }),
        MODEL_TIMEOUT_MS
      );
      console.log(`[ai] model: ${model}`);
      return completion.choices[0]?.message?.content ?? "Üzgünüm, şu an bir yanıt oluşturamadım.";
    } catch (err: unknown) {
      const status = (err as { status?: number })?.status;
      const msg = (err as Error)?.message ?? "";
      const isTimeout = msg.startsWith("model_timeout");

      if (isTimeout || status === 429 || status === 404 || status === 400) {
        console.warn(`[ai] ${model} skipped (${isTimeout ? "timeout" : status})`);
        continue;
      }

      throw err;
    }
  }

  return "Üzgünüm, şu anda geçici olarak hizmet veremiyorum. Lütfen biraz sonra tekrar deneyin.";
}

export async function getAIResponse(messages: ChatMessage[]): Promise<string> {
  return tryModels(getFallbackModels(), messages);
}
