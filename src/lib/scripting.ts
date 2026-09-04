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
  /** A null value means "delete this variable" — see sg.env.unset. */
  setEnv: Record<string, string | null>;
  setGlobal: Record<string, string | null>;
  setCollection: Record<string, string | null>;
}

/**
 * Runs a user script in a constrained scope. We deliberately use `new Function`
 * with a curated `sg` API object rather than exposing the full window, and we
 * never expose fetch/XHR from scripts. This is best-effort isolation — it is
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

  const own = (o: Record<string, string>, k: string) =>
    Object.prototype.hasOwnProperty.call(o, k);

  const variables = {
    // Convenience namespace that checks env → globals → collection in order.
    // Own-property checks only: `in` would hand back Object.prototype members
    // (`toString`, `constructor`, …) for names the user never defined.
    get: (k: string) => {
      if (own(ctx.env, k)) return ctx.env[k];
      if (own(ctx.global, k)) return ctx.global[k];
      if (own(ctx.collection, k)) return ctx.collection[k];
      return undefined;
    },
  };

  // The same own-property guard variables.get already used. Reading these
  // tables with plain indexing handed back Object.prototype members, so
  // sg.env.get("toString") returned a function for a variable nobody had
  // defined. resolveVars guards against this with a null-prototype table;
  // these three accessors were the ones that missed it.
  const read = (table: Record<string, string>, k: string) =>
    own(table, k) ? table[k] : undefined;

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
      elapsedMs: ctx.response.elapsedMs,
      sizeBytes: ctx.response.sizeBytes,
      json: () => jsonBody,
      text: () => ctx.response?.body,
    },
    env: {
      get: (k: string) => read(ctx.env, k),
      set: (k: string, v: unknown) => { output.setEnv[k] = toStr(v); },
      unset: (k: string) => { output.setEnv[k] = null; },
    },
    globals: {
      get: (k: string) => read(ctx.global, k),
      set: (k: string, v: unknown) => { output.setGlobal[k] = toStr(v); },
      unset: (k: string) => { output.setGlobal[k] = null; },
    },
    collection: {
      get: (k: string) => read(ctx.collection, k),
      set: (k: string, v: unknown) => { output.setCollection[k] = toStr(v); },
      unset: (k: string) => { output.setCollection[k] = null; },
    },
    variables,
    test: (name: string, fn: () => void) => {
      try { fn(); output.tests.push({ name, passed: true }); }
      catch (e) {
        // `throw "nope"` is legal and used to produce a failed test with an
        // undefined message, so the UI showed a red tick and nothing else.
        const message = e instanceof Error ? e.message : safeFmt(e);
        output.tests.push({ name, passed: false, error: message || String(e) });
      }
    },
    expect: (actual: unknown) => ({
      toEqual: (b: unknown) => {
        if (!deepEqual(actual, b))
          throw new Error(`expected ${safeFmt(actual)} to equal ${safeFmt(b)}`);
      },
      toBe: (b: unknown) => {
        if (actual !== b) throw new Error(`expected ${safeFmt(actual)} to be ${safeFmt(b)}`);
      },
      toContain: (needle: string) => {
        if (typeof actual === "string") {
          if (!actual.includes(needle))
            throw new Error(`expected ${safeFmt(actual)} to contain ${safeFmt(needle)}`);
        } else if (Array.isArray(actual)) {
          if (!actual.includes(needle as unknown))
            throw new Error(`expected array to contain ${safeFmt(needle)}`);
        } else {
          throw new Error(`toContain: unsupported type ${typeof actual}`);
        }
      },
      toBeTruthy: () => { if (!actual) throw new Error(`expected truthy, got ${safeFmt(actual)}`); },
      toBeFalsy: () => { if (actual) throw new Error(`expected falsy, got ${safeFmt(actual)}`); },
      toBeBetween: (lo: number, hi: number) => {
        const n = Number(actual);
        if (!(n >= lo && n <= hi)) throw new Error(`expected ${n} to be between ${lo} and ${hi}`);
      },
      toMatch: (re: RegExp) => {
        if (typeof actual !== "string" || !re.test(actual))
          throw new Error(`expected ${safeFmt(actual)} to match ${re}`);
      },
    }),
    console: {
      log: (...args: unknown[]) => output.logs.push(args.map(safeFmt).join(" ")),
      warn: (...args: unknown[]) => output.logs.push("[warn] " + args.map(safeFmt).join(" ")),
      error: (...args: unknown[]) => output.logs.push("[error] " + args.map(safeFmt).join(" ")),
    },
  };

  try {
    const fn = new Function(
      "sg", "request", "response",
      '"use strict";' +
      "const window=undefined;const document=undefined;const globalThis=undefined;" +
      "const self=undefined;const top=undefined;const parent=undefined;" +
      "const fetch=undefined;const XMLHttpRequest=undefined;const WebSocket=undefined;" +
      "const importScripts=undefined;const console=sg.console;" +
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

function toStr(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  return safeFmt(v);
}

/**
 * JSON.stringify that survives circular references and BigInts. Returns
 * "[Unserializable]" as a last resort so a logging call never throws the
 * whole script.
 */
function safeFmt(x: unknown): string {
  if (x === null) return "null";
  if (x === undefined) return "undefined";
  if (typeof x === "string") return x;
  if (typeof x === "bigint") return `${x.toString()}n`;
  // Track the current ancestor chain, not every object ever seen. A set of
  // everything seen also flags the *second* appearance of a shared child —
  // logging { first: shared, second: shared } reported "[Circular]" for a
  // structure with no cycle in it at all.
  const ancestors: unknown[] = [];
  try {
    return JSON.stringify(x, function (this: unknown, _key, value) {
      if (typeof value === "bigint") return value.toString() + "n";
      if (typeof value !== "object" || value === null) return value;
      while (ancestors.length > 0 && ancestors[ancestors.length - 1] !== this) {
        ancestors.pop();
      }
      if (ancestors.includes(value)) return "[Circular]";
      ancestors.push(value);
      return value;
    }) ?? String(x);
  } catch {
    try { return String(x); } catch { return "[Unserializable]"; }
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((x, i) => deepEqual(x, b[i]));
  }
  const ka = Object.keys(a as object).sort();
  const kb = Object.keys(b as object).sort();
  if (ka.length !== kb.length) return false;
  if (ka.some((k, i) => k !== kb[i])) return false;
  return ka.every((k) =>
    deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])
  );
}
