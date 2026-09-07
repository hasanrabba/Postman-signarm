/**
 * Independent re-run of the claim's INPUT, driving the real mocks panel and
 * the real /api/mock-config handler. Question asked: after a refused Publish,
 * is the server's reason on screen for the user, or only a bare "✗"?
 */
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Home from "@/app/page";
import { useStore } from "@/lib/store";
import { GET as serveGET } from "@/app/api/mock/[mockId]/[[...path]]/route";

const replies = vi.hoisted(() => [] as { ok: boolean; count?: number; error?: string }[]);

vi.mock("@/lib/transport", () => ({
  sendProxy: async () => ({ status: 200, statusText: "OK", headers: {}, body: "{}", elapsedMs: 1, sizeBytes: 2 }),
  mockBaseUrl: async () => "http://localhost",
  registerMock: async (mockId: string, routes: unknown[]) => {
    const { POST } = await import("@/app/api/mock-config/route");
    const res = await POST(new Request("http://localhost/api/mock-config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mockId, routes }),
    }) as never);
    const json = (await res.json()) as { ok: boolean; count?: number; error?: string };
    replies.push(json);
    return json;
  },
}));

const RESET = {
  collections: {}, collectionOrder: [], environments: {}, globals: [],
  history: [], mocks: {}, tabs: [], activeTabId: undefined, activeEnvId: undefined,
  commandPaletteOpen: false, secrets: [], vaultUnlocked: false, vaultError: undefined,
  runnerCollectionId: undefined,
};

function clearRegistry() {
  const reg = (globalThis as { __signalMocks?: Record<string, unknown> }).__signalMocks;
  if (reg) for (const k of Object.keys(reg)) delete reg[k];
}

beforeEach(() => {
  localStorage.clear();
  useStore.setState(RESET);
  replies.length = 0;
  clearRegistry();
  cleanup();
});
afterEach(() => vi.unstubAllGlobals());

const theMock = () => Object.values(useStore.getState().mocks)[0];
const publishButton = () => screen.getByRole("button", { name: /^Publish/ });
const bodyBoxes = () => screen.getAllByPlaceholderText(/response body/i) as HTMLTextAreaElement[];
const pathBoxes = () => screen.getAllByPlaceholderText("/path") as HTMLInputElement[];

async function openEditorWithRoute(user: ReturnType<typeof userEvent.setup>) {
  window.prompt = () => "my-mock";
  render(<Home />);
  await user.click(await screen.findByRole("button", { name: /^mocks$/i }));
  await user.click(await screen.findByRole("button", { name: /New mock server/i }));
  await waitFor(() => expect(theMock()).toBeTruthy());
  const caret = screen.getAllByRole("button").find((b) => b.textContent === "▸");
  await user.click(caret!);
  await user.click(await screen.findByRole("button", { name: /\+ Route/i }));
  await waitFor(() => expect(theMock().routes.length).toBe(1));
  return theMock().id;
}

async function hit(mockId: string, path: string[]) {
  const res = await serveGET(
    new Request(`http://localhost/api/mock/${mockId}/${path.join("/")}`) as never,
    { params: Promise.resolve({ mockId, path }) } as never
  );
  return { status: res.status, body: await res.text() };
}

describe("REFUTE: is the refusal reason actually on screen?", () => {
  test("the claim's exact INPUT: the server's sentence is rendered verbatim in a live region", async () => {
    const user = userEvent.setup();
    const id = await openEditorWithRoute(user);

    // Route 1: /good -> v1, published.
    fireEvent.change(pathBoxes()[0], { target: { value: "/good" } });
    fireEvent.change(bodyBoxes()[0], { target: { value: "v1" } });
    await user.click(publishButton());
    await waitFor(() => expect(replies.length).toBe(1));
    expect(replies[0]).toMatchObject({ ok: true });
    expect(await hit(id, ["good"])).toEqual({ status: 200, body: "v1" });

    // Edit body to v2, add a second route with a slashless path.
    fireEvent.change(bodyBoxes()[0], { target: { value: "v2" } });
    await user.click(screen.getByRole("button", { name: /\+ Route/i }));
    await waitFor(() => expect(theMock().routes.length).toBe(2));
    fireEvent.change(pathBoxes()[1], { target: { value: "broken" } });
    await user.click(publishButton());
    await waitFor(() => expect(replies.length).toBe(2));

    const alert = await screen.findByRole("alert");
    // eslint-disable-next-line no-console
    console.log("[refute] server said :", JSON.stringify(replies[1].error));
    // eslint-disable-next-line no-console
    console.log("[refute] on screen    :", JSON.stringify(alert.textContent));
    // eslint-disable-next-line no-console
    console.log("[refute] button label :", JSON.stringify(publishButton().textContent));
    // eslint-disable-next-line no-console
    console.log("[refute] alert sits inside the mock editor card:",
      alert.closest("div.border")?.contains(pathBoxes()[1]) ?? false);

    // The EXPECTED sentence from the finding, word for word.
    expect(alert.textContent).toBe(
      'Route 2 (GET broken) has an invalid path; it must start with "/".'
    );
    expect(replies[1].error).toBe(alert.textContent);
    expect(document.body.textContent).toContain(replies[1].error!);
  }, 30_000);

  test("the finder's own log line only ever reads the BUTTON, never the page", async () => {
    const user = userEvent.setup();
    await openEditorWithRoute(user);
    fireEvent.change(pathBoxes()[0], { target: { value: "users" } });
    await user.click(publishButton());
    await waitFor(() => expect(replies.length).toBe(1));

    // This is the string the finder captured as "ACTUAL".
    expect(publishButton().textContent).toBe("Publish ✗");
    // And this is what the page says at the same instant.
    const alert = await screen.findByRole("alert");
    // eslint-disable-next-line no-console
    console.log("[refute] badge:", JSON.stringify(publishButton().textContent),
      "| page also shows:", JSON.stringify(alert.textContent));
    expect(alert.textContent).toBe(
      'Route 1 (GET users) has an invalid path; it must start with "/".'
    );
  }, 30_000);

  test("every rule the finding lists surfaces its own sentence, not a bare ✗", async () => {
    const user = userEvent.setup();
    const cases: { name: string; mutate: () => void; expect: RegExp }[] = [];
    const seen: string[] = [];

    for (const [label, apply, want] of [
      ["204-with-body", () => {
        fireEvent.change(pathBoxes()[0], { target: { value: "/a" } });
        fireEvent.change(screen.getAllByLabelText("Response status")[0], { target: { value: "204" } });
        fireEvent.change(bodyBoxes()[0], { target: { value: "nope" } });
      }, /204/],
      ["invalid path", () => {
        fireEvent.change(pathBoxes()[0], { target: { value: "nah" } });
      }, /invalid path/],
    ] as const) {
      cleanup();
      useStore.setState(RESET);
      clearRegistry();
      replies.length = 0;
      const u = userEvent.setup();
      await openEditorWithRoute(u);
      apply();
      await u.click(publishButton());
      await waitFor(() => expect(replies.length).toBe(1));
      if (replies[0].ok) { seen.push(`${label}: ACCEPTED`); continue; }
      const alert = await screen.findByRole("alert");
      seen.push(`${label}: ${alert.textContent}`);
      expect(alert.textContent).toBe(replies[0].error);
      expect(alert.textContent).toMatch(want);
    }
    void cases; void user;
    // eslint-disable-next-line no-console
    console.log("[refute] per-rule messages shown to the user:\n  " + seen.join("\n  "));
  }, 30_000);
});
