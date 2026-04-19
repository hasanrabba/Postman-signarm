import { uid } from "./id";
import type { KeyValue, Method, SignalRequest } from "./types";
import { emptyAuth } from "./auth";

const METHODS: Method[] = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

/** Minimal shell-style tokenizer that understands quotes and line continuations. */
function tokenize(cmd: string): string[] {
  const s = cmd.replace(/\\\r?\n/g, " ").trim();
  const tokens: string[] = [];
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i++;
    if (i >= s.length) break;
    let buf = "";
    while (i < s.length && !/\s/.test(s[i])) {
      const c = s[i];
      if (c === '"' || c === "'") {
        const quote = c; i++;
        while (i < s.length && s[i] !== quote) {
          if (s[i] === "\\" && i + 1 < s.length) { buf += s[i + 1]; i += 2; }
          else buf += s[i++];
        }
        i++;
      } else {
        buf += s[i++];
      }
    }
    tokens.push(buf);
  }
  return tokens;
}

export function parseCurl(cmd: string): SignalRequest | null {
  const tokens = tokenize(cmd);
  if (!tokens.length) return null;
  if (tokens[0].toLowerCase() !== "curl") return null;

  let method: Method = "GET";
  let url = "";
  const headers: KeyValue[] = [];
  const params: KeyValue[] = [];
  let bodyRaw = "";
  let bodyMode: SignalRequest["body"]["mode"] = "none";
  let isUrlEncoded = false;

  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    const next = () => tokens[++i];
    switch (t) {
      case "-X": case "--request": {
        const m = next().toUpperCase();
        if (METHODS.includes(m as Method)) method = m as Method;
        break;
      }
      case "-H": case "--header": {
        const h = next();
        const idx = h.indexOf(":");
        if (idx > 0) {
          headers.push({
            id: uid("h"),
            key: h.slice(0, idx).trim(),
            value: h.slice(idx + 1).trim(),
            enabled: true,
          });
        }
        break;
      }
      case "-d": case "--data": case "--data-raw": case "--data-binary": {
        bodyRaw += (bodyRaw ? "&" : "") + next();
        bodyMode = "text";
        if (method === "GET") method = "POST";
        break;
      }
      case "--data-urlencode": {
        bodyRaw += (bodyRaw ? "&" : "") + encodeURIComponent(next());
        bodyMode = "form-urlencoded";
        isUrlEncoded = true;
        if (method === "GET") method = "POST";
        break;
      }
      case "-u": case "--user":
      case "--compressed":
      case "-L": case "--location":
      case "-k": case "--insecure":
      case "-s": case "--silent":
        // tolerated but unused in MVP; consume param when needed
        if (t === "-u" || t === "--user") next();
        break;
      case "-G": case "--get":
        method = "GET";
        break;
      default:
        if (!url && (t.startsWith("http://") || t.startsWith("https://"))) {
          url = t;
        }
    }
  }

  // Detect JSON from content-type
  const ct = headers.find((h) => h.key.toLowerCase() === "content-type")?.value || "";
  if (bodyRaw) {
    if (ct.includes("application/json")) bodyMode = "json";
    else if (ct.includes("application/x-www-form-urlencoded") || isUrlEncoded) bodyMode = "form-urlencoded";
  }

  // Extract query params from URL
  if (url.includes("?")) {
    const [base, q] = url.split("?");
    url = base;
    for (const pair of q.split("&")) {
      const [k, v = ""] = pair.split("=");
      params.push({
        id: uid("p"),
        key: decodeURIComponent(k),
        value: decodeURIComponent(v),
        enabled: true,
      });
    }
  }

  return {
    id: uid("req"),
    name: url || "Imported from cURL",
    method,
    url,
    headers,
    params,
    auth: emptyAuth(),
    body: {
      mode: bodyMode,
      raw: bodyMode !== "form-urlencoded" ? bodyRaw : "",
      urlencoded: bodyMode === "form-urlencoded"
        ? bodyRaw.split("&").filter(Boolean).map((p) => {
            const [k, v = ""] = p.split("=");
            return {
              id: uid("u"),
              key: decodeURIComponent(k),
              value: decodeURIComponent(v),
              enabled: true,
            };
          })
        : [],
      formdata: [],
      graphql: { query: "", variables: "" },
    },
    preRequestScript: "",
    testScript: "",
  };
}

export function toCurl(req: SignalRequest): string {
  const parts: string[] = ["curl"];
  if (req.method !== "GET") parts.push(`-X ${req.method}`);
  const q = req.params
    .filter((p) => p.enabled && p.key)
    .map((p) => `${encodeURIComponent(p.key)}=${encodeURIComponent(p.value)}`)
    .join("&");
  const url = q ? `${req.url}${req.url.includes("?") ? "&" : "?"}${q}` : req.url;
  parts.push(`'${url}'`);
  for (const h of req.headers) {
    if (!h.enabled || !h.key) continue;
    parts.push(`-H '${h.key}: ${h.value.replace(/'/g, "'\\''")}'`);
  }
  const b = req.body;
  if (b.mode === "json" || b.mode === "text" || b.mode === "xml") {
    if (b.raw) parts.push(`--data-raw '${b.raw.replace(/'/g, "'\\''")}'`);
  } else if (b.mode === "form-urlencoded" && b.urlencoded) {
    for (const kv of b.urlencoded) {
      if (kv.enabled && kv.key) {
        parts.push(`--data-urlencode '${kv.key}=${kv.value}'`);
      }
    }
  } else if (b.mode === "graphql" && b.graphql) {
    const payload = JSON.stringify({
      query: b.graphql.query,
      variables: safeJSON(b.graphql.variables),
    });
    parts.push(`--data-raw '${payload.replace(/'/g, "'\\''")}'`);
  }
  return parts.join(" \\\n  ");
}

function safeJSON(src: string) {
  try { return src ? JSON.parse(src) : {}; } catch { return {}; }
}
