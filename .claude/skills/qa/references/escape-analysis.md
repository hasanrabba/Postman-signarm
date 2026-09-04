# Escape analysis

Every entry below is a real defect that shipped in this repository past a green
test suite. Each one names the category, the bug, why it got through, and the
probe that catches that whole class.

Use this both as a hunting guide and as a regression list — several of these
have recurred after being fixed once.

## Contents

1. Real typing
2. UI path vs API path
3. Visual rendering
4. Concurrency
5. Property / round-trip
6. Adversarial security
7. State invariants
8. Resource limits
9. Flake detection
10. Clean build

---

## 1. Real typing

**Escaped:** Typing `baseUrl` into the globals editor created seven variables —
measured output was `["b","a","s","e","U","r","l"]`. The same component backs
environment variables and collection variables; the sibling editor backs
headers, query params and urlencoded body fields, and failed the same way.

**Why:** The trailing blank row promoted itself to a real row on the first
keystroke without moving the caret, so every later character landed back in the
re-blanked placeholder. Tests used `fireEvent.change`, which delivers the whole
value in one event and never reproduces it.

**Probe:**

```ts
await userEvent.type(field, "X-Trace-Id");     // not fireEvent.change
expect(rows.map(r => r.key)).toEqual(["X-Trace-Id"]);
```

Any input whose `onChange` writes to a store, and any list with a trailing
"new" row, deserves this probe.

## 2. UI path vs API path

**Escaped:** The vault's value field stored a single character. Typing
`sk-live-9f3a2b` persisted `"b"`, to disk and memory.

**Why:** Twenty vault tests existed and all of them called
`addSecret(name, value)` with the complete string. Not one went through the
field a person types into.

**Probe:** For each store action, ask which control invokes it, then drive that
control. If no test touches the control, that is the finding — write it.

## 3. Visual rendering

**Escaped:** The sidebar panel tabs rendered clipped and overlapping —
`collectionsenvironments` — for three commits. Adding a fifth tab broke a
five-across flex layout at 320px.

**Why:** Nothing ever rendered the app and looked at it. 186 tests passed
throughout.

**Probe:** Chromium and Playwright are available.

```js
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
// screenshot each panel, each tab, both narrow and wide viewports
```

Read the screenshots. Layout bugs are invisible to assertions and obvious to an
eye — check for clipped text, overlap, and controls crowded past legibility.

## 4. Concurrency

**Escaped:** Vault writes destroyed each other. Adding two secrets kept only
the second; two deletes resurrected one; two edits lost a value.

**Why:** Each write read the list, awaited a 310,000-iteration PBKDF2
derivation — hundreds of milliseconds — then wrote the list back. Nothing
tested two operations overlapping.

**Probe:**

```ts
await Promise.all([store.addSecret("a", "1"), store.addSecret("b", "2")]);
expect(store.secrets.map(s => s.name).sort()).toEqual(["a", "b"]);
```

Grep for `await` between a read and a write of the same state. Every hit is a
candidate. Slow crypto widens the window enormously.

## 5. Property / round-trip

**Escaped:** Restoring a redacted history entry gave two `Authorization`
headers the same value. Duplicate header names are legal HTTP.

**Why:** Values were matched through a name-keyed map, so the last one won. All
fixtures used single-valued examples.

**Probe:** Assert the round-trip property rather than one example —
`restore(redact(x)) === x` — over duplicates, empty values, values that equal
the sentinel itself, and values containing the delimiter.

## 6. Adversarial security

**Escaped:** Three SSRF bypasses in a proxy documented as SSRF-safe: a DNS name
resolving to `127.0.0.1`, a redirect from an allowed host to a blocked one, and
the whole of `127.0.0.0/8` beyond `127.0.0.1` itself.

**Why:** The guard was only tested with the obvious inputs it already blocked.

**Probe:** Attack the guard's assumption, not its examples. For an address
guard that means encoded forms (decimal, hex, octal), IPv6 (`[::1]`,
`::ffff:127.0.0.1`, NAT64), trailing dots, DNS names you control, and every
redirect hop. Stand up a real fixture and prove the request either lands or is
refused — do not infer it from reading the guard.

Always include a control: a legitimate public host must still work. A guard
that blocks everything is not secure, it is broken.

## 7. State invariants

**Escaped:** `deleteCollection` left tabs open for requests it had deleted, and
`deleteRequest` left `activeTabId` pointing at a closed tab — so the app showed
"No tab open" while tabs sat visibly in the tab bar.

**Why:** No test asserted cross-slice consistency after a mutation.

**Probe:** After every destructive or restorative action, assert the
invariants: every id referenced still resolves, and anything pointing at
removed state was updated. Delete, revert, and undo paths are where this breaks.

## 8. Resource limits

**Escaped:** Both proxies buffered an entire response with no ceiling; 32MB
passed straight through. The desktop mock server allocated a `Vec` sized by the
caller's `Content-Length` header, so `Content-Length: 99999999999` asked for
100GB.

**Why:** Limits existed for request bodies and nobody checked responses.

**Probe:** Send 100× the expected size. Check every allocation whose size comes
from input. Remember that a loopback listener is reachable from any page in the
user's browser.

## 9. Flake detection

**Escaped:** A test asserted an encrypted blob does not contain the passphrase
`"pw"`. Two characters appear in random base64 about 3.3% of the time —
measured over 2000 blobs — so the suite failed roughly one run in thirty.

**Why:** The suite was only ever run once per change.

**Probe:** Run the full suite five times. Any test that is not deterministic is
a finding. When one fails, measure the rate rather than re-running until green —
a rate tells you the mechanism.

## 10. Clean build

**Escaped:** `npm ci` failed outright from a clean clone (a pinned
`@types/node` below what `vite` required), and the Rust crate had never been
compiled — its first real build failed.

**Why:** No CI, and every local run reused an existing `node_modules`.

**Probe:** `rm -rf node_modules && npm ci`, then lint, typecheck, every suite,
and `cargo check && cargo test` in `src-tauri/`. The Tauri crate needs
`npm run build:static` to have run first — `generate_context!` embeds the
static export and fails without it.

---

## Regression list

Confirm these stay fixed. Each has a test; each escaped once.

- Typing multi-character keys in every key/value editor (`tests/bug-sweep.test.tsx`)
- Vault value field and concurrent vault writes (`tests/vault-concurrency.test.tsx`)
- SSRF: DNS→loopback, redirect hops, `127.0.0.0/8`, IPv6 forms (`tests/ssrf.test.ts`)
- Script variable writes persisting on a single send (`tests/script-updates.test.tsx`)
- History re-open producing a sendable request (`tests/script-updates.test.tsx`)
- Tab reconciliation after delete and revert (`tests/bug-sweep.test.tsx`)
- Prototype keys in variable resolution — `{{toString}}` (`tests/variables.test.ts`)

## Known environment quirks

- `npm run build:static` leaves `.next` without API routes. Running `next start`
  straight afterwards serves 404s for `/api/*`. Re-run `next build` first.
- Google Fonts is blocked here, so pages render in fallback faces. Not a bug.
- The Windows cross-toolchain is absent, so the launcher and installer binaries
  cannot be rebuilt — only compile-checked with placeholder payloads.
