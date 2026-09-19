import { REGISTRY } from "../config/providerRegistry.ts";
import {
  BaseExecutor,
  mergeUpstreamExtraHeaders,
  sanitizeReasoningEffortForProvider,
  type ExecuteInput,
} from "./base.ts";

type JsonRecord = Record<string, unknown>;

// Defensive server-side ceiling for a CLIENT-SUPPLIED max_tokens. The official
// /provider/v1/chat/completions endpoint (documented OpenAI-format surface) is
// the successor to the CLI-only /alpha/generate endpoint, which rejected any
// params.max_tokens > 200_000 with a 400. We only clamp a client-supplied value
// down; we never fabricate this number for requests that omit the field (see
// clampMaxTokens / buildOpenAiBody).
const MAX_COMMAND_CODE_TOKENS = 200_000;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

// Clamp a client-supplied max_tokens to the endpoint ceiling, mirroring the
// provider-driven clamp in antigravity.ts: we only intervene when the value is
// present, positive AND would otherwise be rejected (> MAX_COMMAND_CODE_TOKENS).
// A valid value is returned floored; anything absent, non-numeric or non-positive
// returns undefined so the caller can OMIT the field entirely and let the
// provider's upstream apply the model's own native default (rather than us
// inventing a number). A non-positive value such as Zoo Code's max_tokens:-1
// ("let the server choose") must be omitted, NOT forced to 1 — the old
// Math.max(1,...) truncated output to a single token (#5166).
function clampMaxTokens(value: unknown): number | undefined {
  const numeric = numberValue(value);
  if (numeric === undefined || numeric <= 0) return undefined;
  return Math.min(Math.floor(numeric), MAX_COMMAND_CODE_TOKENS);
}

/**
 * Command Code serves most models under a vendor-prefixed wire id (e.g.
 * `xiaomi/mimo-v2.5`, `deepseek/deepseek-v4-pro`, `moonshotai/Kimi-K2.6`).
 * The command-code registry ids already carry the vendor prefix, so a bare id
 * reaching the executor is an operator-set custom model (e.g. the Vision Bridge
 * picker, #10809). Map the small set of documented bare ids to their
 * vendor-prefixed wire form; anything with an explicit `/` (or already wired)
 * passes through untouched. Kept minimal and doc-backed.
 */
const COMMAND_CODE_BARE_MODEL_VENDOR_PREFIX: Readonly<Record<string, string>> = {
  // Xiaomi MiMo V2.5 — a CC-served vision model not in the registry.
  "mimo-v2.5": "xiaomi/mimo-v2.5",
  "mimo-v2.5-pro": "xiaomi/mimo-v2.5-pro",
};

/**
 * Normalize an incoming model id to the wire form Command Code's provider API
 * accepts. Strips a leading provider prefix (`command-code/` / `cmd/`) that the
 * pipeline may have resolved, then maps known bare ids to their
 * vendor-prefixed form (see above).
 */
function normalizeCommandCodeWireModel(model: string): string {
  const trimmed = String(model || "").trim();
  if (!trimmed) return trimmed;
  const bare = trimmed.replace(/^(?:command-code|cmd)\//, "");
  if (bare.includes("/")) return bare;
  return COMMAND_CODE_BARE_MODEL_VENDOR_PREFIX[bare] ?? bare;
}

/**
 * Build a flat OpenAI chat.completions request body for the official
 * /provider/v1/chat/completions endpoint. The incoming body is already the
 * standard OpenAI chat.completions shape (registry `format: "openai"`), so this
 * is a passthrough that: normalizes the wire model id, forces the stream flag
 * to match the caller's expectation, clamps max_tokens, and lets reasoning /
 * payload-rule passthrough fields flow through untouched. No CLI envelope
 * (config/memory/taste/skills/permissionMode) and no CLI-shaped message
 * conversion here — /provider/v1 is the documented, standard API.
 */
function buildOpenAiBody(
  model: string,
  body: unknown,
  stream: boolean
): { body: JsonRecord } {
  const input = isRecord(body) ? { ...(body as JsonRecord) } : {};

  const resolvedModel = normalizeCommandCodeWireModel(
    typeof input.model === "string" && input.model.trim().length > 0
      ? input.model
      : model
  );

  const out: JsonRecord = {
    ...input,
    model: resolvedModel,
    stream: stream === true,
  };

  // Forward max_tokens only when the client actually supplied a positive value
  // (clamped to the endpoint ceiling). Omitting it lets the provider's upstream
  // apply the model's own native default; a non-positive value such as -1
  // ("let the server choose") must be omitted, NOT coerced to 1 (#5166).
  const maxTokens = clampMaxTokens(input.max_tokens ?? input.max_completion_tokens);
  delete out.max_tokens;
  delete out.max_completion_tokens;
  if (maxTokens !== undefined) {
    out.max_tokens = maxTokens;
  }

  return { body: out };
}

export class CommandCodeExecutor extends BaseExecutor {
  constructor(provider = "command-code") {
    super(provider, REGISTRY["command-code"]);
  }

  buildUrl() {
    const baseUrl = (this.config.baseUrl || "https://api.commandcode.ai").replace(/\/$/, "");
    return `${baseUrl}${this.config.chatPath || "/provider/v1/chat/completions"}`;
  }

  async execute({ model, body, stream, credentials, signal, upstreamExtraHeaders }: ExecuteInput) {
    const apiKey = credentials?.apiKey || credentials?.accessToken;
    if (!apiKey) throw new Error("Command Code API key required");

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      Accept: stream ? "text/event-stream" : "application/json",
    };
    mergeUpstreamExtraHeaders(headers, upstreamExtraHeaders);

    // The combo/single-model dispatch boundary does not always run
    // sanitizeRequestForResolvedTarget before reaching this executor (combo
    // path), and Command Code rejects unsupported reasoning_effort values
    // outright. Sanitize here — the executor is the last line of defense for
    // the wire body.
    const sanitizedBody = sanitizeReasoningEffortForProvider(body, this.provider, model);
    const { body: transformedBody } = buildOpenAiBody(model, sanitizedBody, stream);
    const url = this.buildUrl();
    const upstream = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(transformedBody),
      signal: signal || undefined,
    });

    if (!upstream.ok) {
      const errorText = await upstream.text().catch(() => {
        console.warn("[commandCode] upstream text failed");
        return "";
      });
      return {
        response: new Response(errorText || `Command Code API error ${upstream.status}`, {
          status: upstream.status,
          statusText: upstream.statusText,
          headers: upstream.headers,
        }),
        url,
        headers,
        transformedBody,
      };
    }

    // The /provider/v1/chat/completions endpoint returns standard OpenAI-format
    // SSE (stream) or JSON (non-stream) straight through, so the upstream
    // Response passes through untouched — no AI-SDK/CLI event re-parsing needed.
    return { response: upstream, url, headers, transformedBody };
  }
}