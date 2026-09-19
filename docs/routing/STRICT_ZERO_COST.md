---
title: "STRICT_ZERO_COST"
version: 3.8.50
lastUpdated: 2026-08-20
---

# STRICT_ZERO_COST

> Opt-in, off by default (`settings.freeAccessPolicy !== "strict"` leaves every `auto/*`
> candidate pool byte-identical). A stricter sibling of `hidePaidModels`
> (`open-sse/services/autoCombo/paidModelFilter.ts`, #6512) for operators who need a hard
> guarantee against ANY incremental monetary spend, not just "documented as free".

## Why this exists, and why `hidePaidModels` alone isn't enough

`hidePaidModels` answers "is this model classified free in `FREE_MODEL_BUDGETS` right now?" —
a point-in-time catalog fact, checked via `isFreeModel()`/`providerHasFreeModels()`
(`src/shared/utils/freeModels.ts`). It says nothing about two real risks:

1. A `recurring-*`/`one-time-initial` free tier's allowance can be **exhausted** — the catalog
   still lists the model as free, but the account behind it has no headroom left.
2. Exceeding a free tier is not always a hard stop. Some providers document explicitly that no
   payment method can ever be attached ("no credit card required"); others don't say, and a
   handful bill automatically past the free allowance.

`hidePaidModels` cannot distinguish these — it was never meant to. STRICT_ZERO_COST adds exactly
these two checks, evaluated per candidate, **before** category/tier ranking and **before**
dispatch — never after a request has already gone out.

## Candidate classification

For every candidate in the pool (`open-sse/services/autoCombo/virtualFactory.ts::buildPreparedPool`,
right after `filterPaidOnlyCandidates`):

1. **Not in `FREE_MODEL_BUDGETS` at all** → excluded. This covers genuinely paid models and any
   provider/model OmniRoute hasn't classified yet — new candidates start excluded, not included.
2. **`freeType: "keyless"`** → passes immediately, **but only for a candidate that genuinely
   arrived via the no-auth path** (`connectionId === SYNTHETIC_NOAUTH_CONNECTION_ID`,
   `open-sse/services/autoCombo/resilienceCandidateFilter.ts`). No credential exists for that
   candidate, so no request against it can ever be billed — no runtime check is needed or
   possible. The same catalogued `keyless` provider/model reached through a **real** DB
   connection (`connectionId` is an actual connection id, or the candidate carries
   `allowedConnectionIds`) does **not** get this shortcut — `keyless` metadata describes the
   no-auth path specifically, not the provider in general, and never authorizes a real,
   credentialed account. Such a candidate falls through to check 3 like any other, where it is
   excluded unless the catalog entry separately carries `hardStopGuaranteed: true` (real
   `keyless` entries never do — the shortcut was their only path to safety).
3. **Any other `freeType`** (`recurring-daily`, `recurring-monthly`, `recurring-credit`,
   `recurring-uncapped`, `one-time-initial`, and any future type this module doesn't
   special-case) → passes only if **all** of the following hold:
   - `hardStopGuaranteed: true` is set on the catalog entry (`FreeModelBudget.hardStopGuaranteed`,
     `open-sse/config/freeModelCatalog.ts`) — a **curated, hand-set fact** about the provider's
     own published terms (e.g. an explicit "no credit card required" claim), never derived from
     `freeType` or from a live API response. Unset (`undefined`) and `false` are both treated as
     "not guaranteed".
   - A usage adapter exists for the provider in `USAGE_FETCHER_PROVIDERS`
     (`open-sse/services/usage.ts`) — the same registry that already backs the quota dashboard and
     `getUsageForProvider()`. No adapter → excluded, permanently, until one is added.
   - The live, cached `FreeAccessState` for **the specific connection actually being
     evaluated** is `status: "SAFE"`, was checked within
     `settings.autoRefreshProviderQuotaInterval` (default 180s — the existing setting, not a new
     number), and reports `remainingFreeAllowance` above a small safety margin.
4. **`freeType: "discontinued"`** → always excluded.

## Connection safety (per-connection verification, never per-candidate)

A candidate in the auto-combo pool is not always tied to one connection. A "logical" candidate
(`connectionId: null`) carries an `allowedConnectionIds` allowlist — one or more actual
provider connections/accounts any of which could serve the request — and the account actually
used is decided later, at dispatch time, by `open-sse/services/combo/autoStrategy.ts`
(intersecting `allowedConnectionIds` against its own connection-selection logic, ~line 315-331).

STRICT_ZERO_COST verifies the free-access state of **each connection in that allowlist
individually** (`evaluateCandidateConnections()` in `strictZeroCostFilter.ts`) and rewrites
`allowedConnectionIds` down to exactly the subset that came back `SAFE` — never the full
original list, and never a single arbitrarily-chosen member. Concretely:

- Account A `SAFE`, account B `UNKNOWN`/exhausted/billable → only A remains selectable.
- All accounts `UNKNOWN` → the candidate is dropped entirely (empty safe set).
- A single-connection candidate (`connectionId` set directly, no allowlist) that fails is
  dropped outright, never returned with an empty `allowedConnectionIds`.

Because `autoStrategy.ts` already enforces `allowedConnectionIds` as a hard allowlist before
selecting a connection to dispatch to, rewriting it to the verified-SAFE subset is sufficient to
guarantee the connection actually used at dispatch is always one this filter itself verified —
never a different, unverified account on the same candidate. See
`tests/unit/autoCombo/strict-zero-cost-connection-safety.test.ts` for the regression proof
(keyless-bypass cases A/B/C, multi-account cases 1-5).

`discovered automatically`: a provider/model shipped tomorrow with the right metadata (in the
catalog, with a usage adapter, `hardStopGuaranteed: true`) is usable the moment OmniRoute knows
about it — no code change, no whitelist entry, nothing to edit in this module. One removed from
the catalog disappears the same way. See
`tests/unit/autoCombo/strict-zero-cost-autodiscovery.test.ts` for the regression proof (via
injectable fixtures, not by mutating the real catalog).

## Quota caching (`open-sse/services/autoCombo/freeAccessQuota.ts`)

Reuses `getUsageForProvider()` — no second quota system. A short, in-memory,
process-lifetime cache sits in front of it (TTL equal to the default
`autoRefreshProviderQuotaInterval`) so a Telegram-scale request rate never triggers a live
billing-API call per candidate per request. Reads are synchronous: a cache miss returns
`undefined` (→ excluded, fail-closed) and kicks off a background refresh for the _next_ read —
nothing in the candidate-pool build path ever awaits a network call.

`invalidateFreeAccessState(provider, connectionId)` is called from
`src/sse/services/auth.ts::markAccountUnavailable()` the moment a connection fails for any
reason, so the very next pool build reads a clean cache miss instead of a stale `SAFE` entry —
no waiting out the TTL after a 402/403/quota-exhausted response.

## ToS guard (independent of economic safety)

`excludeTosAvoid` (default `false`) drops any candidate whose curated `tos` verdict
(`FreeModelBudget.tos`) is `"avoid"` — reuses the same field `hidePaidModels`'s sibling docs
(`docs/reference/FREE_TIERS.md`) already populate. Deliberately separate from
`freeAccessPolicy`: a candidate can be economically `SAFE` and still excluded here for
contractual reasons, or left in when this guard is off even with `freeAccessPolicy: "strict"` on.

## What passes today

Run `npx tsx scripts/ad-hoc/dry-run-strict-zero-cost.ts` against a live instance's
`GET /v1/auto-combo/{channel}/candidates` output for a real before/after — the script now reads
each candidate's real `connectionId`, so it also proves the connection-safety fix live, not just
in unit tests. As of 2026-08-20, only `freeType: "keyless"` candidates pass in practice (7 of 29
live candidates on this instance: `opencode/big-pickle`, `opencode/deepseek-v4-flash-free`, and
5 `felo-web` models — all confirmed arriving with the genuine no-auth `connectionId`, never a
real connection) — no currently-catalogued `recurring-*` provider both has a usage adapter
registered in `USAGE_FETCHER_PROVIDERS` **and** `hardStopGuaranteed: true` declared (e.g. `groq`
has neither the adapter registered here nor is fetched offline in this dry run; `kiro` lacks
`hardStopGuaranteed`). This is not a bug: it's the honest state of two independently-curated
metadata sets that happen not to overlap yet, not a limitation of the filter itself.

With `excludeTosAvoid: true` added on top of the same live pool, the count drops from 7 to 0 —
every one of the 7 surviving candidates is curated `tos: "avoid"` today (`felo-web`, `opencode`).
This is a real, expected trade-off of turning the ToS guard on, not a bug: the guard is
`false` by default for exactly this reason (see "ToS guard" above).

## Enabling

```json
PUT /api/settings
{ "freeAccessPolicy": "strict", "excludeTosAvoid": false }
```

Both new settings default to their pre-feature values (`"off"` / `false`) — enabling neither
changes any existing `auto/*` routing behavior.
