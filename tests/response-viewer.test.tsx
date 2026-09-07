/**
 * The response viewer as a person meets it: which pane a response lands on,
 * what a binary body does, what "Copy raw" copies, and what the status bar
 * says when nothing came back.
 *
 * All of it through the rendered page — the viewer's state lives in the
 * component, so none of this is reachable from a unit test.
 */
import { describe, test, expect, beforeEach, vi, afterEach } from "vitest";
import { render, screen, cleanup, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Home from "@/app/page";
import { useStore } from "@/lib/store";
import type { SignalResponse } from "@/lib/types";

vi.mock("@/lib/transport", () => ({
  registerMock: vi.fn(async () => ({ ok: true, count: 0 })),
  mockUrlFor: vi.fn(async () => undefined),
  sendProxy: vi.fn(async () => ({ status: 200, statusText: "OK", headers: {}, body: "", elapsedMs: 1, sizeBytes: 0 })),
  mockBaseUrl: vi.fn(async () => undefined),
}));

const RESET = {
  collections: {}, collectionOrder: [], environments: {}, globals: [],
  history: [], mocks: {}, tabs: [], activeTabId: undefined, activeEnvId: undefined,
  commandPaletteOpen: false, secrets: [], vaultUnlocked: false, vaultError: undefined,
  runnerCollectionId: undefined,
};
beforeEach(() => { localStorage.clear(); useStore.setState(RESET); cleanup(); });
afterEach(() => vi.unstubAllGlobals());

const resp = (p: Partial<SignalResponse>): SignalResponse => ({
  status: 200, statusText: "OK", headers: {}, body: "", elapsedMs: 5, sizeBytes: 0, ...p,
});

/** Open a tab with a response already in it, and return its tab id. */
function tabWith(url: string, r?: SignalResponse, name?: string): string {
  useStore.getState().openDraft(name ? { url, name } : { url });
  const id = useStore.getState().activeTabId!;
  if (r) useStore.getState().setTabResponse(id, r, [], []);
  return id;
}
/** The pane buttons, found by class so this works against the old markup too
 *  — otherwise a test proves only that role="tab" is new. */
const pane = (name: string): HTMLElement => {
  // Scoped to the response status bar: the request builder above uses the
  // same .tab class for its own params/headers/body tabs.
  const bar = screen.getByText(/^Time:/).parentElement!;
  return Array.from(bar.querySelectorAll<HTMLElement>("button.tab"))
    .find((b) => (b.textContent ?? "").trim().toLowerCase().startsWith(name))!;
};

describe("which pane a response lands on", () => {
  test("a new request's first response shows its body, not the last pane you used", async () => {
    // The viewer was one shared instance, so the pane you last looked at
    // anywhere became the pane a brand new request's first response arrived
    // on: a 500's {"error":"database is down"} replaced by "(no logs)".
    const user = userEvent.setup();
    tabWith("http://a.test/one", resp({ body: "first body" }));
    render(<Home />);
    await user.click(pane("console"));
    expect(screen.getByText("(no logs)")).toBeInTheDocument();

    const second = tabWith("http://a.test/two");
    useStore.getState().setTabResponse(second, resp({
      status: 500, statusText: "Server Error", body: '{"error":"database is down"}',
    }), [], []);
    await waitFor(() => expect(screen.getByText(/database is down/)).toBeInTheDocument());
  }, 20_000);

  test("the pane you chose in one tab does not follow you into another", async () => {
    const user = userEvent.setup();
    tabWith("http://a.test/one", resp({ body: "one" }), "First");
    tabWith("http://a.test/two", resp({ body: "two" }), "Second");
    render(<Home />);
    await user.click(pane("headers"));
    expect(screen.getByRole("table")).toBeInTheDocument();

    await user.click(screen.getByText("First"));
    // The pane is the viewer's own state, and one shared instance carried it
    // across: you landed on this tab's response already switched to headers.
    await waitFor(() => expect(screen.getByText("one")).toBeInTheDocument());
    expect(screen.queryByRole("table")).toBeNull();
  }, 20_000);
});

describe("what the body pane shows is what the server sent", () => {
  test("a bigint id is displayed as the id the server sent", async () => {
    // Pretty is on by default and used to run the body through
    // JSON.stringify(JSON.parse(...)), so every Postgres bigint key and
    // snowflake id on screen was a nearby but DIFFERENT number, with nothing
    // to say it had been rewritten.
    tabWith("http://a.test/x", resp({
      body: '{"id":9007199254740993,"balance":1e400,"price":1.0}',
      contentType: "application/json",
    }));
    render(<Home />);
    const body = screen.getByText(/"id"/).textContent!;
    expect(body).toContain("9007199254740993");
    expect(body).toContain("1e400");
    expect(body).toContain("1.0");
    expect(body).not.toContain("9007199254740992");
    expect(body).not.toContain("null");
  }, 20_000);

  test("an ordinary page full of <img> does not balloon into the DOM", async () => {
    // The depth counter never came back down for a void element, so
    // indentation grew with the NUMBER of them: 162KB in, 61MB out,
    // synchronously, during render.
    const html = "<html><body>" + '<img src="x"><br>'.repeat(2000) + "</body></html>";
    tabWith("http://a.test/gallery", resp({ body: html, contentType: "text/html", sizeBytes: html.length }));
    render(<Home />);
    const shown = document.querySelector("pre")!.textContent!;
    expect(shown.length).toBeLessThan(html.length * 4);
  }, 30_000);
});

describe("a binary response", () => {
  const PNG_B64 = "iVBORw0KGgo=";

  test("is not shown as text until you ask, and asking is per response", async () => {
    // Ticking "show as text" on one PNG used to arm it for every later
    // response: a zip fetched afterwards decoded itself into the DOM with no
    // click, and the box was already ticked so nothing said why.
    const user = userEvent.setup();
    const id = tabWith("http://a.test/png", resp({
      body: PNG_B64, bodyIsBase64: true, contentType: "image/png", sizeBytes: 8,
    }));
    render(<Home />);
    expect(screen.getByText(/Binary response/)).toBeInTheDocument();

    await user.click(screen.getByLabelText(/show as text/i));
    expect(screen.queryByText(/Binary response/)).toBeNull();

    useStore.getState().setTabResponse(id, resp({
      body: "UEsDBBQ=", bodyIsBase64: true, contentType: "application/zip", sizeBytes: 5,
    }), [], []);
    await waitFor(() => expect(screen.getByText(/Binary response/)).toBeInTheDocument());
  }, 20_000);

  test("the toggle does not leak into another tab", async () => {
    const user = userEvent.setup();
    tabWith("http://a.test/one", resp({ body: PNG_B64, bodyIsBase64: true, contentType: "image/png" }), "First");
    tabWith("http://a.test/two", resp({ body: PNG_B64, bodyIsBase64: true, contentType: "image/png" }), "Second");
    render(<Home />);
    await user.click(screen.getByLabelText(/show as text/i));
    expect(screen.queryByText(/Binary response/)).toBeNull();

    await user.click(screen.getByText("First"));
    await waitFor(() => expect(screen.getByText(/Binary response/)).toBeInTheDocument());
  }, 20_000);

  test("a body that is not real base64 does not take the page down", async () => {
    const user = userEvent.setup();
    tabWith("http://a.test/x", resp({ body: "!!!not base64!!!", bodyIsBase64: true, contentType: "image/png" }));
    render(<Home />);
    await user.click(screen.getByRole("button", { name: /^download$/i }));
    // atob throws on this. Unguarded, the click threw out of the handler and
    // the user got no file and nothing at all on screen to say why.
    expect(screen.getByText(/could not be decoded/i)).toBeInTheDocument();
  }, 20_000);
});

describe("Copy raw", () => {
  test("copies what is on screen, and says so when it cannot", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(async (_text: string) => {});
    vi.stubGlobal("navigator", Object.assign(Object.create(Object.getPrototypeOf(navigator)), navigator, {
      clipboard: { writeText },
    }));
    tabWith("http://a.test/x", resp({ body: '{"id":9007199254740993}', contentType: "application/json" }));
    render(<Home />);
    await user.click(screen.getByRole("button", { name: /copy raw/i }));
    // Pretty is on, so what is on screen is the re-indented text — and the id
    // in it is still the id the server sent.
    expect(String(writeText.mock.calls[0]?.[0])).toContain("9007199254740993");
    expect(await screen.findByRole("button", { name: /copied/i })).toBeInTheDocument();
  }, 20_000);

  test("a clipboard that rejects is reported, not swallowed", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("navigator", Object.assign(Object.create(Object.getPrototypeOf(navigator)), navigator, {
      clipboard: { writeText: vi.fn(async () => { throw new Error("denied"); }) },
    }));
    tabWith("http://a.test/x", resp({ body: "hello" }));
    render(<Home />);
    await user.click(screen.getByRole("button", { name: /copy raw/i }));
    // The promise was neither awaited nor caught, so a failed copy looked
    // exactly like a successful one and the user walked away without it.
    expect(await screen.findByRole("button", { name: /copy failed/i })).toBeInTheDocument();
  }, 20_000);
});

describe("the headers pane", () => {
  test("shows one row per header line, repeats included", async () => {
    const user = userEvent.setup();
    tabWith("http://a.test/login", resp({
      headers: { "set-cookie": "session=abc\ncsrf=zzz" },
      headerList: [
        ["content-type", "text/plain"],
        ["set-cookie", "session=abc123; HttpOnly"],
        ["set-cookie", "csrf=zzz999"],
      ],
      body: "ok",
    }));
    render(<Home />);
    await user.click(pane("headers"));
    const table = screen.getByRole("table");
    expect(within(table).getByText("session=abc123; HttpOnly")).toBeInTheDocument();
    expect(within(table).getByText("csrf=zzz999")).toBeInTheDocument();
    expect(within(table).getAllByRole("row")).toHaveLength(3);
  }, 20_000);

  test("the count on the tab matches the rows underneath it", async () => {
    tabWith("http://a.test/x", resp({
      headers: {}, headerList: [["a", "1"], ["a", "2"], ["b", "3"]], body: "ok",
    }));
    render(<Home />);
    expect(pane("headers").textContent).toContain("(3)");
  }, 20_000);
});

describe("the panes are reachable without a mouse", () => {
  test("each one says whether it is the pane you are on", async () => {
    tabWith("http://a.test/x", resp({ body: "hi" }));
    render(<Home />);
    const tabs = within(screen.getByRole("tablist", { name: /response/i })).getAllByRole("tab");
    expect(tabs.map((t) => t.textContent?.trim())).toEqual(["body", "headers", "tests", "console"]);
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
    expect(tabs[1].getAttribute("aria-selected")).toBe("false");
  }, 20_000);
});

describe("when nothing came back", () => {
  test("the reason is readable, not just clipped into the top bar", async () => {
    const long = "fetch failed — ECONNREFUSED: connect ECONNREFUSED 127.0.0.1:9 on http://localhost:9/api/v1/users";
    tabWith("http://localhost:9/x", resp({ status: 0, statusText: "Error", error: long }));
    render(<Home />);
    // The bar clips it to one line, so it has to be somewhere it can be read.
    const shown = screen.getAllByText(long);
    expect(shown.length).toBeGreaterThanOrEqual(2);
    expect(shown.some((n) => n.getAttribute("title") === long)).toBe(true);
  }, 20_000);
});

describe("the size line", () => {
  test("a response one byte under a megabyte does not read as 1024.0 KB", async () => {
    tabWith("http://a.test/x", resp({ body: "x", sizeBytes: 1024 * 1024 - 1 }));
    render(<Home />);
    expect(screen.getByText(/Size:/).textContent).toBe("Size: 1.00 MB");
  }, 20_000);
});

describe("a big response does not break saving forever", () => {
  test("what goes into history is trimmed, and the viewer says it was", async () => {
    // History is persisted. A 32MB body — which the proxy accepts — used to go
    // in whole, so every save from then on threw QuotaExceeded and every
    // collection created afterwards silently vanished on reload.
    const big = "y".repeat(300_000);
    useStore.getState().pushHistory({
      id: "h1", timestamp: 1, request: { id: "r1", name: "big", method: "GET", url: "http://a.test/big",
        headers: [], params: [], body: { mode: "none" }, auth: { type: "none" } } as never,
      response: resp({ body: big, sizeBytes: big.length }),
    });
    const stored = useStore.getState().history[0].response!;
    expect(stored.body.length).toBe(64 * 1024);
    expect(stored.bodyTruncated).toBe(300_000);

    const id = tabWith("http://a.test/big");
    useStore.getState().setTabResponse(id, stored, [], []);
    render(<Home />);
    expect(screen.getByText(/only the first .* was kept/i)).toBeInTheDocument();
  }, 20_000);
});
