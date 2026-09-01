import type { KeyValue } from "./types";

const TOKEN = /\{\{\s*([^}\s]+)\s*\}\}/g;

export type VarScope = {
  global?: KeyValue[];
  environment?: KeyValue[];
  collection?: KeyValue[];
  /** Unlocked vault secrets. Outrank environments so a secret is used in
   *  preference to a plaintext variable of the same name. */
  secrets?: KeyValue[];
  data?: Record<string, string>;
};

export function resolveVars(input: string, scope: VarScope): string {
  if (!input) return input;
  // Null-prototype: otherwise `{{toString}}`, `{{constructor}}` and friends
  // resolve to inherited Object.prototype members instead of being left alone.
  const table: Record<string, string> = Object.create(null);
  const add = (list?: KeyValue[]) => {
    if (!list) return;
    for (const kv of list) {
      if (kv.enabled !== false && kv.key) table[kv.key] = kv.value;
    }
  };
  // priority (lowest to highest): global → collection → environment → secrets → data
  add(scope.global);
  add(scope.collection);
  add(scope.environment);
  add(scope.secrets);
  if (scope.data) Object.assign(table, scope.data);

  return input.replace(TOKEN, (_, name) => {
    if (name in table) return table[name];
    // built-ins
    if (name === "$timestamp") return String(Math.floor(Date.now() / 1000));
    if (name === "$isoTimestamp") return new Date().toISOString();
    if (name === "$randomUUID") return crypto.randomUUID();
    if (name === "$randomInt") return String(Math.floor(Math.random() * 1e6));
    return `{{${name}}}`;
  });
}

export function resolveKV(list: KeyValue[], scope: VarScope): KeyValue[] {
  return list.map((kv) => ({
    ...kv,
    key: resolveVars(kv.key, scope),
    value: resolveVars(kv.value, scope),
  }));
}
