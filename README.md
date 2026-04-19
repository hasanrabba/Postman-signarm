# Signarm Signal

An API platform for designing, testing, mocking, and documenting APIs. Think of
it as a Postman-alike that you run yourself — local-first, no sign-in, all your
data stays in your browser.

## What Signarm Signal does

Feature parity with Postman's core workflows, plus a few additions.

### Request lifecycle
- **HTTP client** with every common verb (GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS)
- **Body modes**: none, JSON, text, XML, form-urlencoded, form-data (text fields), GraphQL (query + variables)
- **Authentication**: none, Basic, Bearer, API Key (header or query), OAuth 2.0 access token
- **Variables** with `{{name}}` substitution across URL, params, headers, and body
- **Built-in variables**: `{{$timestamp}}`, `{{$isoTimestamp}}`, `{{$randomUUID}}`, `{{$randomInt}}`

### Organization
- **Collections** with nested **folders** and a tree sidebar
- **Environments** (dev/staging/prod style) with one active at a time
- **Globals** that apply everywhere
- **Collection variables** scoped to a collection
- **History** of every sent request (last 200)

### Automation
- **Pre-request scripts** — run JS before the request (set env/globals, sign payloads)
- **Test scripts** with a Jest-style `sg.expect(...)` API
- **Collection runner** that executes every request in order and aggregates test results
- **Code snippets**: cURL, fetch, node-fetch, Python requests, Go net/http, HTTPie

### Integrations
- **cURL import/export** — paste a `curl …` command and get a ready-to-send request
- **Mock server** — register route configs and hit `/api/mock/<mockId>/path` for canned responses

### Extras over Postman
- **Command palette** (⌘/Ctrl+K) — fuzzy-find any request, run common commands
- **Collection version history** — commit snapshots of a collection and revert to any prior version
- **Encrypted secrets vault** — store secrets in AES-GCM-encrypted local storage (pass a passphrase)
- **AI hook** — command palette stub ready to wire to your LLM of choice
- **SSRF-safe proxy** — the server-side proxy refuses loopback, private, and link-local addresses

## Architecture

```
┌─────────────────────────────────────────────────────┐
│ Browser (Next.js app)                               │
│  ├─ Zustand store (persisted to localStorage)       │
│  ├─ Request builder UI                              │
│  ├─ Pre-request / test script sandbox               │
│  └─ fetch → /api/proxy                              │
└──────────┬──────────────────────────────────────────┘
           │ POST { method, url, headers, body }
           ▼
┌─────────────────────────────────────────────────────┐
│ Next.js route /api/proxy (Node runtime)             │
│  ├─ SSRF guard (rejects localhost/private ranges)   │
│  ├─ 30s timeout                                     │
│  └─ fetch the target server → returns body/headers  │
└─────────────────────────────────────────────────────┘
```

Why a proxy? Browser `fetch` can't send arbitrary cross-origin requests thanks
to CORS. The server-side proxy relays the call so Signarm Signal can hit any HTTP API.

## Run it

Signarm Signal ships in two flavors from the same codebase.

### Web (Next.js)

```bash
npm install
npm run dev          # http://localhost:3000
# or for production
npm run build && npm start
```

### Desktop (Tauri, Windows/macOS/Linux)

```bash
npm install
npm run dev:desktop  # hot-reloading desktop window
```

Produce an installer:

```bash
npm run build:desktop
# outputs in src-tauri/target/release/bundle/
```

### Prebuilt Windows binary

For convenience, a cross-compiled Windows build is checked in at `dist/`:

- `dist/SignarmSignal.exe` (~4.6 MB, PE32+)
- `dist/WebView2Loader.dll` (160 KB)

Copy both files together, install the WebView2 runtime if missing, and
double-click `SignarmSignal.exe`. See `dist/README.md` for details and
caveats (MinGW build — MSVC is preferred for Store submission).

In the desktop build, `/api/proxy` and `/api/mock/*` are replaced with native
Rust — `proxy_fetch` runs via `reqwest` (no CORS, no Node required) and the
mock server is an embedded Tokio listener on a random loopback port. A tiny
transport shim (`src/lib/transport.ts`) picks the right backend at runtime.

### Windows prerequisites

On the Windows machine where you run `npm run build:desktop`:

1. **Rust** — install via <https://rustup.rs>; add the MSVC target with
   `rustup default stable-msvc`
2. **Microsoft Visual Studio Build Tools 2022** with the "Desktop development
   with C++" workload (for the MSVC linker)
3. **WebView2 Runtime** — pre-installed on Windows 11, auto-installed by the
   MSI on Windows 10
4. **Node.js 20+**

Build artifacts:

| File | Purpose |
|---|---|
| `src-tauri/target/release/SignarmSignal.exe` | raw executable |
| `src-tauri/target/release/bundle/msi/Signarm Signal_0.1.0_x64_en-US.msi` | Windows Installer |
| `src-tauri/target/release/bundle/nsis/Signarm Signal_0.1.0_x64-setup.exe` | NSIS installer |

## Microsoft Store submission checklist

Pieces shipped in this repo:

- [x] Application code (Tauri + Rust backend)
- [x] `tauri.conf.json` with app identifier, publisher, version, category
- [x] Icons (32/128/256 px PNG + multi-size ICO)
- [x] MSI installer target configured
- [x] CSP and Tauri capability allowlist

Pieces you need to supply before submission:

- [ ] **Partner Center account** (<https://partner.microsoft.com/dashboard>,
      $19 one-time individual fee, $99 company)
- [ ] **Reserved app name** in Partner Center (reserve "Signarm Signal" or your brand)
- [ ] **Publisher display name and CN** — update
      `src-tauri/tauri.conf.json` → `bundle.publisher` and
      `identifier` to match what Partner Center assigns
- [ ] **App icons** — replace the placeholder gradient icons in
      `src-tauri/icons/` with your real brand artwork (include Store logo
      sizes: 50×50, 150×150, 310×310, 310×150)
- [ ] **MSIX package** — the Store prefers MSIX over MSI. Either add
      `"msix"` to `bundle.targets` in `tauri.conf.json` (Tauri v2 bundles
      MSIX when the `wix` tool is available) or wrap the produced MSI with
      the **MSIX Packaging Tool** from the Microsoft Store
- [ ] **Code signing certificate** — Store submissions must be signed.
      Options: Store-issued certificate (simplest; happens automatically on
      upload), EV code signing cert, or SmartScreen-reputable standard cert
- [ ] **Privacy policy URL** — required for any app that handles user data
- [ ] **Age rating** via IARC questionnaire (runs in Partner Center)
- [ ] **Store listing**: description, screenshots (min 1 at 1366×768 or
      larger), feature list, support contact
- [ ] **Windows App Certification Kit pass** — run WACK locally against the
      MSI/MSIX, fix any failures, attach the result to the submission

### Recommended submission flow

1. `npm run build:desktop` on a Windows machine → produces `.msi`
2. Open **MSIX Packaging Tool** → "Create package from installer" → point
   at the MSI → produces `.msix`
3. Run **Windows App Certification Kit** against the MSIX; iterate
4. Sign in to **Partner Center** → Apps and games → New product → MSIX or
   PWA app → upload the package
5. Fill in the listing (description, screenshots, categorization) and
   submit for certification (usually 1–3 business days)

## Source map

```
src/
├─ app/
│  ├─ layout.tsx              ·· root layout
│  ├─ page.tsx                ·· workspace shell
│  ├─ globals.css             ·· Tailwind + theme tokens
│  └─ api/
│     ├─ proxy/route.ts       ·· SSRF-guarded HTTP proxy
│     ├─ mock/[mockId]/…      ·· mock dispatcher
│     └─ mock-config/route.ts ·· register mock routes
├─ components/
│  ├─ Sidebar.tsx             ·· collections, envs, history, mocks
│  ├─ Tabs.tsx                ·· open request tabs
│  ├─ RequestBuilder.tsx      ·· URL bar + params/auth/headers/body/scripts/snippets
│  ├─ ResponseViewer.tsx      ·· body/headers/tests/console
│  ├─ CommandPalette.tsx      ·· ⌘K palette
│  ├─ Runner.tsx              ·· collection runner
│  └─ KVEditor.tsx            ·· shared key/value editor
└─ lib/
   ├─ types.ts                ·· data model
   ├─ store.ts                ·· Zustand state (persisted)
   ├─ variables.ts            ·· {{var}} substitution
   ├─ auth.ts                 ·· auth header/param application
   ├─ scripting.ts            ·· pre/post script runner + sg.* API
   ├─ executor.ts             ·· end-to-end send pipeline
   ├─ curl.ts                 ·· cURL import/export
   ├─ snippets.ts             ·· code generators
   ├─ vault.ts                ·· AES-GCM secret storage
   └─ id.ts                   ·· id helpers
```

## Scripting API

Inside pre-request and test scripts you have a single `sg` object. No `fetch`,
no `window`, no network access.

```js
// test script
sg.test("status is 200", () => sg.expect(sg.response.status).toBe(200));
sg.test("has user id", () => {
  const json = sg.response.json();
  sg.expect(json.id).toBeTruthy();
  sg.env.set("userId", json.id);   // persist across requests
});
```

Matchers: `toBe`, `toEqual`, `toContain`, `toBeTruthy`, `toBeBetween`.
State: `sg.env.{get,set}`, `sg.globals.{get,set}`, `sg.collection.{get,set}`.

## Things deliberately skipped in the MVP

- OAuth 2.0 full authorization-code flow (only static token is wired; grant
  flow needs an auth callback route)
- Binary/file upload in form-data
- WebSocket, gRPC, MQTT transports
- Team collaboration / realtime sync (the storage model supports adding a
  sync backend, but no server is shipped)
- Newman-style CLI (the executor is pure TypeScript and could be lifted out
  into a CLI package)

Contributions welcome.
