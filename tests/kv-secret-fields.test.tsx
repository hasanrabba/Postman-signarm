import { describe, test, expect, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Home from "@/app/page";
import { useStore } from "@/lib/store";

const RESET = {
  collections: {}, collectionOrder: [], environments: {}, globals: [],
  history: [], mocks: {}, tabs: [], activeTabId: undefined, activeEnvId: undefined,
  commandPaletteOpen: false, secrets: [], vaultUnlocked: false, vaultError: undefined,
  runnerCollectionId: undefined,
};
beforeEach(() => { localStorage.clear(); useStore.setState(RESET); cleanup(); });

const draft = () => {
  const st = useStore.getState();
  return st.tabs.find((t) => t.id === st.activeTabId)!.draft;
};

async function openHeaders(user: ReturnType<typeof userEvent.setup>) {
  render(<Home />);
  await waitFor(() => screen.getByRole("button", { name: /send/i }));
  await user.click(screen.getByRole("button", { name: /^headers$/i }));
}

/* A row is auto-treated as secret from its key name alone. That used to make
   the value box readOnly, so the single most common header in an API client
   silently swallowed every keystroke. */
describe("typing into an auto-detected secret field", () => {
  test("an Authorization header accepts its token", async () => {
    const user = userEvent.setup();
    await openHeaders(user);
    await user.type(screen.getByPlaceholderText("Header-Name"), "Authorization");
    await user.type(screen.getAllByPlaceholderText("value")[0], "Bearer sk-live-abc123");
    expect(draft().headers[0].value).toBe("Bearer sk-live-abc123");
  }, 30_000);

  test("an api_key query param accepts its value", async () => {
    const user = userEvent.setup();
    render(<Home />);
    await waitFor(() => screen.getByRole("button", { name: /send/i }));
    await user.type(screen.getByPlaceholderText("param"), "api_key");
    await user.type(screen.getAllByPlaceholderText("value")[0], "abc123");
    expect(draft().params[0].value).toBe("abc123");
  }, 30_000);

  test("the value field is not locked", async () => {
    const user = userEvent.setup();
    await openHeaders(user);
    await user.type(screen.getByPlaceholderText("Header-Name"), "Cookie");
    const field = screen.getAllByPlaceholderText("value")[0] as HTMLInputElement;
    await user.click(field);
    expect(field.readOnly).toBe(false);
  }, 30_000);

  test("a non-secret header still works (control)", async () => {
    const user = userEvent.setup();
    await openHeaders(user);
    await user.type(screen.getByPlaceholderText("Header-Name"), "X-Trace");
    await user.type(screen.getAllByPlaceholderText("value")[0], "abc123");
    expect(draft().headers[0].value).toBe("abc123");
  }, 30_000);
});

/* The mask is lossy, so it must never be shown over a field being edited —
   that would write bullets back as the value. */
describe("masking a secret value", () => {
  test("the value is masked once focus leaves, and the real value survives", async () => {
    const user = userEvent.setup();
    await openHeaders(user);
    await user.type(screen.getByPlaceholderText("Header-Name"), "Authorization");
    const field = screen.getAllByPlaceholderText("value")[0] as HTMLInputElement;
    await user.type(field, "Bearer tok");
    await user.tab();
    await waitFor(() => expect(field.value).toBe("••••••••••"));
    expect(field.type).toBe("password");
    // masked on screen, intact underneath — no bullets written back
    expect(draft().headers[0].value).toBe("Bearer tok");
  }, 30_000);

  test("re-focusing shows the real value so it can be edited", async () => {
    const user = userEvent.setup();
    await openHeaders(user);
    await user.type(screen.getByPlaceholderText("Header-Name"), "Authorization");
    const field = screen.getAllByPlaceholderText("value")[0] as HTMLInputElement;
    await user.type(field, "Bearer tok");
    await user.tab();
    await user.click(field);
    await waitFor(() => expect(field.value).toBe("Bearer tok"));
    await user.type(field, "en");
    expect(draft().headers[0].value).toBe("Bearer token");
  }, 30_000);

  test("an ordinary header is never masked", async () => {
    const user = userEvent.setup();
    await openHeaders(user);
    await user.type(screen.getByPlaceholderText("Header-Name"), "X-Trace");
    const field = screen.getAllByPlaceholderText("value")[0] as HTMLInputElement;
    await user.type(field, "abc");
    await user.tab();
    expect(field.value).toBe("abc");
    expect(field.type).toBe("text");
  }, 30_000);
});
