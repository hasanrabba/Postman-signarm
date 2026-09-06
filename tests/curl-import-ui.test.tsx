/**
 * The fixes for -I, -d's Content-Type and query fidelity are all in the import
 * path. This drives the actual "Import cURL" button a user clicks and then
 * sends, because every serious defect in this project escaped a green suite by
 * being tested through the API rather than through the control.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Home from "@/app/page";
import { useStore } from "@/lib/store";

const sent: { method: string; url: string; headers: Record<string, string>; body?: string }[] = [];
vi.mock("@/lib/transport", () => ({
  sendProxy: vi.fn(async (p: never) => {
    sent.push(p);
    return { status: 200, statusText: "OK", headers: {}, body: "{}", elapsedMs: 1, sizeBytes: 2 };
  }),
  registerMock: vi.fn(async () => ({ ok: true })),
  mockBaseUrl: vi.fn(async () => undefined),
}));

const RESET = {
  collections: {}, collectionOrder: [], environments: {}, globals: [],
  history: [], mocks: {}, tabs: [], activeTabId: undefined, activeEnvId: undefined,
  commandPaletteOpen: false, secrets: [], vaultUnlocked: false, vaultError: undefined,
  runnerCollectionId: undefined,
};
beforeEach(() => { localStorage.clear(); useStore.setState(RESET); sent.length = 0; cleanup(); });
afterEach(() => vi.unstubAllGlobals());

/** paste `cmd` into the Import cURL button, then press Send */
async function importAndSend(cmd: string) {
  const user = userEvent.setup();
  useStore.getState().openDraft();
  render(<Home />);

  await user.click(await screen.findByRole("button", { name: /^body$/i }));
  vi.stubGlobal("prompt", () => cmd);
  await user.click(await screen.findByRole("button", { name: /import curl/i }));

  await user.click(await screen.findByRole("button", { name: /^send$/i }));
  await waitFor(() => expect(sent.length).toBeGreaterThan(0), { timeout: 5000 });
  const p = sent.at(-1)!;
  const ct = Object.entries(p.headers).find(([k]) => k.toLowerCase() === "content-type")?.[1];
  return { ...p, contentType: ct };
}

describe("what the Import cURL button actually sends", () => {
  test("-I sends a HEAD", async () => {
    expect((await importAndSend("curl -I http://x.test/a")).method).toBe("HEAD");
  }, 30_000);

  test("-d carries the Content-Type curl would have set", async () => {
    const w = await importAndSend("curl http://x.test/a -d 'a=1&b=2'");
    expect(w.contentType).toBe("application/x-www-form-urlencoded");
    expect(w.body).toBe("a=1&b=2");
  }, 30_000);

  test("a plus in the query is not turned into a literal plus", async () => {
    expect((await importAndSend("curl 'http://x.test/a?q=a+b'")).url)
      .toBe("http://x.test/a?q=a+b");
  }, 30_000);

  test("an ordinary query still lands in the params table", async () => {
    const w = await importAndSend("curl 'http://x.test/a?x=1&y=2'");
    expect(w.url).toBe("http://x.test/a?x=1&y=2");
    expect(useStore.getState().tabs[0].draft.params.map((p) => p.key)).toEqual(["x", "y"]);
  }, 30_000);
});

/** open a saved request, go to the Body tab, and import `cmd` into it */
async function importInto(cmd: string, opts: { collectionVar?: [string, string] } = {}) {
  const user = userEvent.setup();
  const store = useStore.getState();
  const cid = store.createCollection("Team API");
  const root = useStore.getState().collections[cid].rootFolderId;
  const rid = useStore.getState().addRequest(cid, root, {
    name: "Login", method: "POST", url: "https://api.test/login",
    headers: [{ id: "h1", key: "X-Keep", value: "1", enabled: true }],
  });
  if (opts.collectionVar) {
    const [key, value] = opts.collectionVar;
    useStore.setState((s) => ({
      collections: {
        ...s.collections,
        [cid]: { ...s.collections[cid], variables: [{ id: "v1", key, value, enabled: true }] },
      },
    }));
  }
  useStore.getState().openRequest(cid, rid);

  render(<Home />);
  await user.click(await screen.findByRole("button", { name: /^body$/i }));
  vi.stubGlobal("prompt", () => cmd);
  const alerts: string[] = [];
  vi.stubGlobal("alert", (m: string) => { alerts.push(m); });
  await user.click(await screen.findByRole("button", { name: /import curl/i }));
  return { user, cid, rid, alerts };
}

/* A tab's link to its saved request IS the draft's id. Taking the imported one
   detached the tab, so the edit the user thought they had made went into a
   second request instead. */
describe("importing into a saved request", () => {
  test("Save updates that request instead of adding another", async () => {
    const { user, cid, rid } = await importInto("curl -X PUT https://api.test/v2/login -d 'a=1'");

    await user.click(await screen.findByRole("button", { name: /^save$/i }));

    const col = useStore.getState().collections[cid];
    expect(Object.keys(col.requests)).toEqual([rid]);
    expect(col.requests[rid].method).toBe("PUT");
    expect(col.requests[rid].url).toBe("https://api.test/v2/login");
  }, 30_000);

  test("the tab keeps the request's own name", async () => {
    await importInto("curl https://api.test/v2/login");
    expect(useStore.getState().tabs[0].draft.name).toBe("Login");
  }, 30_000);

  test("collection variables still resolve afterwards", async () => {
    const { user } = await importInto(
      "curl https://api.test/x -H 'X-Trace: {{token}}'",
      { collectionVar: ["token", "s3cr3t"] }
    );

    await user.click(await screen.findByRole("button", { name: /^send$/i }));
    await waitFor(() => expect(sent.length).toBeGreaterThan(0), { timeout: 5000 });
    const h = Object.fromEntries(
      Object.entries(sent.at(-1)!.headers).map(([k, v]) => [k.toLowerCase(), v])
    );
    expect(h["x-trace"]).toBe("s3cr3t");
  }, 30_000);
});

/* A half-copied command parses fine but names nowhere to send anything. */
describe("a command with no URL", () => {
  test("does not erase the request you had open", async () => {
    const { alerts } = await importInto("curl -X POST");
    const draft = useStore.getState().tabs[0].draft;
    expect(draft.url).toBe("https://api.test/login");
    expect(draft.headers.map((h) => h.key)).toEqual(["X-Keep"]);
    expect(alerts.join(" ")).toMatch(/no URL/i);
  }, 30_000);
});
