/**
 * ⌘S and ⌘Enter belong to the request underneath, so they have to stay out of
 * the way of anything over it: ⌘Enter typed at the open palette used to send a
 * request nobody asked for, and with a confirm dialog up it both sent the
 * request and answered the dialog.
 */
import { describe, test, expect, beforeEach, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Home from "@/app/page";
import { useStore } from "@/lib/store";

const sendProxy = vi.fn(async (_p: unknown) => ({
  status: 200, statusText: "OK", headers: {}, body: "", elapsedMs: 1, sizeBytes: 0,
}));
vi.mock("@/lib/transport", () => ({
  registerMock: vi.fn(async () => ({ ok: true, count: 0 })),
  mockUrlFor: vi.fn(async () => undefined),
  sendProxy: (p: unknown) => sendProxy(p),
  mockBaseUrl: vi.fn(async () => undefined),
}));

const RESET = {
  collections: {}, collectionOrder: [], environments: {}, globals: [],
  history: [], mocks: {}, tabs: [], activeTabId: undefined, activeEnvId: undefined,
  commandPaletteOpen: false, secrets: [], vaultUnlocked: false, vaultError: undefined,
  runnerCollectionId: undefined,
};
beforeEach(() => { localStorage.clear(); useStore.setState(RESET); sendProxy.mockClear(); cleanup(); });

const settle = () => new Promise((r) => setTimeout(r, 150));

describe("send and save do not fire through a modal", () => {
  test("the palette swallows ⌘Enter", async () => {
    const user = userEvent.setup();
    render(<Home />);
    await screen.findByRole("button", { name: /^mocks$/i });
    await user.keyboard("{Control>}k{/Control}");
    await screen.findByPlaceholderText(/type a command/i);

    await user.keyboard("{Control>}{Enter}{/Control}");
    await settle();
    expect(sendProxy).not.toHaveBeenCalled();
  }, 30_000);

  test("and gives it back once closed", async () => {
    const user = userEvent.setup();
    render(<Home />);
    await screen.findByRole("button", { name: /^mocks$/i });
    await user.keyboard("{Control>}k{/Control}");
    await screen.findByPlaceholderText(/type a command/i);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByPlaceholderText(/type a command/i)).toBeNull());

    await user.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() => expect(sendProxy).toHaveBeenCalledTimes(1));
  }, 30_000);

  test("a confirm dialog swallows it too, and is not answered by it", async () => {
    const user = userEvent.setup();
    useStore.getState().createMock("Billing");
    render(<Home />);
    await user.click(await screen.findByRole("button", { name: /^mocks$/i }));
    await user.click(screen.getByRole("button", { name: /Delete mock server Billing/i }));
    await screen.findByRole("button", { name: /^delete$/i });

    await user.keyboard("{Control>}{Enter}{/Control}");
    await settle();
    expect(sendProxy).not.toHaveBeenCalled();
    // ⌘Enter is the send gesture, not an answer to this dialog.
    expect(Object.keys(useStore.getState().mocks)).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /^delete$/i })).not.toBeNull();
  }, 30_000);

  test("the collection runner swallows it as well", async () => {
    const user = userEvent.setup();
    const cid = useStore.getState().createCollection("C");
    useStore.getState().openRunner(cid);
    render(<Home />);
    await screen.findByRole("button", { name: /^run$/i });

    await user.keyboard("{Control>}{Enter}{/Control}");
    await settle();
    expect(sendProxy).not.toHaveBeenCalled();
  }, 30_000);

  test("plain Enter still answers a confirm (control)", async () => {
    const user = userEvent.setup();
    useStore.getState().createMock("Billing");
    render(<Home />);
    await user.click(await screen.findByRole("button", { name: /^mocks$/i }));
    await user.click(screen.getByRole("button", { name: /Delete mock server Billing/i }));
    await screen.findByRole("button", { name: /^delete$/i });

    await user.keyboard("{Enter}");
    await waitFor(() => expect(Object.keys(useStore.getState().mocks)).toHaveLength(0));
  }, 30_000);
});

/* The Send button computes a disabled state; the shortcut computed nothing. */
describe("the send shortcut honours the button's own guard", () => {
  const slow = () => sendProxy.mockImplementation(async () => {
    await new Promise((r) => setTimeout(r, 400));
    return { status: 200, statusText: "OK", headers: {}, body: "", elapsedMs: 1, sizeBytes: 0 };
  });

  test("a second press while one is in flight does not send again", async () => {
    const user = userEvent.setup();
    slow();
    useStore.getState().openDraft({ name: "R", url: "https://x.test/a" });
    render(<Home />);
    await screen.findByRole("button", { name: /^mocks$/i });

    await user.keyboard("{Control>}{Enter}{/Control}");
    await user.keyboard("{Control>}{Enter}{/Control}");
    await new Promise((r) => setTimeout(r, 700));
    // Twice for a POST means the operation happened twice.
    expect(sendProxy).toHaveBeenCalledTimes(1);
  }, 30_000);

  test("an empty URL fires nothing, as the button refuses to", async () => {
    const user = userEvent.setup();
    useStore.getState().openDraft({ name: "R", url: "" });
    render(<Home />);
    await screen.findByRole("button", { name: /^mocks$/i });

    await user.keyboard("{Control>}{Enter}{/Control}");
    await new Promise((r) => setTimeout(r, 200));
    expect(sendProxy).not.toHaveBeenCalled();
  }, 30_000);

  test("a URL of only spaces counts as empty", async () => {
    const user = userEvent.setup();
    useStore.getState().openDraft({ name: "R", url: "   " });
    render(<Home />);
    await screen.findByRole("button", { name: /^mocks$/i });
    await user.keyboard("{Control>}{Enter}{/Control}");
    await new Promise((r) => setTimeout(r, 200));
    expect(sendProxy).not.toHaveBeenCalled();
  }, 30_000);
});

/* Autorepeat, AltGr, and opening a palette nobody can see. */
describe("the global shortcuts are not trigger-happy", () => {
  test("holding the key does not open tab after tab", async () => {
    const user = userEvent.setup();
    render(<Home />);
    await screen.findByRole("button", { name: /^mocks$/i });
    await user.keyboard("{Control>}n{/Control}");
    const after = useStore.getState().tabs.length;

    for (let i = 0; i < 4; i++) {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "n", ctrlKey: true, repeat: true, bubbles: true }));
    }
    await new Promise((r) => setTimeout(r, 100));
    expect(useStore.getState().tabs).toHaveLength(after);
  }, 30_000);

  test("AltGr, which reports as ctrl+alt, is not a shortcut", async () => {
    render(<Home />);
    await screen.findByRole("button", { name: /^mocks$/i });
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, altKey: true, bubbles: true }));
    await new Promise((r) => setTimeout(r, 50));
    expect(useStore.getState().commandPaletteOpen).toBe(false);
  }, 30_000);

  test("the palette opens ON TOP of a dialog, not invisibly beneath it", async () => {
    const user = userEvent.setup();
    useStore.getState().createMock("Billing");
    render(<Home />);
    await user.click(await screen.findByRole("button", { name: /^mocks$/i }));
    await user.click(screen.getByRole("button", { name: /Delete mock server Billing/i }));
    const dialog = await screen.findByRole("dialog");
    await user.keyboard("{Control>}k{/Control}");

    const input = await screen.findByPlaceholderText(/type a command/i);
    // It used to sit at z-50 under the dialog's z-60, so it took the keyboard
    // while being impossible to see.
    const overlay = input.closest("div.fixed") as HTMLElement;
    expect(overlay.className).toContain("z-[70]");
    expect(dialog.className).toContain("z-[60]");
    expect(document.activeElement).toBe(input);
  }, 30_000);
});

/* Nothing traps focus in the dialog, so Enter has to belong to whatever the
   user is actually typing in. */
describe("a confirm dialog answers Enter only while it has the focus", () => {
  test("Enter typed in a field elsewhere does not confirm it", async () => {
    const user = userEvent.setup();
    useStore.getState().createMock("Billing");
    render(<Home />);
    await user.click(await screen.findByRole("button", { name: /^mocks$/i }));
    await user.click(screen.getByRole("button", { name: /Delete mock server Billing/i }));
    await screen.findByRole("button", { name: /^delete$/i });

    const field = screen.getAllByRole("textbox")[0];
    await user.click(field);
    await user.keyboard("hello{Enter}");

    expect(Object.keys(useStore.getState().mocks)).toHaveLength(1);
  }, 30_000);

  test("Enter with the dialog focused still confirms (control)", async () => {
    const user = userEvent.setup();
    useStore.getState().createMock("Billing");
    render(<Home />);
    await user.click(await screen.findByRole("button", { name: /^mocks$/i }));
    await user.click(screen.getByRole("button", { name: /Delete mock server Billing/i }));
    await screen.findByRole("button", { name: /^delete$/i });
    await user.keyboard("{Enter}");
    await waitFor(() => expect(Object.keys(useStore.getState().mocks)).toHaveLength(0));
  }, 30_000);
});
