/**
 * The fixes for -I, -d's Content-Type and query fidelity are all in the import
 * path. This drives the actual "Import cURL" button a user clicks and then
 * sends, because every serious defect in this project escaped a green suite by
 * being tested through the API rather than through the control.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Home from "@/app/page";
import { useStore } from "@/lib/store";

const sent: { method: string; url: string; headers: Record<string, string>; body?: string }[] = [];
vi.mock("@/lib/transport", () => ({
  sendProxy: vi.fn(async (p: never) => {
    sent.push(p);
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
afterEach(() => vi.unstubAllGlobals());

/** paste `cmd` into the Import cURL button, then press Send */
async function importAndSend(cmd: string) {
  const user = userEvent.setup();
  useStore.getState().openDraft();
  render(<Home />);

  await user.click(await screen.findByRole("button", { name: /^body$/i }));
  vi.stubGlobal("prompt", () => cmd);
  await user.click(await screen.findByRole("button", { name: /import curl/i }));

  await user.click(await screen.findByRole("button", { name: /^send$/i }));
  await waitFor(() => expect(sent.length).toBeGreaterThan(0), { timeout: 5000 });
  const p = sent.at(-1)!;
  const ct = Object.entries(p.headers).find(([k]) => k.toLowerCase() === "content-type")?.[1];
  return { ...p, contentType: ct };
}

describe("what the Import cURL button actually sends", () => {
  test("-I sends a HEAD", async () => {
    expect((await importAndSend("curl -I http://x.test/a")).method).toBe("HEAD");
  }, 30_000);

  test("-d carries the Content-Type curl would have set", async () => {
    const w = await importAndSend("curl http://x.test/a -d 'a=1&b=2'");
    expect(w.contentType).toBe("application/x-www-form-urlencoded");
    expect(w.body).toBe("a=1&b=2");
  }, 30_000);

  test("a plus in the query is not turned into a literal plus", async () => {
    expect((await importAndSend("curl 'http://x.test/a?q=a+b'")).url)
      .toBe("http://x.test/a?q=a+b");
  }, 30_000);

  test("an ordinary query still lands in the params table", async () => {
    const w = await importAndSend("curl 'http://x.test/a?x=1&y=2'");
    expect(w.url).toBe("http://x.test/a?x=1&y=2");
    expect(useStore.getState().tabs[0].draft.params.map((p) => p.key)).toEqual(["x", "y"]);
  }, 30_000);
});
