/**
 * Publishing a mock reported failure as a single ✗ and threw away the server's
 * message — which names the route it refused and why. The validation added
 * with it rejects a good deal more than the old code did, so that message is
 * now the difference between a fixable mistake and a mystery.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Home from "@/app/page";
import { useStore } from "@/lib/store";

const registerMock = vi.fn();
vi.mock("@/lib/transport", () => ({
  registerMock: (...a: unknown[]) => registerMock(...a),
  sendProxy: vi.fn(async () => ({ status: 200, statusText: "OK", headers: {}, body: "", elapsedMs: 1, sizeBytes: 0 })),
  mockBaseUrl: vi.fn(async () => undefined),
}));

const RESET = {
  collections: {}, collectionOrder: [], environments: {}, globals: [],
  history: [], mocks: {}, tabs: [], activeTabId: undefined, activeEnvId: undefined,
  commandPaletteOpen: false, secrets: [], vaultUnlocked: false, vaultError: undefined,
  runnerCollectionId: undefined,
};
beforeEach(() => { localStorage.clear(); useStore.setState(RESET); registerMock.mockReset(); cleanup(); });
afterEach(() => vi.unstubAllGlobals());

/** create a mock server, open it, and press Publish */
async function publish() {
  const user = userEvent.setup();
  useStore.getState().createMock("Billing API");
  render(<Home />);
  // the sidebar opens on collections; mocks are their own panel
  await user.click(await screen.findByRole("button", { name: /^mocks$/i }));
  // and each server's editor starts collapsed
  await user.click(await screen.findByText("▸"));
  await user.click(await screen.findByRole("button", { name: /^publish/i }));
  return user;
}

describe("publishing a mock server", () => {
  test("says which route the server refused and why", async () => {
    registerMock.mockResolvedValue({
      ok: false,
      error: 'Route 2 (GET /orders) has an invalid value for "X-A" — a header cannot contain a line break.',
    });
    await publish();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/Route 2 \(GET \/orders\)/);
    expect(alert).toHaveTextContent(/cannot contain a line break/);
  }, 30_000);

  test("falls back to something readable when the server gives no reason", async () => {
    registerMock.mockResolvedValue({ ok: false });
    await publish();
    expect(await screen.findByRole("alert")).toHaveTextContent(/refused/i);
  }, 30_000);

  test("says nothing when the publish succeeds", async () => {
    registerMock.mockResolvedValue({ ok: true, count: 0 });
    await publish();
    await waitFor(() => expect(screen.getByRole("button", { name: /publish ✓/i })).toBeInTheDocument());
    expect(screen.queryByRole("alert")).toBeNull();
  }, 30_000);

  test("a later success clears the earlier failure", async () => {
    registerMock.mockResolvedValue({ ok: false, error: "Route 1 (GET /) has status 999." });
    const user = await publish();
    expect(await screen.findByRole("alert")).toBeInTheDocument();

    registerMock.mockResolvedValue({ ok: true, count: 1 });
    await user.click(screen.getByRole("button", { name: /^publish/i }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  }, 30_000);
});
