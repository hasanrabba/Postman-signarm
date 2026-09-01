import { describe, expect, test, beforeEach, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Home from "@/app/page";
import { useStore } from "@/lib/store";
import { saveSecrets, loadSecrets, hasVault, secretsAsVars, VaultDecryptError } from "@/lib/vault";
import { redactRequest } from "@/lib/secrets";
import { resolveVars } from "@/lib/variables";
import { emptyRequest } from "@/lib/defaults";
import type { Secret } from "@/lib/types";

const RESET = {
  collections: {}, collectionOrder: [], environments: {}, globals: [],
  history: [], mocks: {}, tabs: [], activeTabId: undefined,
  activeEnvId: undefined, commandPaletteOpen: false,
  secrets: [], vaultUnlocked: false, vaultError: undefined,
};

const sec = (name: string, value: string): Secret =>
  ({ id: `s_${name}`, name, value, createdAt: 0 });

beforeEach(() => {
  localStorage.clear();
  useStore.setState(RESET);
  useStore.getState().lockVault();
  cleanup();
});

describe("vault encryption", () => {
  test("round-trips through the correct passphrase", async () => {
    await saveSecrets([sec("db", "hunter2")], "correct horse");
    expect(await loadSecrets("correct horse")).toEqual([sec("db", "hunter2")]);
  });

  test("a wrong passphrase is rejected, not silently empty", async () => {
    await saveSecrets([sec("db", "hunter2")], "right");
    await expect(loadSecrets("wrong")).rejects.toBeInstanceOf(VaultDecryptError);
  });

  test("nothing readable is written to storage", async () => {
    await saveSecrets([sec("db", "hunter2")], "pw");
    const raw = localStorage.getItem("signal.vault.v1")!;
    expect(raw).not.toContain("hunter2");
    expect(raw).not.toContain("pw");
    const blob = JSON.parse(raw);
    expect(blob.salt).toBeTruthy();
    expect(blob.iv).toBeTruthy();
    expect(blob.kdf.iterations).toBeGreaterThanOrEqual(100_000);
  });

  test("each save uses a fresh salt and IV", async () => {
    await saveSecrets([sec("a", "x")], "pw");
    const first = localStorage.getItem("signal.vault.v1")!;
    await saveSecrets([sec("a", "x")], "pw");
    const second = localStorage.getItem("signal.vault.v1")!;
    expect(JSON.parse(first).salt).not.toBe(JSON.parse(second).salt);
    expect(first).not.toBe(second);
  });

  test("a large vault saves without blowing the stack", async () => {
    const big = Array.from({ length: 400 }, (_, i) => sec(`k${i}`, "v".repeat(500)));
    await expect(saveSecrets(big, "pw")).resolves.toBeUndefined();
    expect(await loadSecrets("pw")).toHaveLength(400);
  });

  test("a corrupted blob reports a decrypt error", async () => {
    localStorage.setItem("signal.vault.v1", JSON.stringify({ v: 2, salt: "AAAA", iv: "AAAA", ct: "AAAA" }));
    await expect(loadSecrets("pw")).rejects.toBeInstanceOf(VaultDecryptError);
  });

  test("hasVault reflects whether a blob exists", async () => {
    expect(hasVault()).toBe(false);
    await saveSecrets([], "pw");
    expect(hasVault()).toBe(true);
  });

  test("an empty vault loads as an empty list", async () => {
    expect(await loadSecrets("anything")).toEqual([]);
  });
});

describe("secrets as variables", () => {
  test("resolve as {{name}}", () => {
    const vars = secretsAsVars([sec("token", "abc123")]);
    expect(resolveVars("Bearer {{token}}", { secrets: vars })).toBe("Bearer abc123");
  });

  test("outrank an environment variable of the same name", () => {
    expect(
      resolveVars("{{k}}", {
        environment: [{ id: "e", key: "k", value: "from-env", enabled: true }],
        secrets: secretsAsVars([sec("k", "from-vault")]),
      })
    ).toBe("from-vault");
  });
});

describe("redaction of literal secret values", () => {
  const req = emptyRequest({
    url: "https://api.example.com/?t=s3cret-value",
    headers: [{ id: "h", key: "X-Custom", value: "s3cret-value", enabled: true }],
    body: {
      mode: "json", raw: `{"nested":"s3cret-value"}`,
      urlencoded: [], formdata: [], graphql: { query: "", variables: "" },
    },
  });

  test("masks a secret in a header the name heuristics do not catch", () => {
    const r = redactRequest(req, ["s3cret-value"]);
    expect(r.headers[0].value).toBe("[REDACTED]");
  });

  test("masks it in the URL and body too", () => {
    const r = redactRequest(req, ["s3cret-value"]);
    expect(r.url).not.toContain("s3cret-value");
    expect(r.body.raw).not.toContain("s3cret-value");
  });

  test("leaves the request alone when no secrets are unlocked", () => {
    expect(redactRequest(req, []).headers[0].value).toBe("s3cret-value");
  });

  test("ignores very short values so ordinary requests survive", () => {
    const r = redactRequest(
      emptyRequest({ headers: [{ id: "h", key: "X-N", value: "12345", enabled: true }] }),
      ["1"]
    );
    expect(r.headers[0].value).toBe("12345");
  });
});

describe("vault store actions", () => {
  test("unlock creates a vault, add persists, lock clears memory", async () => {
    const s = useStore.getState();
    expect(await s.unlockVault("pw")).toBe(true);
    expect(useStore.getState().vaultUnlocked).toBe(true);

    await useStore.getState().addSecret("api", "key-123");
    expect(useStore.getState().secrets[0].name).toBe("api");
    expect(await loadSecrets("pw")).toHaveLength(1);

    useStore.getState().lockVault();
    expect(useStore.getState().vaultUnlocked).toBe(false);
    expect(useStore.getState().secrets).toEqual([]);
  });

  test("a wrong passphrase fails with a message and stays locked", async () => {
    await useStore.getState().unlockVault("right");
    await useStore.getState().addSecret("a", "b");
    useStore.getState().lockVault();

    expect(await useStore.getState().unlockVault("wrong")).toBe(false);
    expect(useStore.getState().vaultUnlocked).toBe(false);
    expect(useStore.getState().vaultError).toMatch(/wrong passphrase|corrupted/i);
  });

  test("delete removes the secret from disk as well as memory", async () => {
    await useStore.getState().unlockVault("pw");
    await useStore.getState().addSecret("a", "b");
    const id = useStore.getState().secrets[0].id;
    await useStore.getState().deleteSecret(id);
    expect(useStore.getState().secrets).toEqual([]);
    expect(await loadSecrets("pw")).toEqual([]);
  });

  test("secrets never enter the persisted app state", async () => {
    await useStore.getState().unlockVault("pw");
    await useStore.getState().addSecret("api", "super-secret-value");
    useStore.getState().createCollection("C"); // force a persist write
    await waitFor(() => expect(localStorage.getItem("signal.state.v1")).toBeTruthy());
    const persisted = localStorage.getItem("signal.state.v1")!;
    expect(persisted).not.toContain("super-secret-value");
    expect(persisted).not.toContain("vaultUnlocked");
  });
});

describe("vault end to end", () => {
  test("a secret resolves into a request and is masked in history", async () => {
    (globalThis as { fetch: unknown }).fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        status: 200, statusText: "OK", headers: {}, body: "{}", elapsedMs: 1, sizeBytes: 2,
      }), { status: 200, headers: { "content-type": "application/json" } })
    );
    await useStore.getState().unlockVault("pw");
    await useStore.getState().addSecret("vaultToken", "tok-from-vault-9999");

    const s = useStore.getState();
    const cid = s.createCollection("C");
    const col = useStore.getState().collections[cid];
    const rid = s.addRequest(cid, col.rootFolderId, {
      name: "r", method: "GET", url: "https://api.example.com/x",
      headers: [{ id: "h", key: "X-Plain", value: "{{vaultToken}}", enabled: true }],
    });
    useStore.getState().openRequest(cid, rid);
    render(<Home />);
    await userEvent.click(screen.getByRole("button", { name: /^send$/i }));
    await waitFor(() => expect(useStore.getState().history.length).toBe(1));

    // The value really was substituted onto the wire...
    const sent = JSON.parse(
      ((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1] as { body: string }).body
    );
    expect(sent.headers["X-Plain"]).toBe("tok-from-vault-9999");

    // ...but history keeps no copy of it.
    const entry = useStore.getState().history[0];
    expect(JSON.stringify(entry)).not.toContain("tok-from-vault-9999");
  });

  test("the panel unlocks, adds and lists a secret", async () => {
    render(<Home />);
    await waitFor(() => expect(screen.getByText(/collections/i)).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: /^vault$/i }));

    await userEvent.type(screen.getByLabelText(/vault passphrase/i), "opensesame");
    await userEvent.click(screen.getByRole("button", { name: /create vault/i }));

    await waitFor(() => expect(screen.getByLabelText(/secret name/i)).toBeInTheDocument());
    await userEvent.type(screen.getByLabelText(/secret name/i), "apiKey");
    await userEvent.type(screen.getByLabelText(/secret value/i), "v-123456");
    await userEvent.click(screen.getByRole("button", { name: /add secret/i }));

    await waitFor(() => expect(screen.getByText("{{apiKey}}")).toBeInTheDocument());
    expect(useStore.getState().secrets[0].value).toBe("v-123456");
  });
});
