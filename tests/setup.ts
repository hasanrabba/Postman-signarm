import "@testing-library/jest-dom/vitest";

// jsdom doesn't ship crypto.randomUUID or subtle by default in older
// versions. Node's built-in webcrypto works fine; mirror it onto window.
if (typeof globalThis.crypto === "undefined" || !globalThis.crypto.subtle) {
  // @ts-expect-error — jsdom lets us overwrite.
  globalThis.crypto = (await import("node:crypto")).webcrypto;
}

// Minimal window.alert / confirm / prompt that return sensible defaults so
// tests don't hang on native dialogs.
if (typeof window !== "undefined") {
  window.alert = () => {};
  window.confirm = () => true;
  window.prompt = (_msg?: string, def?: string) => def ?? "";
}
