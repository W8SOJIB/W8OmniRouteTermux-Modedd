---
title: "Admission lanes — two lane systems, what gates each, where each reports"
status: active
lastUpdated: 2026-08-10
---

# Admission lanes (#9654) — two lane systems, what gates each, where each reports

OmniRoute has **two** process-local lane systems with different scopes. They are
complementary; operators should know which one they are looking at.

## 1. Byte-level per-connection lanes (`chatBodyAdmission.ts`)

- **Scope:** the buffered-body/heap path for `POST /v1/chat/completions`. Guards
  against heap amplification from large coding-agent bodies (#4380).
- **Gate:** **always on.** Each distinct API key (hashed) — or `anonymous` — gets its
  own lane with `CHAT_MAX_HEAVY_IN_FLIGHT` capacity, so one session's burst cannot
  starve another session's heavyweight slot.
- **Tuning:**
  - `OMNIROUTE_CHAT_VIRTUAL_TTL_MS` — idle-lane eviction (default 60000)
  - `OMNIROUTE_CHAT_VIRTUAL_MAX_SESSIONS` — lane count cap (default 64)
  - `OMNIROUTE_CHAT_ADMISSION_QUEUE_MS` — queue-wait before 503 (default 2000)
  - `OMNIROUTE_CHAT_ADMISSION_MAX_QUEUED_BYTES` — queued-bytes heap valve (default 4 MB)
- **Reports:** not in `GET /api/monitoring/health` today; observable via
  `PerConnectionAdmissionController.snapshot()` (sessionId hash, activeHeavy, idleMs).

## 2. Adaptive runtime virtual lanes (`open-sse/services/admission`)

- **Scope:** tenant-key admission for provider dispatch — queue cost, latency-guided
  limit adaptation, lane queueing, and lane metrics.
- **Gate:** **opt-in.** Disabled unless `OMNIROUTE_CHAT_VIRTUAL_LANES=true`. Without it,
  the adaptive controller keeps the shared queue behavior (criterion 1 of #9654 only
  holds once an operator enables lanes).
- **Tuning:** `OMNIROUTE_CHAT_VIRTUAL_LANES` + adaptive config (`maxQueueCount`,
  `maxQueueCost`, `defaultMaxWaitMs`, …).
- **Reports:** `GET /api/monitoring/health` → `adaptiveAdmission` → `laneCount`,
  `laneQueuedCount`, `laneQueuedCost`, `laneTenants` (opaque lane IDs, never raw
  keys), and `virtualLanes` — the authoritative "lanes are on" flag in the snapshot.

## 3. Fan-out probes — per-target admission for combo/fusion (#9654 Wave 2)

Combo (priority / round-robin) and fusion fan out N model targets under one parent
request. Since #9654 Wave 2, **each fan-out target is gated before dispatch** by a
per-target probe (`PerTargetAdmissionHook`, built by `createPerTargetAdmissionHook`)
against the **parent's** tenant lane.

- **Scope:** every fan-out target dispatched by combo, fusion, and the chaos engine.
  System 1 (byte-level) is unaffected — it never probes fan-out targets.
- **Gate:** **opt-in with system 2.** A no-op when `OMNIROUTE_CHAT_VIRTUAL_LANES`
  is unset — the parent request already holds the shared-queue lease in that mode,
  so probing would double-count and reject combo targets.
- **Semantics:**
  - **Strictly non-blocking — skip, never queue.** `maxWaitMs 0`: a full lane
    skips the target and the combo's fallback machinery (or fusion's survivor
    panel) serves instead. This is deliberate: a fan-out target is redundant
    work, and queueing it piles more load onto the exact congestion lanes exist
    to stop. `defaultMaxWaitMs` therefore applies to the **parent request only**;
    fan-out probes never wait, and there is intentionally **no knob** to make
    them wait (issue history shows wait knobs produced the mass-502/504 class
    #9654 prevents — revisit only if an operator reports skipped fan-out targets
    hurting response quality).
  - **Release-on-admit.** An admitted probe releases its lease immediately: it is
    a capacity gate, not a hold. The parent's lease covers the fan-out; holding N
    more would inflate shared active cost and reject other tenants. Best-effort,
    not a reservation: the lane can refill between probe and dispatch, so under
    heavy contention the gate may admit into a lane that is full again by the
    time the target dispatches.
  - **Priced from the real fan-out body.** The probe estimates cost from the
    target's actual body — including the request class derived from its `stream`
    flag, exactly like the parent path — so fusion panel members (`stream: false`)
    are priced at the non-streaming class they will truly occupy, and priority/RR
    targets at whatever the user requested.
- **Reports:** a probe skip after the first target bumps combo's per-request
  `fallbackCount` (mirroring the existing fallback semantics; visible in combo
  logs); fusion returns 503 when every panel member is skipped. There is
  **no aggregate counter** (e.g. `virtualFanoutSkipped`) on the snapshot today —
  if an operator reports they cannot tell how often the lane gate skips fan-out
  targets, that is the trigger to add one.

## Which one is showing in a dashboard

- `adaptiveAdmission.laneCount` / `laneTenants` → **adaptive virtual lanes** (system 2).
- `adaptiveAdmission.virtualLanes === true` → the fan-out probes of section 3 are
  also active. A payload with `virtualLanes` missing or `false` means
  `OMNIROUTE_CHAT_VIRTUAL_LANES` is unset — the byte-level lanes (system 1) are
  still active, but nothing under `adaptiveAdmission` (and no fan-out gating) is
  in effect until it is enabled.

## Why both exist

The byte-level lanes bound the memory-heavy parse/compress path; the adaptive lanes
bound dispatch cost per tenant. #9654's criterion 1 ("one session's burst does not 503
another") is enforced by system 1 unconditionally and by system 2 once opt-in is enabled.
