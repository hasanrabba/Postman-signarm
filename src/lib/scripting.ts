import type { KeyValue, SignalRequest, SignalResponse, TestResult } from "./types";

export interface ScriptContext {
  request: SignalRequest;
  response?: SignalResponse;
  env: Record<string, string>;
  global: Record<string, string>;
  collection: Record<string, string>;
}

export interface ScriptOutput {
  logs: string[];
  tests: TestResult[];
  setEnv: Record<string, string>;
  setGlobal: Record<string, string>;
  setCollection: Record<string, string>;
}

/**
 * Runs a user script in a constrained scope. We deliberately use `new Function`
 * with a curated `sg` API object rather than exposing the full window, and we
 * never expose fetch/XHR from scripts. This is best-effort isolation — it's
 * not a security sandbox against malicious scripts that you author yourself.
 */
export function runScript(script: string, ctx: ScriptContext): ScriptOutput {
  const output: ScriptOutput = {
    logs: [],
    tests: [],
    setEnv: {},
    setGlobal: {},
    setCollection: {},
  };

  if (!script || !script.trim()) return output;

  const jsonBody = (() => {
    if (!ctx.response) return undefined;
    try { return JSON.parse(ctx.response.body); } catch { return undefined; }
  })();

  const sg = {
    request: {
      method: ctx.request.method,
      url: ctx.request.url,
      headers: headersAsObject(ctx.request.headers),
      body: ctx.request.body,
    },
    response: ctx.response && {
      status: ctx.response.status,
      statusText: ctx.response.statusText,
      headers: ctx.response.headers,
      body: ctx.response.body,
      json: () => jsonBody,
      text: () => ctx.response?.body,
    },
    env: {
      get: (k: string) => ctx.env[k],
      set: (k: string, v: string) => { output.setEnv[k] = String(v); },
    },
    globals: {
      get: (k: string) => ctx.global[k],
      set: (k: string, v: string) => { output.setGlobal[k] = String(v); },
    },
    collection: {
      get: (k: string) => ctx.collection[k],
      set: (k: string, v: string) => { output.setCollection[k] = String(v); },
    },
    test: (name: string, fn: () => void) => {
      try { fn(); output.tests.push({ name, passed: true }); }
      catch (e) {
        output.tests.push({ name, passed: false, error: (e as Error).message });
      }
    },
    expect: (actual: unknown) => ({
      toEqual: (b: unknown) => {
        if (JSON.stringify(actual) !== JSON.stringify(b))
          throw new Error(`expected ${JSON.stringify(actual)} to equal ${JSON.stringify(b)}`);
      },
      toBe: (b: unknown) => {
        if (actual !== b) throw new Error(`expected ${JSON.stringify(actual)} to be ${JSON.stringify(b)}`);
      },
      toContain: (needle: string) => {
        if (typeof actual !== "string" || !actual.includes(needle))
          throw new Error(`expected ${JSON.stringify(actual)} to contain ${JSON.stringify(needle)}`);
      },
      toBeTruthy: () => { if (!actual) throw new Error(`expected truthy, got ${JSON.stringify(actual)}`); },
      toBeBetween: (lo: number, hi: number) => {
        const n = Number(actual);
        if (!(n >= lo && n <= hi)) throw new Error(`expected ${n} to be between ${lo} and ${hi}`);
      },
    }),
    console: {
      log: (...args: unknown[]) => output.logs.push(args.map(fmt).join(" ")),
    },
  };

  try {
    // Minimal shadowing: prevent easy access to globals.
    const fn = new Function(
      "sg", "request", "response",
      "const window=undefined;const document=undefined;const globalThis=undefined;" +
      "const fetch=undefined;const XMLHttpRequest=undefined;const console=sg.console;" +
      script
    );
    fn(sg, sg.request, sg.response);
  } catch (e) {
    output.logs.push(`[script error] ${(e as Error).message}`);
  }
  return output;
}

function headersAsObject(h: KeyValue[]) {
  const out: Record<string, string> = {};
  for (const kv of h) if (kv.enabled && kv.key) out[kv.key] = kv.value;
  return out;
}

function fmt(x: unknown): string {
  if (typeof x === "string") return x;
  try { return JSON.stringify(x); } catch { return String(x); }
}
