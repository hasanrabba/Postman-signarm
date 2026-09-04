import { describe, expect, test, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Home from "@/app/page";
import { useStore } from "@/lib/store";
import { loadSecrets } from "@/lib/vault";
import { redactRequest, restoreRedacted } from "@/lib/secrets";
import { emptyRequest } from "@/lib/defaults";

const RESET = {
  collections: {}, collectionOrder: [], environments: {}, globals: [],
  history: [], mocks: {}, tabs: [], activeTabId: undefined, activeEnvId: undefined,
  commandPaletteOpen: false, secrets: [], vaultUnlocked: false, vaultError: undefined,
  runnerCollectionId: undefined,
};
beforeEach(() => {
  localStorage.clear();
  useStore.setState(RESET);
  useStore.getState().lockVault();
  cleanup();
});

/* Each vault write is a read-modify-write across a 310k-iteration PBKDF2
   derivation. Overlapping writes used to clobber each other. */
describe("concurrent vault writes", () => {
  test("two secrets added together are both kept, in memory and on disk", async () => {
    await useStore.getState().unlockVault("pw");
    await Promise.all([
      useStore.getState().addSecret("a", "1"),
      useStore.getState().addSecret("b", "2"),
    ]);
    expect(useStore.getState().secrets.map((s) => s.name).sort()).toEqual(["a", "b"]);
    expect((await loadSecrets("pw")).map((s) => s.name).sort()).toEqual(["a", "b"]);
  });

  test("simultaneous deletes do not resurrect a secret", async () => {
    await useStore.getState().unlockVault("pw");
    await useStore.getState().addSecret("a", "1");
    await useStore.getState().addSecret("b", "2");
    const [ia, ib] = useStore.getState().secrets.map((s) => s.id);
    await Promise.all([
      useStore.getState().deleteSecret(ia),
      useStore.getState().deleteSecret(ib),
    ]);
    expect(useStore.getState().secrets).toEqual([]);
    expect(await loadSecrets("pw")).toEqual([]);
  });

  test("simultaneous edits keep both values", async () => {
    await useStore.getState().unlockVault("pw");
    await useStore.getState().addSecret("a", "");
    await useStore.getState().addSecret("b", "");
    const [ia, ib] = useStore.getState().secrets.map((s) => s.id);
    await Promise.all([
      useStore.getState().updateSecret(ia, { value: "AAA" }),
      useStore.getState().updateSecret(ib, { value: "BBB" }),
    ]);
    expect(useStore.getState().secrets.map((s) => s.value)).toEqual(["AAA", "BBB"]);
  });

  test("a failed write does not wedge the queue", async () => {
    await useStore.getState().unlockVault("pw");
    useStore.getState().lockVault();
    await expect(useStore.getState().addSecret("x", "1")).rejects.toThrow(/locked/i);
    await useStore.getState().unlockVault("pw");
    await useStore.getState().addSecret("y", "2");
    expect(useStore.getState().secrets.map((s) => s.name)).toEqual(["y"]);
  });
});

/* Lock is the user's "get these values out of memory now" action. A write
   that was already inside the derivation when the lock landed used to
   finish and write its list straight back into the store, so the panel
   showed a locked vault over plaintext secrets still sitting in state. */
describe("locking during a write in flight", () => {
  test("a lock inside the derivation leaves no secret values in memory", async () => {
    await useStore.getState().unlockVault("pw");
    const writing = useStore.getState().addSecret("leaky", "super-secret-9999");
    // Long enough for the queued task to clear its passphrase check and be
    // inside saveSecrets, short enough that the derivation is still running.
    await new Promise((r) => setTimeout(r, 25));
    useStore.getState().lockVault();
    await writing.catch(() => undefined);
    expect(useStore.getState().vaultUnlocked).toBe(false);
    expect(useStore.getState().secrets).toEqual([]);
  }, 30_000);

  test("no matter where across the derivation the lock lands", async () => {
    for (const delay of [5, 50, 120, 250]) {
      localStorage.clear();
      useStore.setState(RESET);
      useStore.getState().lockVault();
      await useStore.getState().unlockVault("pw");
      const writing = useStore.getState().addSecret("leaky", "s3cret");
      await new Promise((r) => setTimeout(r, delay));
      useStore.getState().lockVault();
      await writing.catch(() => undefined);
      expect(useStore.getState().secrets, `lock at +${delay}ms`).toEqual([]);
    }
  }, 60_000);

  test("the write itself is not lost — it is on disk, just not in memory", async () => {
    await useStore.getState().unlockVault("pw");
    const writing = useStore.getState().addSecret("saved", "keep-me");
    await new Promise((r) => setTimeout(r, 25));
    useStore.getState().lockVault();
    await writing.catch(() => undefined);
    expect(useStore.getState().secrets).toEqual([]);
    expect((await loadSecrets("pw")).map((s) => s.value)).toEqual(["keep-me"]);
  }, 30_000);
});

describe("typing a secret value", () => {
  async function openVault() {
    render(<Home />);
    await waitFor(() => expect(screen.getByText(/collections/i)).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: /^vault$/i }));
  }

  test("blur stores the whole value, not the last character", async () => {
    await useStore.getState().unlockVault("pw");
    await useStore.getState().addSecret("apiKey", "");
    await openVault();
    await userEvent.type(await screen.findByLabelText(/value of apiKey/i), "sk-live-9f3a2b");
    await userEvent.tab();
    await waitFor(() => expect(useStore.getState().secrets[0].value).toBe("sk-live-9f3a2b"));
    expect((await loadSecrets("pw"))[0].value).toBe("sk-live-9f3a2b");
  }, 30_000);

  test("a pause in typing stores it too, without needing blur", async () => {
    await useStore.getState().unlockVault("pw");
    await useStore.getState().addSecret("apiKey", "");
    await openVault();
    await userEvent.type(await screen.findByLabelText(/value of apiKey/i), "no-blur-value");
    await waitFor(
      () => expect(useStore.getState().secrets[0].value).toBe("no-blur-value"),
      { timeout: 8000 }
    );
  }, 30_000);

  test("Escape reverts the field without writing", async () => {
    await useStore.getState().unlockVault("pw");
    await useStore.getState().addSecret("apiKey", "original");
    await openVault();
    const field = await screen.findByLabelText(/value of apiKey/i);
    await userEvent.clear(field);
    await userEvent.type(field, "typo{Escape}");
    expect(useStore.getState().secrets[0].value).toBe("original");
  }, 30_000);
});

describe("restoring redacted requests", () => {
  test("duplicate header names each keep their own value", () => {
    const req = emptyRequest({
      headers: [
        { id: "h1", key: "Authorization", value: "Bearer AAA", enabled: true },
        { id: "h2", key: "authorization", value: "Bearer BBB", enabled: true },
      ],
    });
    const back = restoreRedacted(redactRequest(req), req);
    expect(back.headers.map((h) => h.value)).toEqual(["Bearer AAA", "Bearer BBB"]);
  });

  test("duplicate param names each keep their own value", () => {
    const req = emptyRequest({
      params: [
        { id: "p1", key: "token", value: "one", enabled: true },
        { id: "p2", key: "token", value: "two", enabled: true },
      ],
    });
    const back = restoreRedacted(redactRequest(req), req);
    expect(back.params.map((p) => p.value)).toEqual(["one", "two"]);
  });

  test("falls back to name order when ids no longer match", () => {
    const entry = emptyRequest({
      headers: [
        { id: "old1", key: "Authorization", value: "[REDACTED]", enabled: true },
        { id: "old2", key: "Authorization", value: "[REDACTED]", enabled: true },
      ],
    });
    const live = emptyRequest({
      headers: [
        { id: "new1", key: "Authorization", value: "first", enabled: true },
        { id: "new2", key: "Authorization", value: "second", enabled: true },
      ],
    });
    expect(restoreRedacted(entry, live).headers.map((h) => h.value)).toEqual(["first", "second"]);
  });

  test("a genuine non-secret value is left alone", () => {
    const req = emptyRequest({
      headers: [{ id: "h1", key: "X-Trace", value: "abc", enabled: true }],
    });
    expect(restoreRedacted(redactRequest(req), req).headers[0].value).toBe("abc");
  });
});
