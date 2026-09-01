import { describe, expect, test, beforeEach, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Home from "@/app/page";
import { useStore } from "@/lib/store";
import { restoreRedacted, redactRequest } from "@/lib/secrets";
import { emptyRequest } from "@/lib/defaults";

const RESET = {
  collections: {}, collectionOrder: [], environments: {}, globals: [],
  history: [], mocks: {}, tabs: [], activeTabId: undefined,
  activeEnvId: undefined, commandPaletteOpen: false,
};

/** Proxy reply carrying `body`, so test scripts have something to parse. */
function mockProxy(body: unknown) {
  (globalThis as { fetch: unknown }).fetch = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        status: 200, statusText: "OK",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body), elapsedMs: 5, sizeBytes: 20,
        contentType: "application/json",
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    )
  );
}

beforeEach(() => {
  localStorage.clear();
  useStore.setState(RESET);
  cleanup();
});

/* ------------------------------------------------------------------ */
/* 1. Script variable writes must survive a single Send               */
/* ------------------------------------------------------------------ */
describe("script variable writes on a single send", () => {
  async function sendWith(script: string) {
    const s = useStore.getState();
    const cid = s.createCollection("C");
    const col = useStore.getState().collections[cid];
    const rid = s.addRequest(cid, col.rootFolderId, {
      name: "login", method: "GET", url: "https://api.example.com/login",
      testScript: script,
    });
    useStore.getState().openRequest(cid, rid);
    render(<Home />);
    await userEvent.click(screen.getByRole("button", { name: /^send$/i }));
    await waitFor(() =>
      expect(useStore.getState().tabs[0]?.sending).not.toBe(true)
    );
    return { cid };
  }

  test("sg.env.set lands in the active environment", async () => {
    mockProxy({ token: "tok_abc" });
    const eid = useStore.getState().createEnvironment("dev");
    useStore.getState().setActiveEnvironment(eid);
    await sendWith(`sg.env.set("token", sg.response.json().token);`);

    const vars = useStore.getState().environments[eid].variables;
    expect(vars.find((v) => v.key === "token")?.value).toBe("tok_abc");
  });

  test("sg.env.set updates an existing variable in place", async () => {
    mockProxy({ token: "new_value" });
    const eid = useStore.getState().createEnvironment("dev");
    useStore.getState().updateEnvironment(eid, {
      variables: [{ id: "v1", key: "token", value: "stale", enabled: true }],
    });
    useStore.getState().setActiveEnvironment(eid);
    await sendWith(`sg.env.set("token", sg.response.json().token);`);

    const vars = useStore.getState().environments[eid].variables;
    expect(vars.filter((v) => v.key === "token")).toHaveLength(1);
    expect(vars[0].value).toBe("new_value");
  });

  test("sg.globals.set lands in globals", async () => {
    mockProxy({ token: "g1" });
    await sendWith(`sg.globals.set("gk", "gv");`);
    expect(
      useStore.getState().globals.find((v) => v.key === "gk")?.value
    ).toBe("gv");
  });

  test("sg.collection.set lands on the owning collection", async () => {
    mockProxy({ token: "c1" });
    const { cid } = await sendWith(`sg.collection.set("ck", "cv");`);
    expect(
      useStore.getState().collections[cid].variables.find((v) => v.key === "ck")?.value
    ).toBe("cv");
  });

  test("a pre-request write is persisted too", async () => {
    mockProxy({ ok: true });
    const eid = useStore.getState().createEnvironment("dev");
    useStore.getState().setActiveEnvironment(eid);
    const s = useStore.getState();
    const cid = s.createCollection("C");
    const col = useStore.getState().collections[cid];
    const rid = s.addRequest(cid, col.rootFolderId, {
      name: "r", method: "GET", url: "https://api.example.com/x",
      preRequestScript: `sg.env.set("nonce", "n-1");`,
    });
    useStore.getState().openRequest(cid, rid);
    render(<Home />);
    await userEvent.click(screen.getByRole("button", { name: /^send$/i }));
    await waitFor(() =>
      expect(useStore.getState().environments[eid].variables.some((v) => v.key === "nonce")).toBe(true)
    );
  });

  test("env writes with no active environment warn instead of vanishing silently", async () => {
    mockProxy({ token: "t" });
    await sendWith(`sg.env.set("token", "t");`);
    const logs = useStore.getState().tabs[0].logs ?? [];
    expect(logs.join("\n")).toMatch(/no environment is active/i);
  });
});

/* ------------------------------------------------------------------ */
/* 2. History re-open must yield a sendable request                   */
/* ------------------------------------------------------------------ */
describe("restoreRedacted", () => {
  const live = emptyRequest({
    id: "req_1",
    headers: [
      { id: "h1", key: "Authorization", value: "Bearer real-token", enabled: true },
      { id: "h2", key: "X-Trace", value: "abc", enabled: true },
    ],
    params: [{ id: "p1", key: "api_key", value: "real-key", enabled: true }],
    auth: { type: "bearer", bearer: { token: "real-auth" } },
    body: {
      mode: "json", raw: `{"token":"real-body-token","keep":"yes"}`,
      urlencoded: [], formdata: [], graphql: { query: "", variables: "" },
    },
  });

  test("redaction really does mask the values", () => {
    const r = redactRequest(live);
    expect(r.headers[0].value).toBe("[REDACTED]");
    expect(r.params[0].value).toBe("[REDACTED]");
    expect(r.auth.bearer?.token).toBe("[REDACTED]");
    expect(r.body.raw).toContain("[REDACTED]");
  });

  test("restores headers, params, auth and body from the live request", () => {
    const restored = restoreRedacted(redactRequest(live), live);
    expect(restored.headers.find((h) => h.key === "Authorization")?.value).toBe("Bearer real-token");
    expect(restored.params[0].value).toBe("real-key");
    expect(restored.auth.bearer?.token).toBe("real-auth");
    expect(restored.body.raw).toContain(`"token":"real-body-token"`);
    expect(restored.body.raw).not.toContain("[REDACTED]");
  });

  test("leaves non-secret values untouched", () => {
    const restored = restoreRedacted(redactRequest(live), live);
    expect(restored.headers.find((h) => h.key === "X-Trace")?.value).toBe("abc");
    expect(restored.body.raw).toContain(`"keep":"yes"`);
  });

  test("keeps [REDACTED] visible when the source request is gone", () => {
    const restored = restoreRedacted(redactRequest(live), undefined);
    expect(restored.headers[0].value).toBe("[REDACTED]");
  });

  test("does not invent values for keys the source lacks", () => {
    const orphan = emptyRequest({ id: "req_1", headers: [] });
    const restored = restoreRedacted(redactRequest(live), orphan);
    expect(restored.headers.find((h) => h.key === "Authorization")?.value).toBe("[REDACTED]");
  });
});

describe("openFromHistory", () => {
  test("re-opens with working credentials while history stays redacted", async () => {
    mockProxy({ ok: true });
    const s = useStore.getState();
    const cid = s.createCollection("C");
    const col = useStore.getState().collections[cid];
    const rid = s.addRequest(cid, col.rootFolderId, {
      name: "secure", method: "GET", url: "https://api.example.com/x",
      headers: [{ id: "h1", key: "Authorization", value: "Bearer live-token", enabled: true }],
    });
    useStore.getState().openRequest(cid, rid);
    render(<Home />);
    await userEvent.click(screen.getByRole("button", { name: /^send$/i }));
    await waitFor(() => expect(useStore.getState().history.length).toBe(1));

    // Persisted history is still redacted — the security property holds.
    const entry = useStore.getState().history[0];
    expect(
      entry.request.headers.find((h) => h.key === "Authorization")?.value
    ).toBe("[REDACTED]");

    useStore.getState().openFromHistory(entry.id);
    const opened = useStore.getState().tabs.at(-1)!.draft;
    expect(
      opened.headers.find((h) => h.key === "Authorization")?.value
    ).toBe("Bearer live-token");
  });

  test("a deleted source leaves the entry openable but visibly redacted", async () => {
    mockProxy({ ok: true });
    const s = useStore.getState();
    const cid = s.createCollection("C");
    const col = useStore.getState().collections[cid];
    const rid = s.addRequest(cid, col.rootFolderId, {
      name: "gone", method: "GET", url: "https://api.example.com/x",
      headers: [{ id: "h1", key: "Authorization", value: "Bearer live", enabled: true }],
    });
    useStore.getState().openRequest(cid, rid);
    render(<Home />);
    await userEvent.click(screen.getByRole("button", { name: /^send$/i }));
    await waitFor(() => expect(useStore.getState().history.length).toBe(1));

    useStore.getState().deleteRequest(cid, rid);
    const entry = useStore.getState().history[0];
    useStore.getState().openFromHistory(entry.id);
    const opened = useStore.getState().tabs.at(-1)!.draft;
    expect(opened.headers.find((h) => h.key === "Authorization")?.value).toBe("[REDACTED]");
    expect(opened.url).toBe("https://api.example.com/x");
  });
});

/* ------------------------------------------------------------------ */
/* 3. Reverting a collection must reconcile open tabs                 */
/* ------------------------------------------------------------------ */
describe("revertCollection reconciles tabs", () => {
  function setup() {
    const s = useStore.getState();
    const cid = s.createCollection("C");
    const col = useStore.getState().collections[cid];
    const keep = s.addRequest(cid, col.rootFolderId, { name: "keep", url: "https://a.example.com" });
    useStore.getState().commitCollectionVersion(cid, "v1");
    const vid = useStore.getState().collections[cid].versions[0].id;
    return { cid, keep, vid, rootFolderId: col.rootFolderId };
  }

  test("closes tabs for requests the revert removes", () => {
    const { cid, vid, rootFolderId } = setup();
    const added = useStore.getState().addRequest(cid, rootFolderId, { name: "added" });
    useStore.getState().openRequest(cid, added);
    expect(useStore.getState().tabs).toHaveLength(1);

    useStore.getState().revertCollection(cid, vid);

    expect(useStore.getState().collections[cid].requests[added]).toBeUndefined();
    expect(useStore.getState().tabs).toHaveLength(0);
  });

  test("keeps tabs for surviving requests", () => {
    const { cid, keep, vid } = setup();
    useStore.getState().openRequest(cid, keep);
    useStore.getState().revertCollection(cid, vid);
    expect(useStore.getState().tabs).toHaveLength(1);
    expect(useStore.getState().tabs[0].requestId).toBe(keep);
  });

  test("flags a surviving tab dirty when the revert changed it underneath", () => {
    const { cid, keep, vid } = setup();
    useStore.getState().openRequest(cid, keep);
    const tabId = useStore.getState().tabs[0].id;
    // Edit and save, so the stored request now differs from the snapshot.
    useStore.getState().updateDraft(tabId, { url: "https://changed.example.com" });
    useStore.getState().saveTabInPlace(tabId);
    expect(useStore.getState().tabs[0].dirty).toBe(false);

    useStore.getState().revertCollection(cid, vid);

    expect(useStore.getState().collections[cid].requests[keep].url).toBe("https://a.example.com");
    expect(useStore.getState().tabs[0].dirty).toBe(true);
  });

  test("leaves tabs from other collections and unsaved drafts alone", () => {
    const { cid, vid, rootFolderId } = setup();
    const other = useStore.getState().createCollection("Other");
    const oCol = useStore.getState().collections[other];
    const oReq = useStore.getState().addRequest(other, oCol.rootFolderId, { name: "other" });
    useStore.getState().openRequest(other, oReq);
    useStore.getState().openDraft({ name: "scratch" });
    const doomed = useStore.getState().addRequest(cid, rootFolderId, { name: "doomed" });
    useStore.getState().openRequest(cid, doomed);
    expect(useStore.getState().tabs).toHaveLength(3);

    useStore.getState().revertCollection(cid, vid);

    const ids = useStore.getState().tabs.map((t) => t.requestId);
    expect(ids).toContain(oReq);
    expect(ids.some((i) => i.startsWith("draft:"))).toBe(true);
    expect(ids).not.toContain(doomed);
  });
});
