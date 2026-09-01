import type { KeyValue, Secret } from "./types";

const STORAGE_KEY = "signal.vault.v1";
const PBKDF2_ITERATIONS = 310_000; // OWASP guidance for PBKDF2-HMAC-SHA256
const SALT_BYTES = 16;
const IV_BYTES = 12;

/**
 * Derive an AES-GCM key from the passphrase with PBKDF2.
 *
 * The passphrase must never be used as raw key material: padding it to 32
 * bytes makes "hunter2" the key `hunter2\0\0…`, which is both low-entropy
 * and identical on every install, so one precomputed table cracks every
 * vault. A per-vault random salt plus a high iteration count makes each
 * vault its own brute-force problem.
 */
async function deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

/** True when an encrypted vault has been written to this browser. */
export function hasVault(): boolean {
  try { return localStorage.getItem(STORAGE_KEY) !== null; }
  catch { return false; }
}

export async function saveSecrets(secrets: Secret[], passphrase: string): Promise<void> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveKey(passphrase, salt);
  const data = new TextEncoder().encode(JSON.stringify(secrets));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, data);
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      v: 2,
      kdf: { name: "PBKDF2", hash: "SHA-256", iterations: PBKDF2_ITERATIONS },
      salt: toBase64(salt),
      iv: toBase64(iv),
      ct: toBase64(new Uint8Array(ct)),
    })
  );
}

/** Thrown when the passphrase is wrong or the stored blob was tampered with. */
export class VaultDecryptError extends Error {
  constructor() { super("Could not decrypt the vault — wrong passphrase or corrupted data."); }
}

export async function loadSecrets(passphrase: string): Promise<Secret[]> {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return [];
  let parsed: { salt?: string; iv: string; ct: string; kdf?: { iterations?: number } };
  try { parsed = JSON.parse(raw); } catch { throw new VaultDecryptError(); }
  if (!parsed?.iv || !parsed?.ct || !parsed?.salt) throw new VaultDecryptError();

  const key = await deriveKey(passphrase, fromBase64(parsed.salt));
  let plain: ArrayBuffer;
  try {
    plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64(parsed.iv) as BufferSource },
      key,
      fromBase64(parsed.ct)
    );
  } catch {
    throw new VaultDecryptError();
  }
  try { return JSON.parse(new TextDecoder().decode(plain)); }
  catch { throw new VaultDecryptError(); }
}

/**
 * Base64 without spreading the whole array into String.fromCharCode —
 * spreading blows the call stack somewhere north of ~100 KB, which a vault
 * of any real size will exceed.
 */
function toBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let s = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

function fromBase64(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

/** Present unlocked secrets to the variable resolver as {{name}} entries. */
export function secretsAsVars(secrets: Secret[]): KeyValue[] {
  return secrets
    .filter((x) => x.name)
    .map((x) => ({ id: `sec_${x.id}`, key: x.name, value: x.value, enabled: true, secret: true }));
}
