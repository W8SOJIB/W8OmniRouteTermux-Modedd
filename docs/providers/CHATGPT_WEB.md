---
title: "Providers — ChatGPT Web (session credentials via Cookie Editor)"
version: 3.8.50
lastUpdated: 2026-08-08
---

# Providers — ChatGPT Web (Plus/Pro session credentials)

`chatgpt-web` (alias `cgpt-web`, display name **ChatGPT Web (Plus/Pro)**) sends OpenAI-format chat requests through an authenticated `chatgpt.com` browser session. It authenticates with the `__Secure-next-auth.session-token` cookie — **no API key required**.

> **New to Web Cookie providers?**
>
> Read **`docs/getting-started/WEB-COOKIE-GUIDE.md`** for the general setup process, limitations, and troubleshooting before following this provider-specific guide.

---

## 1. What credential does OmniRoute need?

Defined in `src/shared/constants/providers/web-cookie.ts` + `src/shared/providers/webSessionCredentials.ts`:

| Field                      | Value                                                                         |
| -------------------------- | ----------------------------------------------------------------------------- |
| Provider id                | `chatgpt-web`                                                                 |
| Credential name            | `__Secure-next-auth.session-token`                                            |
| Accepts full Cookie header | ✅ yes                                                                        |
| Accepted storage keys      | `cookie`, `sessionToken`, `session-token`, `__Secure-next-auth.session-token` |

Two paste formats both work:

- **Bare value** — just the token contents: `eyJhbGciOi...`
- **Full Cookie header** — `__Secure-next-auth.session-token=eyJhbGciOi...; cf_clearance=...` (preferred — carries rotation/anti-bot cookies the executor needs)

---

## 2. Copy the cookie header with Cookie Editor

Cookie Editor can copy the cookies for the active `chatgpt.com` tab as an HTTP header string.
Always compare the exported value with a live authenticated request as described in section 3.

### 2.1 Install and pin

1. Install **[Cookie-Editor](https://chromewebstore.google.com/detail/cookie-editor/hlkenndednhfkekhgcdicdfddnkalmdm)** (Moustachauve) in Chrome/Edge, or the Firefox equivalent.
2. Pin it to the toolbar if you use it regularly.

### 2.2 Copy the credential

1. Go to **https://chatgpt.com** and make sure you're **signed in with the Plus/Pro account** you want OmniRoute to use.
2. Open a conversation and send at least one message (forces the session token to be live/refreshed).
3. Click the **Cookie Editor** icon to open its side panel for the active tab.
4. Find `__Secure-next-auth.session-token`. If it's split into chunks (`__Secure-next-auth.session-token.0`, `.1`, …), select **all** of them — OmniRoute's `nextAuthCookie.ts` merges rotated chunk families.
5. Click **Copy**, choose **Header string**, and copy the resulting `name=value; name=value` text.

> **If the token is missing:** confirm that you are signed in, send a message to refresh the session, and inspect the live request in section 3.

---

## 3. Verify the required data (before pasting)

The repo's `WEB-COOKIE-GUIDE.md` mandates a live-request check. Do it once per session:

1. With chatgpt.com open, press **F12** → **Network** tab.
2. Refresh the page, then send a chat message.
3. Click the conversation request (e.g. `/backend-api/conversation` or the SSE stream) → **Headers** → **Request Headers** → **Cookie**.
4. Confirm it contains `__Secure-next-auth.session-token=...` — **not** just `cf_clearance` or `__cf_bm`.

The value you copied in step 2.3 must match what the live request sends. If they differ, re-copy from Cookie Editor.

---

## 4. Add / update the credential in OmniRoute

### Dashboard (typical user path)

1. Open the OmniRoute dashboard → **Providers** → **Add Provider**.
2. Search **ChatGPT Web (Plus/Pro)** (id `chatgpt-web`).
3. Paste the copied cookie header into the credential field.
4. Click **Test Connection**.
5. Save.

If requests later return 401 or 403, re-copy the header from a fresh live session. The executor merges `Set-Cookie` rotations while the connection is active, but it cannot recover a credential that is no longer accepted upstream.

### Bulk / session pools (many accounts)

For multiple ChatGPT sessions, use the bulk web-session import or session-pool endpoints:

- `POST /api/providers/bulk-web-session` — import many cookie credentials at once
- `GET /api/session-pools` + `/api/session-pools/[provider]` — pool rotation across accounts

Each credential blob must carry the `__Secure-next-auth.session-token` value under one of the accepted storage keys (`cookie`, `sessionToken`, `session-token`, or the cookie's exact name).

### Renewing when the session expires

Web sessions can stop working after sign-out or server-side rotation. Re-run steps 2.2 through 4 whenever requests start failing with 401/403.

---

## 5. Contributing updates

If you changed the credential contract (new storage key, new cookie name, changed hint) or are filling the docs gap, contribute it:

1. Update `src/shared/providers/webSessionCredentials.ts` (credential name / placeholder / storage keys) or `src/shared/constants/providers/web-cookie.ts` (`authHint`).
2. Update this guide (`docs/providers/CHATGPT_WEB.md`) and the provider table in `docs/getting-started/WEB-COOKIE-GUIDE.md`.
3. Update `.env.example` + `docs/reference/ENVIRONMENT.md` if you touched env vars, then run:
   ```bash
   node scripts/check/check-env-doc-sync.mjs   # must pass
   ```
4. Run the provider/unit tests:
   ```bash
   npm run test:unit
   # targeted: tests/unit/chatgpt-web.test.ts (stealth path)
   ```
5. Follow `CONTRIBUTING.md`, branch from the current active release tip, use a Conventional Commit message, and open the PR against that active release branch.

> ⚠️ **Never commit a real cookie value.** All examples above are placeholders. If a test fixture needs a token, use a fake `eyJhbGciOi...` string.

---

## Troubleshooting

| Symptom                          | Likely cause                                 | Fix                                                       |
| -------------------------------- | -------------------------------------------- | --------------------------------------------------------- |
| Cookie not in Cookie Editor      | Signed out / not HttpOnly-visible            | Sign in; enable HttpOnly display in options               |
| Token missing from live request  | Request is not authenticated                  | Sign in and send a chat message first                     |
| 401 after Test Connection passed | Expired or rotated session                    | Re-copy from a fresh live request                         |
| Chunked token fails              | Only one chunk pasted                        | Select all `__Secure-next-auth.session-token.*` chunks    |

---

## ChatGPT Web (Codex)

`ChatGPT Web (Codex)` is an additional provider. The existing
`ChatGPT Web (Plus/Pro)` provider described above stays unchanged for regular
chats, images, and its existing tool emulation.

### Prerequisites

- a full Cookie header from a signed-in ChatGPT session;
- Chrome or Chromium for npm, systemd, and PM2 installs;
- with the Docker `web` profile, the internal Chromium service from `docker-compose.yml`;
- an OpenAI tunnel and a ChatGPT custom connector for local Codex tools.

The tunnel is only needed for tool turns. `pro` is read-only and does not need a
local tool connector.

### Dashboard setup

1. Open the **ChatGPT Web (Codex)** provider and add a connection.
2. Paste the full ChatGPT cookie, the tunnel ID, the runtime key, and the name of
   the custom connector.
3. Start the check. OmniRoute opens a headless Temporary Chat and also detects
   whether `pro` is available for the account.
4. Save the connection. OmniRoute replaces the pasted cookie with the verified
   Playwright storage state and stores it together with the runtime key through
   the encrypted credential abstraction.

The raw cookie is not retained after a successful save. When the session expires,
open the connection, paste a fresh full cookie, and re-run the check. The doctor
status in the edit dialog reports browser, storage state, sign-in, Temporary
Chat, tunnel, connector, and tool round-trip separately.

### Models and combos

The fixed models are:

- `chatgpt-web-codex/instant`
- `chatgpt-web-codex/medium`
- `chatgpt-web-codex/high`
- `chatgpt-web-codex/extra-high`
- `chatgpt-web-codex/pro`

Add one of them to a combo like any other model. The Codex app sends only the
combo name as `model` to the regular Responses endpoint `/v1/responses`. There is
no special endpoint and no Codex-mode switch.

`pro` does not run local tools. A forced tool makes that combo target
incompatible; with optional tools the turn runs read-only and reports that
limitation as commentary.

### Security model

- The native path requires a Responses request, a recognized Codex client, and
  matching thread and turn identities.
- Workspace, sandbox, approval policy, and the tool catalog come from the native
  Codex shell. Free-form prompt text is not an authority for them.
- ChatGPT receives only a short-lived capability per turn. The MCP broker accepts
  only tools that Codex offered in exactly that turn.
- Auto-confirming "Allow once" only returns the tool request to Codex. Codex
  alone decides on approval and execution.
- Before the first output, the combo may fall back to another compatible target.
  After that, provider, model, connection, and browser turn stay pinned until the
  turn completes.
- Cookies, runtime keys, storage state, and capability tokens do not appear in
  provider responses or request logs.

### Headless VPS and Docker

For npm, systemd, and PM2 installs, OmniRoute detects common Chrome and Chromium
paths. Alternatively, set `CHATGPT_WEB_CODEX_CHROME_PATH`.

The Docker `web` profile starts `chatgpt-web-codex-browser` on the internal
Compose network. Its CDP port is not published on the host. The protected profile
volume stays separate from the OmniRoute data volume, and the browser gets enough
shared memory. The internal CDP proxy listens only on the Compose network on port
`9223`; Chrome itself stays bound to loopback inside the sidecar.

A supervisor lease under `DATA_DIR` prevents multiple OmniRoute processes from
owning the same tunnel and broker state. A conflict shows up in the doctor.

### Interactive recovery

The normal path is fully headless. When ChatGPT demands an interactive sign-in or
challenge, the existing VNC browser infrastructure can be used as a recovery
path. Browser UI and CDP must then only be reachable over loopback, an
authenticated management connection, or an SSH tunnel; noVNC stays disabled in
normal operation.

### WebSocket fallback

When a combo contains `ChatGPT Web (Codex)`, the Responses WebSocket bridge
requests the HTTP/SSE fallback before connecting upstream. The actual transfer
then goes through `/v1/responses`.
