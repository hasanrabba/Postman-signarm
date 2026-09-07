/**
 * The command palette and the collection runner as a person meets them: what
 * you can find by typing, what happens to the keyboard while they are open,
 * and where focus goes when they close.
 *
 * Every case here is a UI path. The matching is reachable from a unit test,
 * but the focus behaviour is not — it only exists once something is rendered
 * and Tab is actually pressed.
 */
import { describe, test, expect, beforeEach, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Home from "@/app/page";
import { useStore } from "@/lib/store";

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

async function openPalette() {
  const user = userEvent.setup();
  render(<Home />);
  await screen.findByRole("button", { name: /^mocks$/i });
  await user.keyboard("{Control>}k{/Control}");
  await screen.findByPlaceholderText(/type a command/i);
  return user;
}
const options = () => within(screen.getByRole("listbox")).queryAllByRole("option");
const labels = () => options().map((o) => o.textContent ?? "");

describe("finding a request in the palette", () => {
  test("a trailing space still finds the request", async () => {
    const cid = useStore.getState().createCollection("Orders");
    const root = useStore.getState().collections[cid].rootFolderId;
    useStore.getState().addRequest(cid, root, { name: "Create order", url: "http://a.test/o" });

    const user = await openPalette();
    // You get a trailing space for free from a phone keyboard, from pasting,
    // or just from pausing mid-thought. It used to find nothing at all.
    await user.keyboard("create order ");
    expect(labels().some((l) => l.includes("Create order"))).toBe(true);
  }, 20_000);

  test("two remembered words in the wrong order still find it", async () => {
    const cid = useStore.getState().createCollection("Orders");
    const root = useStore.getState().collections[cid].rootFolderId;
    useStore.getState().addRequest(cid, root, { name: "Create order", url: "http://a.test/o" });

    const user = await openPalette();
    await user.keyboard("order create");
    expect(labels().some((l) => l.includes("Create order"))).toBe(true);
  }, 20_000);

  test("same-named requests in two collections are told apart, and the right one opens", async () => {
    const a = useStore.getState().createCollection("Staging");
    const b = useStore.getState().createCollection("Production");
    const ra = useStore.getState().addRequest(a, useStore.getState().collections[a].rootFolderId,
      { name: "Create order", url: "http://staging.test/orders" });
    const rb = useStore.getState().addRequest(b, useStore.getState().collections[b].rootFolderId,
      { name: "Create order", url: "http://prod.test/orders" });

    const user = await openPalette();
    await user.keyboard("create order");
    const rows = labels().filter((l) => l.includes("Create order"));
    expect(rows).toHaveLength(2);
    // Two identical rows is a coin flip, and the coin decides whether you POST
    // to production.
    expect(new Set(rows).size).toBe(2);

    const prod = options().find((o) => /Production/.test(o.textContent ?? ""))!;
    expect(prod).toBeDefined();
    await user.click(prod);
    const tab = useStore.getState().tabs.at(-1)!;
    expect(tab.requestId).toBe(rb);
    expect(tab.requestId).not.toBe(ra);
    expect(tab.draft.url).toBe("http://prod.test/orders");
  }, 20_000);

  test("a request named only spaces is not a blank row", async () => {
    const cid = useStore.getState().createCollection("Orders");
    const root = useStore.getState().collections[cid].rootFolderId;
    useStore.getState().addRequest(cid, root, { name: "   ", url: "http://a.test/nameless" });

    const user = await openPalette();
    await user.keyboard("nameless");
    const rows = options();
    expect(rows).toHaveLength(1);
    // "Open:" followed by nothing is a row you can click but cannot read.
    expect(rows[0].textContent).toContain("http://a.test/nameless");
  }, 20_000);

  test("matches beyond the cap are counted, not silently dropped", async () => {
    const cid = useStore.getState().createCollection("Big");
    const root = useStore.getState().collections[cid].rootFolderId;
    for (let i = 1; i <= 40; i++) {
      useStore.getState().addRequest(cid, root, { name: `zeta ${i}`, url: `http://a.test/${i}` });
    }

    const user = await openPalette();
    await user.keyboard("zeta");
    expect(options()).toHaveLength(25);
    // Without this line the list looks complete and the other fifteen requests
    // look like they do not exist.
    expect(screen.getByText(/15 more matches not shown/i)).toBeInTheDocument();
  }, 30_000);
});

describe("the palette keeps hold of the keyboard", () => {
  test("Shift+Tab does not escape into the request behind it", async () => {
    const user = await openPalette();
    const input = screen.getByPlaceholderText(/type a command/i);
    expect(document.activeElement).toBe(input);

    const box = input.parentElement!;
    await user.keyboard("{Shift>}{Tab}{/Shift}");
    expect(box.contains(document.activeElement)).toBe(true);

    // The original symptom: whatever you typed next went into a Params field
    // you could not see, and stayed there.
    await user.keyboard("secret");
    expect(document.body.textContent).not.toContain("secret");
  }, 20_000);

  test("Tab forward also stays inside", async () => {
    const cid = useStore.getState().createCollection("Orders");
    const root = useStore.getState().collections[cid].rootFolderId;
    useStore.getState().addRequest(cid, root, { name: "Create order", url: "http://a.test/o" });

    const user = await openPalette();
    const box = screen.getByPlaceholderText(/type a command/i).parentElement!;
    for (let i = 0; i < 40; i++) await user.tab();
    expect(box.contains(document.activeElement)).toBe(true);
  }, 30_000);

  test("closing hands focus back to where it was", async () => {
    const user = userEvent.setup();
    render(<Home />);
    await screen.findByRole("button", { name: /^mocks$/i });
    const url = screen.getByPlaceholderText(/https:\/\//i);
    await user.click(url);
    expect(document.activeElement).toBe(url);

    await user.keyboard("{Control>}k{/Control}");
    await screen.findByPlaceholderText(/type a command/i);
    await user.keyboard("{Escape}");

    // Dropped on the body, the next thing typed goes nowhere and you have to
    // click back into the field you were already in.
    expect(document.activeElement).toBe(url);
  }, 20_000);
});

describe("clicking away from the palette", () => {
  test("a screen reader is told the palette opened", async () => {
    await openPalette();
    const box = screen.getByRole("dialog", { name: /command palette/i });
    expect(box.getAttribute("aria-modal")).toBe("true");
    expect(box.contains(screen.getByPlaceholderText(/type a command/i))).toBe(true);
  }, 20_000);

  test("a drag that ends on the backdrop does not throw the query away", async () => {
    const user = await openPalette();
    await user.keyboard("create");
    const input = screen.getByPlaceholderText(/type a command/i) as HTMLInputElement;
    const backdrop = input.closest("div.fixed")!;

    // Select-all by dragging: press inside the field, release past the edge of
    // the box. The browser reports the click on their common ancestor — the
    // backdrop — so the palette closed and took the query with it.
    fireEvent.mouseDown(input);
    fireEvent.mouseUp(backdrop);
    fireEvent.click(backdrop);

    expect(useStore.getState().commandPaletteOpen).toBe(true);
    expect((screen.getByPlaceholderText(/type a command/i) as HTMLInputElement).value).toBe("create");
  }, 20_000);

  test("pressing on the backdrop itself still closes it", async () => {
    await openPalette();
    const backdrop = screen.getByPlaceholderText(/type a command/i).closest("div.fixed")!;
    fireEvent.mouseDown(backdrop);
    expect(useStore.getState().commandPaletteOpen).toBe(false);
  }, 20_000);
});

describe("the collection runner is a dialog", () => {
  test("Escape closes it", async () => {
    const cid = useStore.getState().createCollection("Suite");
    useStore.getState().openRunner(cid);
    const user = userEvent.setup();
    render(<Home />);
    await screen.findByRole("dialog", { name: /run collection/i });

    await user.keyboard("{Escape}");
    // Every other modal in the app closes on Escape. This one's only exit was
    // a Close button at the far end of a long list of results.
    expect(screen.queryByRole("dialog", { name: /run collection/i })).toBeNull();
    expect(useStore.getState().runnerCollectionId).toBeUndefined();
  }, 20_000);

  test("a screen reader is told it opened", async () => {
    const cid = useStore.getState().createCollection("Suite");
    useStore.getState().openRunner(cid);
    render(<Home />);
    const dialog = await screen.findByRole("dialog", { name: /run collection: suite/i });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
  }, 20_000);
});
