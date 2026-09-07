/**
 * Tabs, as a person meets them: what survives a restart, what closing costs,
 * where you land afterwards, and whether any of it is reachable without a
 * mouse.
 *
 * A tab holds the entire working copy of a request. Everything here is about
 * that copy existing nowhere else.
 */
import { describe, test, expect, beforeEach, vi, afterEach } from "vitest";
import { render, screen, cleanup, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Home from "@/app/page";
import { useStore } from "@/lib/store";
import type { SignalRequest } from "@/lib/types";

const sent: string[] = [];
let deferred: { resolve: (v: unknown) => void } | null = null;
vi.mock("@/lib/transport", () => ({
  registerMock: vi.fn(async () => ({ ok: true, count: 0 })),
  mockUrlFor: vi.fn(async () => undefined),
  mockBaseUrl: vi.fn(async () => undefined),
  sendProxy: vi.fn(async (payload: { url: string }) => {
    sent.push(payload.url);
    return { status: 200, statusText: "OK", headers: {}, body: '{"token":"T-123"}', elapsedMs: 1, sizeBytes: 17 };
  }),
}));

const RESET = {
  collections: {}, collectionOrder: [], environments: {}, globals: [],
  history: [], mocks: {}, tabs: [], activeTabId: undefined, activeEnvId: undefined,
  commandPaletteOpen: false, secrets: [], vaultUnlocked: false, vaultError: undefined,
  runnerCollectionId: undefined,
};
beforeEach(() => { localStorage.clear(); useStore.setState(RESET); sent.length = 0; deferred = null; cleanup(); });
afterEach(() => vi.unstubAllGlobals());

/**
 * The tab strip, found by the "+" button beside it so this works against
 * either markup — request names also appear in the sidebar.
 */
const stripEl = (): HTMLElement =>
  screen.getAllByText("+").find((b) => b.tagName === "BUTTON")!.previousElementSibling as HTMLElement;
/** The clickable element carrying a tab's label, whatever it is made of. */
const tabFor = (label: string): HTMLElement =>
  within(stripEl()).getByText(label).closest<HTMLElement>('[role="tab"], div.group')!;
/** A tab's close control, found by its glyph so this works on either markup. */
const closerFor = (label: string): HTMLElement =>
  within(tabFor(label).parentElement ?? tabFor(label)).getAllByText("\u00d7")[0] as HTMLElement;
const tabButtons = () =>
  Array.from(document.querySelectorAll<HTMLElement>('[role="tablist"] [role="tab"]'));
const S = () => useStore.getState();

/**
 * A restart: the heap is destroyed, the disk is not. Resetting the store
 * writes an empty snapshot through the persist middleware, so the real one has
 * to be put back before rehydrating.
 */
async function restart() {
  const snapshot = localStorage.getItem("signal.state.v1");
  cleanup();
  useStore.setState(RESET);
  if (snapshot !== null) localStorage.setItem("signal.state.v1", snapshot);
  await useStore.persist.rehydrate();
}

/** Open a saved request in a collection and return the ids. */
function saved(name: string, patch: Partial<SignalRequest> = {}) {
  const cid = S().collectionOrder[0] ?? S().createCollection("Suite");
  const root = S().collections[cid].rootFolderId;
  const rid = S().addRequest(cid, root, { name, url: `http://a.test/${name}`, ...patch });
  return { cid, rid };
}

describe("what survives a restart", () => {
  test("the request you were writing is still there", async () => {
    // A tab holds the whole working copy and partialize named six keys, none
    // of them `tabs` — so nothing typed reached disk until Save. History was
    // saved; the work in front of you was not.
    const user = userEvent.setup();
    render(<Home />);
    await screen.findByRole("button", { name: /^mocks$/i });
    const url = screen.getByPlaceholderText(/https:\/\//i);
    await user.clear(url);
    await user.type(url, "http://api.acme.test/v1/orders");

    expect(localStorage.getItem("signal.state.v1")).toContain("api.acme.test/v1/orders");

    await restart();
    expect(S().tabs.map((t) => t.draft.url)).toContain("http://api.acme.test/v1/orders");
    expect(S().activeTabId).toBeDefined();
  }, 30_000);

  test("a bearer token is not written to disk, and comes back from the collection", async () => {
    // The README's posture: history is redacted and the raw request stays in
    // memory. Persisting the tab verbatim would have put live credentials in
    // unencrypted localStorage on every keystroke.
    const { rid } = saved("Login", { auth: { type: "bearer", bearer: { token: "sk-live-abc123" } } });
    S().openRequest(S().collectionOrder[0], rid);
    // Force a write.
    S().updateDraft(S().activeTabId!, { url: "http://a.test/login2" });

    const onDisk = localStorage.getItem("signal.state.v1")!;
    const tabsBlob = JSON.stringify(JSON.parse(onDisk).state.tabs);
    expect(tabsBlob).not.toContain("sk-live-abc123");

    await restart();
    // Restored from the collection, the same way a history replay is.
    const back = S().tabs.find((t) => t.draft.id === rid)!;
    expect(back.draft.url).toBe("http://a.test/login2");
    expect(back.draft.auth.bearer?.token).toBe("sk-live-abc123");
  }, 20_000);

  test("a huge response body does not ride along into storage", async () => {
    const { rid } = saved("Big");
    S().openRequest(S().collectionOrder[0], rid);
    const id = S().activeTabId!;
    S().setTabResponse(id, {
      status: 200, statusText: "OK", headers: {}, body: "z".repeat(200_000),
      elapsedMs: 1, sizeBytes: 200_000,
    }, [], []);
    expect(localStorage.getItem("signal.state.v1")!.length).toBeLessThan(50_000);
  }, 20_000);
});

describe("closing a tab", () => {
  test("unsaved work is not discarded without asking", async () => {
    // The work exists nowhere else — not on disk unredacted, not in history,
    // not in the collection — yet one click on a 10px glyph deleted it. This
    // app asks before deleting a collection, a folder, a request and a secret.
    const user = userEvent.setup();
    const { rid } = saved("Get users");
    S().openRequest(S().collectionOrder[0], rid);
    render(<Home />);
    const url = screen.getByPlaceholderText(/https:\/\//i);
    await user.clear(url);
    await user.type(url, "http://a.test/edited");

    await user.click(closerFor("Get users"));
    expect(await screen.findByText(/has unsaved changes/i)).toBeInTheDocument();
    expect(S().tabs).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: /^cancel$/i }));
    await waitFor(() => expect(S().tabs).toHaveLength(1));
    expect(S().tabs[0].draft.url).toBe("http://a.test/edited");
  }, 30_000);

  test("discarding really does close it", async () => {
    const user = userEvent.setup();
    const { rid } = saved("Get users");
    S().openRequest(S().collectionOrder[0], rid);
    render(<Home />);
    await user.type(screen.getByPlaceholderText(/https:\/\//i), "X");
    await user.click(closerFor("Get users"));
    await user.click(await screen.findByRole("button", { name: /^discard$/i }));
    await waitFor(() => expect(S().tabs).toHaveLength(0));
  }, 30_000);

  test("a clean tab closes on one click, as before", async () => {
    const user = userEvent.setup();
    const { rid } = saved("Get users");
    S().openRequest(S().collectionOrder[0], rid);
    render(<Home />);
    await user.click(closerFor("Get users"));
    await waitFor(() => expect(S().tabs).toHaveLength(0));
  }, 20_000);

  test("closing lands you on the neighbour, not the far end of the strip", async () => {
    // It used to jump to tabs[tabs.length - 1]. With two open you never notice;
    // with forty, closing the fifth threw you to the thirty-ninth.
    const cid = S().createCollection("Suite");
    const root = S().collections[cid].rootFolderId;
    const ids = ["one", "two", "three", "four", "five"].map((n) =>
      S().addRequest(cid, root, { name: n, url: `http://a.test/${n}` })
    );
    for (const rid of ids) S().openRequest(cid, rid);
    const third = S().tabs[2];
    S().setActiveTab(third.id);

    S().closeTab(third.id);
    // "four" slid into the third slot.
    expect(S().tabs.find((t) => t.id === S().activeTabId)!.draft.name).toBe("four");

    // And closing the last tab in the strip falls back to its left neighbour.
    const last = S().tabs.at(-1)!;
    S().setActiveTab(last.id);
    S().closeTab(last.id);
    expect(S().tabs.find((t) => t.id === S().activeTabId)!.draft.name).toBe("four");
  }, 20_000);

  test("closing a background tab does not move you", async () => {
    const cid = S().createCollection("Suite");
    const root = S().collections[cid].rootFolderId;
    const a = S().addRequest(cid, root, { name: "a", url: "http://a.test/a" });
    const b = S().addRequest(cid, root, { name: "b", url: "http://a.test/b" });
    S().openRequest(cid, a);
    S().openRequest(cid, b);
    const active = S().activeTabId;
    S().closeTab(S().tabs[0].id);
    expect(S().activeTabId).toBe(active);
  }, 20_000);
});

describe("reaching tabs without a mouse", () => {
  test("a tab can be focused and activated", async () => {
    // It was a <div onClick> with no tabindex: never in the focus order, so a
    // keyboard user could never switch back to a tab — while the × inside it
    // WAS focusable, so they could close one they could not select.
    const user = userEvent.setup();
    const cid = S().createCollection("Suite");
    const root = S().collections[cid].rootFolderId;
    S().openRequest(cid, S().addRequest(cid, root, { name: "first", url: "http://a.test/1" }));
    S().openRequest(cid, S().addRequest(cid, root, { name: "second", url: "http://a.test/2" }));
    render(<Home />);

    const first = tabFor("first");
    first.focus();
    // A <div onClick> with no tabindex is never in the focus order, so a
    // keyboard user could not select a tab at all — while the \u00d7 inside it
    // WAS focusable, so they could close one they could not switch to.
    expect(document.activeElement).toBe(first);
    await user.keyboard("{Enter}");
    expect(S().tabs.find((t) => t.id === S().activeTabId)!.draft.name).toBe("first");
  }, 20_000);

  test("arrow keys move along the strip", async () => {
    const user = userEvent.setup();
    const cid = S().createCollection("Suite");
    const root = S().collections[cid].rootFolderId;
    for (const n of ["first", "second", "third"]) {
      S().openRequest(cid, S().addRequest(cid, root, { name: n, url: `http://a.test/${n}` }));
    }
    render(<Home />);
    tabFor("third").focus();
    await user.keyboard("{ArrowLeft}");
    expect(S().tabs.find((t) => t.id === S().activeTabId)!.draft.name).toBe("second");
    await user.keyboard("{Home}");
    expect(S().tabs.find((t) => t.id === S().activeTabId)!.draft.name).toBe("first");
  }, 20_000);

  test("Ctrl+2 jumps to the second tab", async () => {
    const user = userEvent.setup();
    const cid = S().createCollection("Suite");
    const root = S().collections[cid].rootFolderId;
    for (const n of ["first", "second"]) {
      S().openRequest(cid, S().addRequest(cid, root, { name: n, url: `http://a.test/${n}` }));
    }
    render(<Home />);
    S().setActiveTab(S().tabs[0].id);
    await user.keyboard("{Control>}2{/Control}");
    expect(S().tabs.find((t) => t.id === S().activeTabId)!.draft.name).toBe("second");
  }, 20_000);

  test("each close button says which request it discards", async () => {
    // Every one was announced as "×", so choosing by ear was a guess about
    // which request you were about to lose.
    const cid = S().createCollection("Suite");
    const root = S().collections[cid].rootFolderId;
    S().openRequest(cid, S().addRequest(cid, root, { name: "Delete account", url: "http://a.test/d" }));
    S().openRequest(cid, S().addRequest(cid, root, { name: "List users", url: "http://a.test/l" }));
    render(<Home />);
    expect(screen.getByRole("button", { name: /close delete account/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /close list users/i })).toBeInTheDocument();
  }, 20_000);

  test("a long name is reachable in full on hover", async () => {
    const long = "Create a purchase order for the EMEA region with line items";
    const cid = S().createCollection("Suite");
    const root = S().collections[cid].rootFolderId;
    S().openRequest(cid, S().addRequest(cid, root, { name: long, url: "http://a.test/x" }));
    render(<Home />);
    // Clipped to 180px in the strip, so hover is the only way to tell two
    // long, similarly-named requests apart.
    expect(tabFor(long).getAttribute("title")).toBe(long);
  }, 20_000);
});

describe("replaying a request from history", () => {
  test("saving the replay does not overwrite the request it came from", async () => {
    // emptyRequest spreads its overrides after the id it generates, so a replay
    // kept the SAVED request's id — and Save, which the replay tab arrives
    // already inviting, wrote the old snapshot over the live request.
    const { cid, rid } = saved("Get users", { url: "http://a.test/users" });
    S().pushHistory({
      id: "h1", timestamp: 1,
      request: { ...S().collections[cid].requests[rid], url: "http://a.test/OLD" },
    });
    S().openFromHistory("h1");
    const tabId = S().activeTabId!;
    expect(S().tabs.find((t) => t.id === tabId)!.draft.id).not.toBe(rid);
    expect(S().saveTabInPlace(tabId)).toBe(false);
    expect(S().collections[cid].requests[rid].url).toBe("http://a.test/users");
  }, 20_000);

  test("the Authorization header the app added on the way out does not come back", async () => {
    // History stores the request as sent, including the Authorization row
    // applyAuth materialised — redacted. restoreRedacted has nothing to match
    // it against, so it returned as a literal "[REDACTED]" row on top of the
    // auth config, and combineHeaders joins same-named headers: every send
    // from the replay went out with `Authorization: [REDACTED], Bearer …`.
    const { cid, rid } = saved("Login", { auth: { type: "bearer", bearer: { token: "T-1" } } });
    const { applyAuth } = await import("@/lib/auth");
    const wire = applyAuth(S().collections[cid].requests[rid]);
    expect(wire.headers.some((h) => h.key === "Authorization")).toBe(true);

    const { redactRequest } = await import("@/lib/secrets");
    S().pushHistory({ id: "h2", timestamp: 1, request: redactRequest(wire) });
    S().openFromHistory("h2");
    const draft = S().tabs.at(-1)!.draft;
    expect(draft.headers.filter((h) => h.key.toLowerCase() === "authorization")).toHaveLength(0);
    expect(JSON.stringify(draft.headers)).not.toContain("REDACTED");
  }, 20_000);
});

describe("tabs versus the rest of the app", () => {
  test("reverting a collection reaches the tab it is open in", async () => {
    // The tab used to keep the pre-revert request and merely gain an
    // unsaved-changes dot — on a tab the user changed nothing in — and the
    // Save that dot invites wrote the reverted-away version straight back.
    const { cid, rid } = saved("Get users", { url: "http://a.test/v1" });
    S().commitCollectionVersion(cid, "before");
    S().openRequest(cid, rid);
    const tabId = S().activeTabId!;
    S().updateDraft(tabId, { url: "http://a.test/v2" });
    S().saveTabInPlace(tabId);
    expect(S().tabs.find((t) => t.id === tabId)!.dirty).toBe(false);

    const version = S().collections[cid].versions[0];
    S().revertCollection(cid, version.id);

    const after = S().tabs.find((t) => t.id === tabId)!;
    expect(after.draft.url).toBe("http://a.test/v1");
    expect(after.dirty).toBe(false);
  }, 20_000);

  test("a run's captured variables survive the run", async () => {
    // Runner threaded script writes through the run — which is why chaining
    // works — then dropped them, so the follow-up request sent from a tab went
    // out with a literal {{tok}} in the URL.
    const user = userEvent.setup();
    const cid = S().createCollection("Suite");
    const root = S().collections[cid].rootFolderId;
    const envId = S().createEnvironment("dev");
    S().setActiveEnvironment(envId);
    S().addRequest(cid, root, {
      name: "login", url: "http://a.test/login",
      testScript: "sg.env.set('tok', sg.response.json().token);",
    });
    S().openRunner(cid);
    render(<Home />);
    await user.click(await screen.findByRole("button", { name: /^run$/i }));

    await waitFor(
      () => expect(S().environments[envId].variables.find((v) => v.key === "tok")?.value).toBe("T-123"),
      { timeout: 5000 }
    );
  }, 30_000);
});

describe("switching environment while a request is in flight", () => {
  test("the token lands in the environment the request was sent against", async () => {
    // applyScriptUpdates ran after the await and read activeEnvId at that
    // moment, so flipping the picker mid-flight wrote the staging token into
    // Production — and the next Production request carried a staging
    // credential with nothing on screen reporting it.
    const staging = S().createEnvironment("Staging");
    const production = S().createEnvironment("Production");
    S().setActiveEnvironment(staging);

    const transport = await import("@/lib/transport");
    const gate = new Promise<void>((res) => { deferred = { resolve: () => res() }; });
    vi.mocked(transport.sendProxy).mockImplementationOnce(async () => {
      await gate;
      return { status: 200, statusText: "OK", headers: {}, body: '{"token":"STAGING-TOK"}', elapsedMs: 1, sizeBytes: 24 };
    });

    const user = userEvent.setup();
    S().openDraft({
      name: "login", url: "http://a.test/login",
      testScript: "sg.env.set('token', sg.response.json().token);",
    });
    render(<Home />);
    await user.click(screen.getByRole("button", { name: /^send$/i }));

    // Mid-flight, the user switches. The reply has not arrived yet.
    S().setActiveEnvironment(production);
    deferred!.resolve(undefined);

    await waitFor(() =>
      expect(S().environments[staging].variables.find((v) => v.key === "token")?.value).toBe("STAGING-TOK")
    );
    expect(S().environments[production].variables.find((v) => v.key === "token")).toBeUndefined();
  }, 30_000);
});
