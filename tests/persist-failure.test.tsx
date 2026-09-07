/**
 * zustand's persist middleware calls setItem and ignores what happens, so a
 * full localStorage failed silently: the saved blob froze, every later change
 * failed the same way, and work done afterwards was on screen but gone after a
 * reload. A mock body of 5MB — which the mock server accepted — was on its own
 * larger than the whole ~5MB budget the app shares.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import Home from "@/app/page";
import { useStore } from "@/lib/store";
import { reportPersistFailure } from "@/lib/persistStatus";
import { MAX_BODY_BYTES, validateRoutes } from "@/lib/mock";

vi.mock("@/lib/transport", () => ({
  registerMock: vi.fn(async () => ({ ok: true, count: 1 })),
  mockUrlFor: vi.fn(async () => "http://x/api/mock/m"),
  sendProxy: vi.fn(async () => ({ status: 200, statusText: "OK", headers: {}, body: "", elapsedMs: 1, sizeBytes: 0 })),
  mockBaseUrl: vi.fn(async () => "http://x"),
}));

const RESET = {
  collections: {}, collectionOrder: [], environments: {}, globals: [],
  history: [], mocks: {}, tabs: [], activeTabId: undefined, activeEnvId: undefined,
  commandPaletteOpen: false, secrets: [], vaultUnlocked: false, vaultError: undefined,
  runnerCollectionId: undefined,
};
beforeEach(() => { localStorage.clear(); useStore.setState(RESET); reportPersistFailure(null); cleanup(); });
afterEach(() => { vi.restoreAllMocks(); reportPersistFailure(null); });

describe("a save that fails is not silent", () => {
  test("a full localStorage puts a message on screen", async () => {
    render(<Home />);
    await screen.findByRole("button", { name: /^mocks$/i });
    expect(screen.queryByRole("alert")).toBeNull();

    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      const e = new Error("quota"); e.name = "QuotaExceededError"; throw e;
    });
    useStore.getState().createCollection("After the failure");

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/could not save/i);
    expect(alert).toHaveTextContent(/reload/i);
  }, 30_000);

  test("and it clears once a save works again", async () => {
    render(<Home />);
    await screen.findByRole("button", { name: /^mocks$/i });

    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      const e = new Error("quota"); e.name = "QuotaExceededError"; throw e;
    });
    useStore.getState().createCollection("A");
    await screen.findByRole("alert");

    spy.mockRestore();
    useStore.getState().createCollection("B");
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  }, 30_000);
});

/* The mock server used to accept a body larger than the entire storage
   budget the app shares. */
describe("a mock body has to fit in the storage it shares", () => {
  test("the cap is well under a browser's whole allowance", () => {
    expect(MAX_BODY_BYTES).toBeLessThan(1024 * 1024);
  });

  test("a body past it is refused, naming the route", () => {
    const r = validateRoutes([
      { id: "1", method: "GET", path: "/z", status: 200, headers: {}, body: "x".repeat(MAX_BODY_BYTES + 1) },
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/GET \/z/);
  });

  test("an ordinary recorded response still fits (control)", () => {
    const r = validateRoutes([
      { id: "1", method: "GET", path: "/z", status: 200, headers: {}, body: "x".repeat(100_000) },
    ]);
    expect(r.ok).toBe(true);
  });
});
