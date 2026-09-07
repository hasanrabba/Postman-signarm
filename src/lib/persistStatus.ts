/**
 * Whether the last attempt to save to localStorage worked.
 *
 * zustand's persist middleware calls setItem and ignores what happens, so a
 * QuotaExceededError vanished: the persisted blob froze at whatever it held
 * before, every later change failed the same way, and the collection a user
 * created afterwards was on screen but gone after a reload. Nothing said so.
 *
 * Kept outside the store deliberately — it is written from inside the store's
 * own storage adapter, and setting store state from there would re-enter the
 * write that just failed.
 */
let failure: string | null = null;
const listeners = new Set<() => void>();

export function reportPersistFailure(message: string | null): void {
  if (failure === message) return;
  failure = message;
  for (const l of listeners) l();
}

export function subscribePersistFailure(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function persistFailure(): string | null {
  return failure;
}
