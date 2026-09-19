/**
 * responsesContinuationStore.ts — OmniRoute-native `previous_response_id`
 * virtualization for the OpenAI Responses API.
 *
 * Exposes `previous_response_id` continuation to clients unconditionally,
 * regardless of whether the actual upstream provider for a connection
 * supports Responses-API state at all: OmniRoute resolves the response id
 * back to the full input/output it produced and reconstructs the full
 * request server-side before forwarding upstream (full history, exactly as
 * today) -- the client only ever has to resend the new delta.
 *
 * Storage: reuses the existing call-log pipeline artifact (full, untruncated
 * request/response payloads, already gated by `call_log_pipeline_enabled`
 * and already retained/cleaned up by the existing call-log lifecycle)
 * instead of duplicating conversation content into a second store. Only a
 * lightweight `call_logs.response_id` index (154_call_logs_response_id.sql)
 * is new. Every lookup is scoped by `api_key_id` -- one client can never
 * resolve another client's stored conversation.
 */

import { getDbInstance } from "./core";
import { readCallArtifact } from "../usage/callLogArtifacts";

export type ResponsesContinuationState = {
  input: unknown[];
  output: unknown[];
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Resolve the full input + output a prior Responses API call produced, so
 * the caller can reconstruct `full_input = stored.input + stored.output +
 * new_delta`. Returns null on any lookup/read/shape failure (unknown id,
 * wrong tenant, artifact missing, or an artifact whose pipeline payload was
 * size-limit-omitted -- see MAX_CALL_LOG_ARTIFACT_BYTES in
 * callLogArtifacts.ts) so the caller can fail closed and ask the client to
 * resend full history, exactly like a real `previous_response_not_found`
 * from OpenAI itself.
 */
export function resolvePreviousResponseState(
  responseId: string,
  apiKeyId: string | null | undefined
): ResponsesContinuationState | null {
  if (!responseId) return null;

  const db = getDbInstance();
  const row = db
    .prepare(
      `SELECT artifact_relpath, api_key_id FROM call_logs
       WHERE response_id = ? AND detail_state = 'ready'
       ORDER BY timestamp DESC LIMIT 1`
    )
    .get(responseId) as { artifact_relpath: string | null; api_key_id: string | null } | undefined;

  if (!row || !row.artifact_relpath) return null;
  // Tenant isolation: a response id is only ever handed back to the API key
  // that created it. A stored row with no api_key_id at all (no-log/legacy)
  // can never be resolved by any key -- fail closed rather than guess.
  if (!apiKeyId || row.api_key_id !== apiKeyId) return null;

  const { artifact, state } = readCallArtifact(row.artifact_relpath);
  if (state !== "ready" || !artifact?.pipeline) return null;

  const providerRequest = artifact.pipeline.providerRequest as { body?: unknown } | undefined;
  const clientResponse = artifact.pipeline.clientResponse as { output?: unknown } | undefined;

  const input = isPlainRecord(providerRequest?.body) ? providerRequest.body.input : undefined;
  const output = clientResponse?.output;
  if (!Array.isArray(input) || !Array.isArray(output)) return null;

  return { input, output };
}
