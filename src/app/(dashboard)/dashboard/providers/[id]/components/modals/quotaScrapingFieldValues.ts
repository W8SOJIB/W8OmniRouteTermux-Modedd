/**
 * quotaScrapingFieldValues.ts — form-state shape + persistence rules for the
 * quota-scraping credential fields (cookies / workspace ids) rendered by
 * QuotaScrapingFields.tsx.
 *
 * Kept in a UI-free module on purpose: importing the .tsx pulls in
 * `@/shared/components`, whose barrel reaches untranspiled ESM deps
 * (@lobehub/icons) that the node:test runner cannot parse. Unit tests import
 * this file instead; the component re-exports it for existing callers.
 */

/** Providers whose quota lives behind the Qwen/Model Studio console gateway (#9603). */
export const QWEN_TOKEN_PLAN_PROVIDERS = new Set(["qwen-cloud-token-plan", "bailian-coding-plan"]);

export type QuotaScrapingFieldValues = {
  opencodeGoWorkspaceId: string;
  opencodeGoAuthCookie: string;
  ollamaCloudUsageCookie: string;
  alibabaConsoleCookie: string;
  alibabaConsoleSecToken: string;
  qwenCloudCookie: string;
  qwenCloudSecToken: string;
};

export const EMPTY_QUOTA_SCRAPING_FIELDS: QuotaScrapingFieldValues = {
  opencodeGoWorkspaceId: "",
  opencodeGoAuthCookie: "",
  ollamaCloudUsageCookie: "",
  alibabaConsoleCookie: "",
  alibabaConsoleSecToken: "",
  qwenCloudCookie: "",
  qwenCloudSecToken: "",
};

export function assignQuotaScrapingProviderData(
  provider: string | undefined,
  values: QuotaScrapingFieldValues,
  target: Record<string, unknown>
) {
  if (provider === "opencode-go") {
    target.opencodeGoWorkspaceId = values.opencodeGoWorkspaceId.trim() || undefined;
    if (values.opencodeGoAuthCookie.trim()) {
      target.opencodeGoAuthCookie = values.opencodeGoAuthCookie.trim();
    }
  } else if (provider === "ollama-cloud" && values.ollamaCloudUsageCookie.trim()) {
    target.ollamaCloudUsageCookie = values.ollamaCloudUsageCookie.trim();
  } else if (
    (provider === "alibaba" || provider === "alibaba-cn") &&
    values.alibabaConsoleCookie.trim()
  ) {
    target.alibabaConsoleCookie = values.alibabaConsoleCookie.trim();
    if (values.alibabaConsoleSecToken.trim()) {
      target.alibabaConsoleSecToken = values.alibabaConsoleSecToken.trim();
    }
  } else if (QWEN_TOKEN_PLAN_PROVIDERS.has(provider ?? "") && values.qwenCloudCookie?.trim()) {
    // Optional access: callers (AddApiKeyModal/EditConnectionModal form state, and
    // existing tests) may pass a partial form object without the newer fields —
    // bailian-coding-plan previously matched no branch here at all.
    target.qwenCloudCookie = values.qwenCloudCookie.trim();
    if (values.qwenCloudSecToken?.trim()) {
      target.qwenCloudSecToken = values.qwenCloudSecToken.trim();
    }
  }
}
