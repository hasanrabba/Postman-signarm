# Signal

An API platform for designing, testing, mocking, and documenting APIs. Think of
it as a Postman-alike that you run yourself — local-first, no sign-in, all your
data stays in your browser.

## What Signal does

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
to CORS. The server-side proxy relays the call so Signal can hit any HTTP API.

## Run it

```bash
npm install
npm run dev
# then open http://localhost:3000
```

Build for production:

```bash
npm run build
npm start
```

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
