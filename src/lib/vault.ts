import type { Secret } from "./types";

const STORAGE_KEY = "signal.vault.v1";

function getKey(passphrase: string): Promise<CryptoKey> {
  const enc = new TextEncoder();
  return crypto.subtle.importKey("raw", enc.encode(passphrase.padEnd(32, "\0").slice(0, 32)), "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function saveSecrets(secrets: Secret[], passphrase: string): Promise<void> {
  const key = await getKey(passphrase);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(JSON.stringify(secrets));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data);
  const payload = {
    iv: btoa(String.fromCharCode(...iv)),
    ct: btoa(String.fromCharCode(...new Uint8Array(ct))),
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
}

export async function loadSecrets(passphrase: string): Promise<Secret[]> {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return [];
  const { iv, ct } = JSON.parse(raw);
  const key = await getKey(passphrase);
  const ivBuf = Uint8Array.from(atob(iv), (c) => c.charCodeAt(0));
  const ctBuf = Uint8Array.from(atob(ct), (c) => c.charCodeAt(0));
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: ivBuf }, key, ctBuf);
  return JSON.parse(new TextDecoder().decode(plain));
}
