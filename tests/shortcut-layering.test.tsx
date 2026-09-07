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

const sendProxy = vi.fn(async () => ({
  status: 200, statusText: "OK", headers: {}, body: "", elapsedMs: 1, sizeBytes: 0,
}));
vi.mock("@/lib/transport", () => ({
  registerMock: vi.fn(async () => ({ ok: true, count: 0 })),
  mockUrlFor: vi.fn(async () => undefined),
  sendProxy: (p: unknown) => sendProxy(p as never),
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
