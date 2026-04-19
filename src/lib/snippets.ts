import type { SignalRequest } from "./types";
import { applyAuth } from "./auth";
import { toCurl } from "./curl";

export type SnippetLang = "curl" | "fetch" | "node-fetch" | "python-requests" | "go" | "httpie";

export function generateSnippet(request: SignalRequest, lang: SnippetLang): string {
  const req = applyAuth(request);
  switch (lang) {
    case "curl": return toCurl(req);
    case "fetch": return fetchSnippet(req);
    case "node-fetch": return fetchSnippet(req, true);
    case "python-requests": return pythonSnippet(req);
    case "go": return goSnippet(req);
    case "httpie": return httpieSnippet(req);
  }
}

function bodyString(req: SignalRequest): string | undefined {
  const b = req.body;
  if (b.mode === "none") return undefined;
  if (b.mode === "json" || b.mode === "text" || b.mode === "xml") return b.raw || "";
  if (b.mode === "form-urlencoded") {
    return (b.urlencoded ?? [])
      .filter((k) => k.enabled && k.key)
      .map((k) => `${encodeURIComponent(k.key)}=${encodeURIComponent(k.value)}`)
      .join("&");
  }
  if (b.mode === "graphql") {
    let variables: unknown = {};
    try { variables = b.graphql?.variables ? JSON.parse(b.graphql.variables) : {}; } catch { /* noop */ }
    return JSON.stringify({ query: b.graphql?.query || "", variables });
  }
  return undefined;
}

function urlWithQuery(req: SignalRequest): string {
  const q = req.params.filter((p) => p.enabled && p.key)
    .map((p) => `${encodeURIComponent(p.key)}=${encodeURIComponent(p.value)}`).join("&");
  return q ? `${req.url}${req.url.includes("?") ? "&" : "?"}${q}` : req.url;
}

function fetchSnippet(req: SignalRequest, node = false): string {
  const headers: Record<string, string> = {};
  for (const h of req.headers) if (h.enabled && h.key) headers[h.key] = h.value;
  const body = bodyString(req);
  const init: Record<string, unknown> = { method: req.method, headers };
  if (body !== undefined) init.body = body;
  const lines = [
    node ? "import fetch from 'node-fetch';" : "",
    `const res = await fetch(${JSON.stringify(urlWithQuery(req))}, ${JSON.stringify(init, null, 2)});`,
    "const text = await res.text();",
    "console.log(res.status, text);",
  ].filter(Boolean);
  return lines.join("\n");
}

function pythonSnippet(req: SignalRequest): string {
  const headers: Record<string, string> = {};
  for (const h of req.headers) if (h.enabled && h.key) headers[h.key] = h.value;
  const body = bodyString(req);
  return [
    "import requests",
    `url = ${JSON.stringify(urlWithQuery(req))}`,
    `headers = ${JSON.stringify(headers)}`,
    body !== undefined ? `data = ${JSON.stringify(body)}` : "",
    `resp = requests.request(${JSON.stringify(req.method)}, url, headers=headers${body !== undefined ? ", data=data" : ""})`,
    "print(resp.status_code, resp.text)",
  ].filter(Boolean).join("\n");
}

function goSnippet(req: SignalRequest): string {
  const body = bodyString(req);
  const lines = [
    "package main",
    "",
    "import (",
    "    \"fmt\"",
    "    \"io\"",
    body !== undefined ? "    \"strings\"" : "",
    "    \"net/http\"",
    ")",
    "",
    "func main() {",
    body !== undefined
      ? `    body := strings.NewReader(${JSON.stringify(body)})`
      : "    var body io.Reader = nil",
    `    req, _ := http.NewRequest(${JSON.stringify(req.method)}, ${JSON.stringify(urlWithQuery(req))}, body)`,
  ];
  for (const h of req.headers) {
    if (h.enabled && h.key) lines.push(`    req.Header.Set(${JSON.stringify(h.key)}, ${JSON.stringify(h.value)})`);
  }
  lines.push(
    "    resp, err := http.DefaultClient.Do(req)",
    "    if err != nil { panic(err) }",
    "    defer resp.Body.Close()",
    "    data, _ := io.ReadAll(resp.Body)",
    "    fmt.Println(resp.StatusCode, string(data))",
    "}"
  );
  return lines.filter(Boolean).join("\n");
}

function httpieSnippet(req: SignalRequest): string {
  const parts: string[] = ["http", req.method, `'${urlWithQuery(req)}'`];
  for (const h of req.headers) if (h.enabled && h.key) parts.push(`${h.key}:${h.value}`);
  const body = bodyString(req);
  if (body) parts.push(`<<< ${JSON.stringify(body)}`);
  return parts.join(" ");
}
