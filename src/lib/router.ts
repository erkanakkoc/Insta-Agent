import OpenAI from "openai";

const ROUTER_PROMPT = `
You are an AI routing and response strategy engine for an Instagram DM automation system.

Your job is to:
1) Understand the user's intent
2) Decide how the assistant should respond
3) Select the most appropriate AI model
4) Define response style and goal

Return ONLY a valid JSON object. No explanations.

---

## INTENT LEVELS

Classify the message into ONE of these:

LOW:
- greetings ("hi", "hello")
- vague or unclear messages
- just browsing
- no clear goal

MEDIUM:
- asking about services
- asking how lessons work
- general curiosity
- interested but not ready to buy

HIGH:
- asking about price ("price", "how much", "ücret", "fiyat")
- asking about scheduling ("when can we start", "ne zaman başlayabiliriz")
- asking to join / book
- clear buying intent

Be strict:
- Only mark HIGH if there is clear buying signal
- If unsure → MEDIUM

---

## MODEL SELECTION RULES

Choose ONE model:

- LOW → "openai/gpt-4o-mini"
- MEDIUM → "openai/gpt-4o-mini"
- HIGH → "anthropic/claude-haiku-4-5"

Fallback model (always include in output):
- "openai/gpt-4o-mini"

---

## RESPONSE STRATEGY

LOW:
- goal: engage
- tone: friendly, casual
- keep it short
- ask a simple follow-up question

MEDIUM:
- goal: inform + build interest
- tone: helpful, clear
- explain briefly
- gently move toward booking

HIGH:
- goal: convert (sell)
- tone: confident, natural, human
- give clear next step
- suggest scheduling
- reduce friction

---

## OUTPUT FORMAT (STRICT)

Return ONLY this JSON:

{
  "intent": "low" | "medium" | "high",
  "model": "...",
  "fallback_model": "...",
  "strategy": {
    "goal": "...",
    "tone": "...",
    "instructions": "..."
  }
}

---

## USER MESSAGE

"""
{{MESSAGE}}
"""
`.trim();

export type RoutingResult = {
  intent: "low" | "medium" | "high";
  model: string;
  fallback_model: string;
  strategy: {
    goal: string;
    tone: string;
    instructions: string;
  };
};

const DEFAULT_ROUTING: RoutingResult = {
  intent: "medium",
  model: "openai/gpt-4o-mini",
  fallback_model: "openai/gpt-4o-mini",
  strategy: {
    goal: "inform + build interest",
    tone: "helpful, clear",
    instructions: "Explain the services briefly and guide toward booking.",
  },
};

// Models used only for the routing step — must be reliable JSON producers
const ROUTER_MODELS = [
  "openai/gpt-4o-mini",
  "meta-llama/llama-3.1-8b-instruct:free",
  "qwen/qwen-2-7b-instruct:free",
];

export async function routeMessage(userMessage: string): Promise<RoutingResult> {
  const prompt = ROUTER_PROMPT.replace("{{MESSAGE}}", userMessage);

  const openai = new OpenAI({
    baseURL: "https://openrouter.ai/api/v1",
    apiKey: process.env.OPENROUTER_API_KEY ?? "placeholder",
  });

  for (const model of ROUTER_MODELS) {
    try {
      const completion = await openai.chat.completions.create({
        model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0,
      });

      const raw = completion.choices[0]?.message?.content ?? "";
      const cleaned = raw
        .trim()
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/i, "")
        .trim();

      const parsed = JSON.parse(cleaned);

      if (parsed.intent && parsed.model && parsed.strategy) {
        console.log(`[router] intent=${parsed.intent} model=${parsed.model}`);
        return parsed as RoutingResult;
      }
    } catch (err) {
      console.warn(`[router] model ${model} failed:`, (err as Error).message);
    }
  }

  console.warn("[router] all router models failed, using default routing");
  return DEFAULT_ROUTING;
}
