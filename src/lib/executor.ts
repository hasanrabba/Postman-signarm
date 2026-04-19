import type { Auth, KeyValue, SignalRequest, SignalResponse, TestResult } from "./types";
import { applyAuth } from "./auth";
import { resolveKV, resolveVars, type VarScope } from "./variables";
import { runScript } from "./scripting";

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
  envUpdates: Record<string, string>;
  globalUpdates: Record<string, string>;
  collectionUpdates: Record<string, string>;
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

  const scope: VarScope = {
    global: toKV(preGlobal),
    environment: toKV(preEnv),
    collection: toKV(preCol),
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

  // 3. send via proxy
  const payload = serializeForProxy(final);
  const t0 = performance.now();
  let response: SignalResponse;
  try {
    const res = await fetch(opts.proxyUrl ?? "/api/proxy", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    response = (await res.json()) as SignalResponse;
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
    logs: [...pre.logs, ...post.logs],
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
    formdata: body.formdata,
    graphql: body.graphql && {
      query: resolveVars(body.graphql.query, scope),
      variables: resolveVars(body.graphql.variables, scope),
    },
  };
}

function serializeForProxy(req: SignalRequest) {
  const url = buildUrl(req);
  const headers: Record<string, string> = {};
  for (const h of req.headers) if (h.enabled && h.key) headers[h.key] = h.value;
  let body: string | undefined;
  const b = req.body;
  if (b.mode === "json" || b.mode === "text" || b.mode === "xml") body = b.raw;
  else if (b.mode === "form-urlencoded" && b.urlencoded) {
    body = b.urlencoded.filter((k) => k.enabled && k.key)
      .map((k) => `${encodeURIComponent(k.key)}=${encodeURIComponent(k.value)}`).join("&");
    if (!headers["Content-Type"] && !headers["content-type"])
      headers["Content-Type"] = "application/x-www-form-urlencoded";
  } else if (b.mode === "graphql" && b.graphql) {
    let variables: unknown = {};
    try { variables = b.graphql.variables ? JSON.parse(b.graphql.variables) : {}; } catch { /* noop */ }
    body = JSON.stringify({ query: b.graphql.query, variables });
    if (!headers["Content-Type"] && !headers["content-type"])
      headers["Content-Type"] = "application/json";
  }
  if (b.mode === "json" && body && !headers["Content-Type"] && !headers["content-type"]) {
    headers["Content-Type"] = "application/json";
  }
  return { method: req.method, url, headers, body };
}

function buildUrl(req: SignalRequest): string {
  const q = req.params.filter((p) => p.enabled && p.key)
    .map((p) => `${encodeURIComponent(p.key)}=${encodeURIComponent(p.value)}`).join("&");
  return q ? `${req.url}${req.url.includes("?") ? "&" : "?"}${q}` : req.url;
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
