// Pure model-mapping / thinking-effort resolution for the ChatGPT-web executor.
// Extracted verbatim from chatgpt-web.ts (static maps + pure resolvers, no state).

export const MODEL_MAP: Record<string, string> = {
  // ChatGPT backend slugs are also accepted directly for power users / tests.
  "gpt-5-6": "gpt-5-6",
  "gpt-5-6-thinking": "gpt-5-6-thinking",
  "gpt-5-6-pro": "gpt-5-6-pro",
  "gpt-5-5": "gpt-5-5",
  "gpt-5-5-thinking": "gpt-5-5-thinking",
  "gpt-5-5-pro": "gpt-5-5-pro",

  // Free accounts leave Luna selection to ChatGPT's server-side auto router.
  "gpt-5.6-luna-free": "auto",
  "gpt-5.6-luna-free-thinking": "auto",

  // Captured from a real ChatGPT v2 picker conversation. The visible
  // performance levels select distinct backend model/effort pairs.
  "gpt-5.6-sol-instant": "gpt-5-6",
  "gpt-5.6-sol-medium": "gpt-5-6-thinking",
  "gpt-5.6-sol-high": "gpt-5-6-thinking",
  "gpt-5.6-sol-xhigh": "gpt-5-6-thinking",
  "gpt-5.6-sol-pro": "gpt-5-6-pro",

  "gpt-5.5-instant": "gpt-5-5",
  "gpt-5.5-medium": "gpt-5-5-thinking",
  "gpt-5.5-high": "gpt-5-5-thinking",
  "gpt-5.5-xhigh": "gpt-5-5-thinking",
  "gpt-5.5-pro": "gpt-5-5-pro",
  "gpt-5.5-pro-extended": "gpt-5-5-pro",
  // Compatibility alias for existing chatgpt-web image integrations. It is
  // intentionally absent from the provider's visible curated model list.
  "gpt-5.5": "gpt-5-5",
};

export type ChatGptThinkingEffort = "standard" | "extended" | "max";

export const MODEL_FORCED_EFFORT: Record<string, ChatGptThinkingEffort | null> = {
  "gpt-5.6-sol-instant": null,
  "gpt-5.6-sol-medium": "standard",
  "gpt-5.6-sol-high": "extended",
  "gpt-5.6-sol-xhigh": "max",
  "gpt-5.6-sol-pro": "standard",
  "gpt-5.5-instant": null,
  "gpt-5.5-medium": "standard",
  "gpt-5.5-high": "extended",
  "gpt-5.5-xhigh": "max",
  "gpt-5.5-pro": "standard",
  "gpt-5.5-pro-extended": "extended",
};

const MODEL_SYSTEM_HINTS: Record<string, readonly string[]> = {
  // Captured from the Free-account Think toggle. ChatGPT sends this both at
  // the request root and on the user message metadata.
  "gpt-5.6-luna-free-thinking": ["reason"],
};

export function resolveChatGptSystemHints(model: string): string[] {
  return [...(MODEL_SYSTEM_HINTS[model] ?? [])];
}

export interface ResolvedChatGptModel {
  slug: string;
  effort: ChatGptThinkingEffort | null;
  isPro: boolean;
}

export function resolveChatGptModel(
  model: string,
  _body?: unknown,
  _providerSpecificData?: Record<string, unknown>
): ResolvedChatGptModel {
  const slug = MODEL_MAP[model] ?? model;
  const effort = MODEL_FORCED_EFFORT[model] ?? null;
  const isPro =
    model === "gpt-5.6-sol-pro" ||
    model === "gpt-5.5-pro" ||
    model === "gpt-5.5-pro-extended" ||
    slug === "gpt-5-6-pro" ||
    slug === "gpt-5-5-pro";
  return { slug, effort, isPro };
}
