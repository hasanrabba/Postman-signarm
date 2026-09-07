/**
 * A command palette is a keyboard feature: you open it, type, and press Enter.
 * This one had no arrow keys and no Enter — the only way to run anything was
 * to take your hands off the keyboard and click.
 */
import { describe, test, expect, beforeEach, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, within } from "@testing-library/react";
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
// Scoped to the palette: the method picker elsewhere on the page is a
// <select>, whose <option>s carry the same role.
const options = () => within(screen.getByRole("listbox")).getAllByRole("option");
const selected = () => options().find((o) => o.getAttribute("aria-selected") === "true");

describe("the palette can be driven from the keyboard", () => {
  test("something is selected as soon as it opens", async () => {
    await openPalette();
    expect(selected()).toBeDefined();
    expect(selected()!.textContent).toContain("New request");
  }, 30_000);

  test("the arrow keys move the selection", async () => {
    const user = await openPalette();
    const first = selected()!.textContent;
    await user.keyboard("{ArrowDown}");
    expect(selected()!.textContent).not.toBe(first);
    await user.keyboard("{ArrowUp}");
    expect(selected()!.textContent).toBe(first);
  }, 30_000);

  test("it does not run off either end", async () => {
    const user = await openPalette();
    await user.keyboard("{ArrowUp}{ArrowUp}{ArrowUp}");
    expect(selected()!.textContent).toContain("New request");
    for (let i = 0; i < 40; i++) await user.keyboard("{ArrowDown}");
    expect(selected()).toBeDefined();
  }, 30_000);

  test("Enter runs the selected command", async () => {
    const user = await openPalette();
    expect(useStore.getState().tabs).toHaveLength(1);   // the starter tab
    await user.keyboard("{Enter}");
    await waitFor(() => expect(useStore.getState().tabs).toHaveLength(2));
    expect(useStore.getState().commandPaletteOpen).toBe(false);
  }, 30_000);

  test("typing narrows the list and the selection follows", async () => {
    const user = await openPalette();
    await user.keyboard("environment");
    expect(options()).toHaveLength(1);
    expect(selected()!.textContent).toContain("New environment");
  }, 30_000);

  test("the selection resets to the top as the query changes", async () => {
    const user = await openPalette();
    await user.keyboard("{ArrowDown}{ArrowDown}");
    await user.keyboard("new");
    expect(selected()!.textContent).toBe(options()[0].textContent);
  }, 30_000);

  test("Enter with no matches does nothing at all", async () => {
    const user = await openPalette();
    await user.keyboard("zzzznotacommand");
    const before = useStore.getState().tabs.length;
    await user.keyboard("{Enter}");
    expect(useStore.getState().tabs).toHaveLength(before);
    expect(useStore.getState().commandPaletteOpen).toBe(true);
  }, 30_000);
});

/* Reopening showed whatever was typed last time, so the first keystroke
   filtered against a query the user could not see the start of. */
describe("the palette opens clean", () => {
  test("a query does not survive being closed and reopened", async () => {
    const user = await openPalette();
    await user.keyboard("environment");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByPlaceholderText(/type a command/i)).toBeNull());

    await user.keyboard("{Control>}k{/Control}");
    const input = await screen.findByPlaceholderText(/type a command/i);
    expect((input as HTMLInputElement).value).toBe("");
  }, 30_000);
});
