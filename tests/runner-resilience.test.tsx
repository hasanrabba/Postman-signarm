import { describe, test, expect, beforeEach, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Home from "@/app/page";
import { useStore } from "@/lib/store";

// The first request blows up before any network call; the second is fine.
vi.mock("@/lib/executor", async () => {
  let call = 0;
  return {
    executeRequest: vi.fn(async () => {
      call += 1;
      if (call === 1) throw new Error("boom before send");
      return {
        request: {}, tests: [], logs: [],
        envUpdates: {}, globalUpdates: {}, collectionUpdates: {},
        response: { status: 200, statusText: "OK", headers: {}, body: "", elapsedMs: 1, sizeBytes: 0 },
      };
    }),
  };
});

const RESET = {
  collections: {}, collectionOrder: [], environments: {}, globals: [],
  history: [], mocks: {}, tabs: [], activeTabId: undefined, activeEnvId: undefined,
  commandPaletteOpen: false, secrets: [], vaultUnlocked: false, vaultError: undefined,
  runnerCollectionId: undefined,
};
beforeEach(() => { localStorage.clear(); useStore.setState(RESET); cleanup(); });
afterEach(() => vi.clearAllMocks());

/* executeRequest handles its own network errors, but anything thrown before
   the send used to escape the runner's loop: setRunning(false) never ran, so
   the panel sat on "running" forever and later requests were never tried. */
describe("the collection runner survives a failing request", () => {
  test("it finishes the run and still attempts the second request", async () => {
    const user = userEvent.setup();
    const cid = useStore.getState().createCollection("C");
    const root = useStore.getState().collections[cid].rootFolderId;
    useStore.getState().addRequest(cid, root, { name: "bad", url: "http://a.test/" });
    useStore.getState().addRequest(cid, root, { name: "good", url: "http://b.test/" });
    useStore.getState().openRunner(cid);

    render(<Home />);
    const runBtn = await screen.findByRole("button", { name: /^run$/i });
    // Scope to the runner dialog — the sidebar tree shows the same names.
    const dialog = runBtn.closest("div.fixed") as HTMLElement;
    const inDialog = within(dialog);
    await user.click(runBtn);

    // Both rows appear, so the run did not stop at the first failure...
    await waitFor(() => {
      expect(inDialog.getByText("bad")).toBeInTheDocument();
      expect(inDialog.getByText("good")).toBeInTheDocument();
    }, { timeout: 5000 });
    // ...the failure says what went wrong rather than showing a bare 0...
    expect(inDialog.getByText(/boom before send/i)).toBeInTheDocument();
    // ...and the run actually ended.
    await waitFor(() =>
      expect(inDialog.getByRole("button", { name: /^run$/i })).toBeEnabled()
    );
  }, 30_000);
});
