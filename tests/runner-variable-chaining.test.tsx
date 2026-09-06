import { describe, test, expect, beforeEach, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Home from "@/app/page";
import { useStore } from "@/lib/store";

/* Record every URL the transport is actually asked to send, so we can see
   what request 2 resolved {{carried}} to. The real executor runs. */
const sent: string[] = [];
vi.mock("@/lib/transport", () => ({
  sendProxy: vi.fn(async (payload: { url: string }) => {
    sent.push(payload.url);
    return { status: 200, statusText: "OK", headers: {}, body: "{}", elapsedMs: 1, sizeBytes: 2 };
  }),
  registerMock: vi.fn(async () => ({ ok: true })),
  mockBaseUrl: vi.fn(async () => undefined),
}));

const RESET = {
  collections: {}, collectionOrder: [], environments: {}, globals: [],
  history: [], mocks: {}, tabs: [], activeTabId: undefined, activeEnvId: undefined,
  commandPaletteOpen: false, secrets: [], vaultUnlocked: false, vaultError: undefined,
  runnerCollectionId: undefined,
};
beforeEach(() => { localStorage.clear(); useStore.setState(RESET); sent.length = 0; cleanup(); });
afterEach(() => vi.clearAllMocks());

describe("collection runner variable chaining", () => {
  test("a pre-request write in request 1 is visible to request 2", async () => {
    const user = userEvent.setup();
    const cid = useStore.getState().createCollection("Suite");
    const root = useStore.getState().collections[cid].rootFolderId;
    useStore.getState().addRequest(cid, root, {
      name: "first",
      url: "http://a.test/one",
      preRequestScript: "sg.globals.set('carried','FROM-FIRST');",
    });
    useStore.getState().addRequest(cid, root, {
      name: "second",
      url: "http://b.test/two?carry={{carried}}",
    });
    useStore.getState().openRunner(cid);

    render(<Home />);
    const runBtn = await screen.findByRole("button", { name: /^run$/i });
    const dialog = runBtn.closest("div.fixed") as HTMLElement;
    await user.click(runBtn);

    await waitFor(() => {
      expect(within(dialog).getByText("second")).toBeInTheDocument();
    }, { timeout: 5000 });

    expect(sent).toHaveLength(2);
    expect(sent[1]).toBe("http://b.test/two?carry=FROM-FIRST");
  }, 30_000);

  test("a test-script write in request 1 is visible to request 2", async () => {
    const user = userEvent.setup();
    const cid = useStore.getState().createCollection("Suite");
    const root = useStore.getState().collections[cid].rootFolderId;
    useStore.getState().addRequest(cid, root, {
      name: "first",
      url: "http://a.test/one",
      testScript: "sg.env.set('tok','TOKEN-1');",
    });
    useStore.getState().addRequest(cid, root, {
      name: "second",
      url: "http://b.test/two?t={{tok}}",
    });
    useStore.getState().openRunner(cid);

    render(<Home />);
    const runBtn = await screen.findByRole("button", { name: /^run$/i });
    const dialog = runBtn.closest("div.fixed") as HTMLElement;
    await user.click(runBtn);

    await waitFor(() => {
      expect(within(dialog).getByText("second")).toBeInTheDocument();
    }, { timeout: 5000 });

    expect(sent).toHaveLength(2);
    expect(sent[1]).toBe("http://b.test/two?t=TOKEN-1");
  }, 30_000);
});
