import type { Auth, KeyValue, SignalRequest, SignalResponse, TestResult } from "./types";
import { applyAuth } from "./auth";
import { resolveKV, resolveVars, type VarScope } from "./variables";
import { runScript } from "./scripting";
import { sendProxy } from "./transport";

function resolveAuth(auth: Auth, scope: VarScope): Auth {
  const r = (s?: string) => (s === undefined ? s : resolveVars(s, scope));
  switch (auth.type) {
    case "basic":
      return { ...auth, basic: { username: r(auth.basic?.username) ?? "", password: r(auth.basic?.password) ?? "" } };
    case "bearer":
      return { ...auth, bearer: { token: r(auth.bearer?.token) ?? "" } };
    case "apikey":
      return { ...auth, apikey: { key: r(auth.apikey?.key) ?? "", value: r(auth.apikey?.value) ?? "", in: auth.apikey?.in ?? "header" } };
    case "oauth2":
      return { ...auth, oauth2: { accessToken: r(auth.oauth2?.accessToken) ?? "", tokenType: r(auth.oauth2?.tokenType) } };
    default:
      return auth;
  }
}

export interface ExecuteOptions {
  scope: VarScope;
  /** URL of the server-side proxy route. */
  proxyUrl?: string;
}

export interface ExecuteResult {
  request: SignalRequest;         // post-resolve, post-auth request actually sent
  response: SignalResponse;
  tests: TestResult[];
  logs: string[];
  /** A null value means the script asked for the variable to be removed. */
  envUpdates: Record<string, string | null>;
  globalUpdates: Record<string, string | null>;
  collectionUpdates: Record<string, string | null>;
}

export async function executeRequest(
  original: SignalRequest,
  opts: ExecuteOptions
): Promise<ExecuteResult> {
  // 1. pre-request script (may set env/globals that affect the request)
  const preEnv = { ...toTable(opts.scope.environment) };
  const preGlobal = { ...toTable(opts.scope.global) };
  const preCol = { ...toTable(opts.scope.collection) };
  const pre = runScript(original.preRequestScript, {
    request: original,
    env: preEnv,
    global: preGlobal,
    collection: preCol,
  });
  Object.assign(preEnv, pre.setEnv);
  Object.assign(preGlobal, pre.setGlobal);
  Object.assign(preCol, pre.setCollection);

  // The env/global/collection tables are rebuilt so pre-request script writes
  // are visible to resolution; every other scope is carried through untouched.
  const scope: VarScope = {
    global: toKV(preGlobal),
    environment: toKV(preEnv),
    collection: toKV(preCol),
    secrets: opts.scope.secrets,
    data: opts.scope.data,
  };

  // 2. resolve variables and apply auth
  const resolved: SignalRequest = {
    ...original,
    url: resolveVars(original.url, scope),
    params: resolveKV(original.params, scope),
    headers: resolveKV(original.headers, scope),
    body: resolveBody(original.body, scope),
    auth: resolveAuth(original.auth, scope),
  };
  const final = applyAuth(resolved);

  // 3. send via transport — serializeForProxy may auto-add Content-Type etc.;
  // fold those back into `final.headers` so consumers can see the actual
  // headers that were sent (history, UI, test harness).
  const { warnings, ...payload } = serializeForProxy(final);
  mergeHeadersInto(final, payload.headers);
  const t0 = performance.now();
  let response: SignalResponse;
  try {
    if (opts.proxyUrl) {
      // Explicit override (used by the Node e2e harness).
      const res = await fetch(opts.proxyUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      response = (await res.json()) as SignalResponse;
    } else {
      response = await sendProxy(payload);
    }
    response.elapsedMs = Math.round(performance.now() - t0);
  } catch (e) {
    response = {
      status: 0,
      statusText: "Network Error",
      headers: {},
      body: "",
      elapsedMs: Math.round(performance.now() - t0),
      sizeBytes: 0,
      error: (e as Error).message,
    };
  }

  // 4. post-response tests
  const post = runScript(original.testScript, {
    request: final,
    response,
    env: preEnv,
    global: preGlobal,
    collection: preCol,
  });

  return {
    request: final,
    response,
    tests: post.tests,
    logs: [...pre.logs, ...warnings, ...post.logs],
    envUpdates: { ...pre.setEnv, ...post.setEnv },
    globalUpdates: { ...pre.setGlobal, ...post.setGlobal },
    collectionUpdates: { ...pre.setCollection, ...post.setCollection },
  };
}

function resolveBody(body: SignalRequest["body"], scope: VarScope): SignalRequest["body"] {
  return {
    ...body,
    raw: body.raw ? resolveVars(body.raw, scope) : body.raw,
    urlencoded: body.urlencoded ? resolveKV(body.urlencoded, scope) : body.urlencoded,
    formdata: body.formdata?.map((kv) => ({
      ...kv,
      key: resolveVars(kv.key, scope),
      value: resolveVars(kv.value, scope),
    })),
    graphql: body.graphql && {
      query: resolveVars(body.graphql.query, scope),
      variables: resolveVars(body.graphql.variables, scope),
    },
  };
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const lower = name.toLowerCase();
  return Object.keys(headers).some((k) => k.toLowerCase() === lower);
}

function multipartBody(fields: { key: string; value: string; type?: "text" | "file"; fileName?: string }[]) {
  const boundary = "----SignalBoundary" + Math.random().toString(16).slice(2);
  const lines: string[] = [];
  // A field name is interpolated straight into a quoted Content-Disposition
  // parameter, so a name containing a quote or a newline used to break out of
  // it and forge extra parameters. Browsers percent-encode exactly these
  // three characters; do the same.
  const q = (s: string) =>
    s.replace(/\r/g, "%0D").replace(/\n/g, "%0A").replace(/"/g, "%22");
  for (const f of fields) {
    lines.push(`--${boundary}`);
    if (f.type === "file" && f.fileName) {
      lines.push(`Content-Disposition: form-data; name="${q(f.key)}"; filename="${q(f.fileName)}"`);
      lines.push("Content-Type: application/octet-stream");
      lines.push("");
      lines.push(`[file contents for ${f.fileName} omitted — attach via browser in a future release]`);
    } else {
      lines.push(`Content-Disposition: form-data; name="${q(f.key)}"`);
      lines.push("");
      lines.push(f.value);
    }
  }
  lines.push(`--${boundary}--`);
  lines.push("");
  return { body: lines.join("\r\n"), boundary };
}

function serializeForProxy(req: SignalRequest) {
  const warnings: string[] = [];
  const url = buildUrl(req);
  const headers: Record<string, string> = {};
  // Two rows with the same name used to collapse — the second simply
  // overwrote the first and its value went out with no warning. The wire
  // format carries one value per name, so combine them the way HTTP does:
  // RFC 9110 joins repeated field lines with ", ", and RFC 6265 wants a
  // single Cookie header whose crumbs are separated by "; ".
  for (const h of req.headers) {
    if (!h.enabled || !h.key) continue;
    const existing = Object.keys(headers).find((k) => k.toLowerCase() === h.key.toLowerCase());
    if (existing === undefined) {
      headers[h.key] = h.value;
    } else {
      const sep = existing.toLowerCase() === "cookie" ? "; " : ", ";
      headers[existing] = `${headers[existing]}${sep}${h.value}`;
    }
  }
  let body: string | undefined;
  const b = req.body;
  if (b.mode === "json" || b.mode === "text" || b.mode === "xml") {
    body = b.raw ?? "";
    if (b.mode === "json" && body && !hasHeader(headers, "content-type")) {
      headers["Content-Type"] = "application/json";
    }
    if (b.mode === "xml" && body && !hasHeader(headers, "content-type")) {
      headers["Content-Type"] = "application/xml";
    }
  } else if (b.mode === "form-urlencoded" && b.urlencoded) {
    body = b.urlencoded.filter((k) => k.enabled && k.key)
      .map((k) => `${encodeURIComponent(k.key)}=${encodeURIComponent(k.value)}`).join("&");
    if (!hasHeader(headers, "content-type"))
      headers["Content-Type"] = "application/x-www-form-urlencoded";
  } else if (b.mode === "form-data" && b.formdata && b.formdata.length > 0) {
    const fields = b.formdata.filter((k) => k.enabled && k.key);
    if (fields.length > 0) {
      const { body: bodyStr, boundary } = multipartBody(fields);
      body = bodyStr;
      if (!hasHeader(headers, "content-type"))
        headers["Content-Type"] = `multipart/form-data; boundary=${boundary}`;
    }
  } else if (b.mode === "graphql" && b.graphql) {
    let variables: unknown = {};
    // A typo in the variables JSON used to be swallowed here: the request
    // went out with "variables":{} and the only symptom was the server
    // complaining about a missing argument. Send it the same way, but say so.
    try {
      variables = b.graphql.variables ? JSON.parse(b.graphql.variables) : {};
    } catch (e) {
      warnings.push(
        `[warn] the GraphQL variables are not valid JSON (${(e as Error).message}) — sent as {} instead.`
      );
    }
    body = JSON.stringify({ query: b.graphql.query, variables });
    if (!hasHeader(headers, "content-type"))
      headers["Content-Type"] = "application/json";
  }
  return { method: req.method, url, headers, body, warnings };
}

function mergeHeadersInto(req: SignalRequest, actual: Record<string, string>): void {
  const lowerExisting = new Set(
    req.headers.filter((h) => h.enabled && h.key).map((h) => h.key.toLowerCase())
  );
  for (const [k, v] of Object.entries(actual)) {
    if (lowerExisting.has(k.toLowerCase())) continue;
    req.headers.push({ id: `auto_${k}`, key: k, value: v, enabled: true });
  }
}

function buildUrl(req: SignalRequest): string {
  const q = req.params.filter((p) => p.enabled && p.key)
    .map((p) => `${encodeURIComponent(p.key)}=${encodeURIComponent(p.value)}`).join("&");
  if (!q) return req.url;
  // The query has to go before the fragment. Appending blindly turned
  // "http://x/page#section" into "http://x/page#section?a=1", where the
  // params are part of the fragment and never reach the server at all.
  const hash = req.url.indexOf("#");
  const base = hash === -1 ? req.url : req.url.slice(0, hash);
  const fragment = hash === -1 ? "" : req.url.slice(hash);
  return `${base}${base.includes("?") ? "&" : "?"}${q}${fragment}`;
}

function toKV(table: Record<string, string>): KeyValue[] {
  return Object.entries(table).map(([key, value]) => ({
    id: `v_${key}`, key, value, enabled: true,
  }));
}
function toTable(list?: KeyValue[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const kv of list ?? []) if (kv.enabled !== false && kv.key) out[kv.key] = kv.value;
  return out;
}
