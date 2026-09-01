import { uid } from "./id";
import type { KeyValue, Method, SignalRequest } from "./types";
import { emptyAuth } from "./auth";
import { autoFlagSecretsOnRequest } from "./secrets";

const METHODS: Method[] = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

/** Split on the FIRST separator only — `sig=abc=def` is one pair, not two. */
function splitOnce(s: string, sep: string): [string, string] {
  const i = s.indexOf(sep);
  return i < 0 ? [s, ""] : [s.slice(0, i), s.slice(i + 1)];
}

/**
 * decodeURIComponent throws on malformed escapes (`%zz`), which would abort
 * the whole import. A value we cannot decode is far more useful passed
 * through verbatim than as an exception.
 */
function safeDecode(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

/** Shell-style tokenizer that understands single/double quotes, escapes, and line continuations. */
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
          if (quote === '"' && s[i] === "\\" && i + 1 < s.length) {
            buf += s[i + 1]; i += 2;
          } else {
            buf += s[i++];
          }
        }
        i++;
      } else if (c === "\\" && i + 1 < s.length) {
        buf += s[i + 1]; i += 2;
      } else {
        buf += s[i++];
      }
    }
    tokens.push(buf);
  }
  return tokens;
}

// Short flags that take no argument — can be combined like `-sL`.
const SHORT_FLAGS_NO_ARG = new Set([
  "k", "L", "s", "S", "G", "i", "v", "j", "I", "f", "N",
]);

/**
 * Expand combined short flags. `-sLX POST` → `-s -L -X POST`.
 * Only the LAST letter may take an argument.
 */
function expandShortFlags(tokens: string[]): string[] {
  const out: string[] = [];
  for (const t of tokens) {
    if (/^-[A-Za-z][A-Za-z]+$/.test(t)) {
      const letters = t.slice(1).split("");
      // If every letter is a no-arg flag, split them all.
      if (letters.every((l) => SHORT_FLAGS_NO_ARG.has(l))) {
        for (const l of letters) out.push(`-${l}`);
        continue;
      }
      // Otherwise, split all but the last letter (which may take the next token as arg).
      const last = letters.pop()!;
      for (const l of letters) out.push(`-${l}`);
      out.push(`-${last}`);
      continue;
    }
    out.push(t);
  }
  return out;
}

export function parseCurl(cmd: string): SignalRequest | null {
  let tokens = tokenize(cmd);
  if (!tokens.length) return null;
  if (tokens[0].toLowerCase() !== "curl") return null;
  tokens = expandShortFlags(tokens);

  let method: Method = "GET";
  let explicitMethod = false;
  let url = "";
  const headers: KeyValue[] = [];
  const params: KeyValue[] = [];
  const formdata: (KeyValue & { type?: "text" | "file"; fileName?: string })[] = [];
  let bodyRaw = "";
  let bodyMode: SignalRequest["body"]["mode"] = "none";
  let isUrlEncoded = false;
  let basicUser: string | undefined;

  const addHeader = (raw: string) => {
    const colon = raw.indexOf(":");
    if (colon <= 0) return;
    const key = raw.slice(0, colon).trim();
    const value = raw.slice(colon + 1).trim();
    if (!key) return;
    headers.push({ id: uid("h"), key, value, enabled: true });
  };

  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    const next = () => tokens[++i];
    switch (t) {
      case "-X": case "--request": {
        const m = next()?.toUpperCase();
        if (m && METHODS.includes(m as Method)) { method = m as Method; explicitMethod = true; }
        break;
      }
      case "-H": case "--header":
        addHeader(next());
        break;
      case "-d": case "--data": case "--data-raw": case "--data-binary": case "--data-ascii": {
        let v = next();
        if (v && v.startsWith("@")) v = `[file:${v.slice(1)}]`;
        bodyRaw += (bodyRaw ? "&" : "") + v;
        bodyMode = "text";
        if (!explicitMethod) method = "POST";
        break;
      }
      case "--data-urlencode": {
        const raw = next();
        let encoded: string;
        const eq = raw.indexOf("=");
        if (eq >= 0) {
          encoded = encodeURIComponent(raw.slice(0, eq)) + "=" + encodeURIComponent(raw.slice(eq + 1));
        } else {
          encoded = encodeURIComponent(raw);
        }
        bodyRaw += (bodyRaw ? "&" : "") + encoded;
        bodyMode = "form-urlencoded";
        isUrlEncoded = true;
        if (!explicitMethod) method = "POST";
        break;
      }
      case "-F": case "--form": case "--form-string": {
        const raw = next();
        const eq = raw.indexOf("=");
        if (eq < 0) break;
        const key = raw.slice(0, eq);
        let value = raw.slice(eq + 1);
        let type: "text" | "file" = "text";
        let fileName: string | undefined;
        if (value.startsWith("@") || value.startsWith("<")) {
          type = "file";
          fileName = value.slice(1);
          value = "";
        }
        formdata.push({ id: uid("fd"), key, value, enabled: true, type, fileName });
        bodyMode = "form-data";
        if (!explicitMethod) method = "POST";
        break;
      }
      case "-u": case "--user": {
        basicUser = next();
        break;
      }
      case "-A": case "--user-agent": {
        const v = next();
        if (v) headers.push({ id: uid("h"), key: "User-Agent", value: v, enabled: true });
        break;
      }
      case "-e": case "--referer": {
        const v = next();
        if (v) headers.push({ id: uid("h"), key: "Referer", value: v, enabled: true });
        break;
      }
      case "-b": case "--cookie": {
        const v = next();
        if (v) headers.push({ id: uid("h"), key: "Cookie", value: v, enabled: true });
        break;
      }
      case "--url": {
        const v = next();
        if (v) url = v;
        break;
      }
      case "-G": case "--get":
        method = "GET"; explicitMethod = true;
        break;
      // no-arg flags we can safely ignore
      case "--compressed": case "-L": case "--location":
      case "-k": case "--insecure": case "-s": case "--silent":
      case "-S": case "--show-error": case "-i": case "--include":
      case "-v": case "--verbose": case "-j": case "--junk-session-cookies":
      case "-I": case "--head": case "-f": case "--fail":
      case "-N": case "--no-buffer":
        break;
      default:
        if (t.startsWith("-")) {
          // Unknown flag; if the next token starts with `-` or we're at the end,
          // treat this as a no-arg flag. Otherwise skip its value too to avoid
          // accidentally treating the arg as the URL.
          const peek = tokens[i + 1];
          if (peek !== undefined && !peek.startsWith("-") && !peek.startsWith("http")) i++;
          break;
        }
        if (!url && /^https?:\/\//i.test(t)) {
          url = t;
        } else if (!url && t && !t.startsWith("-")) {
          // Bare host like `curl example.com` — default to https.
          url = /^[a-z]+:\/\//i.test(t) ? t : `https://${t}`;
        }
    }
  }

  if (basicUser) {
    // `curl -u alice` prompts for a password and sends `alice:`; without the
    // colon the header decodes to a username with no separator, which every
    // server rejects.
    const pair = basicUser.includes(":") ? basicUser : `${basicUser}:`;
    const token = typeof btoa !== "undefined"
      ? btoa(pair)
      : Buffer.from(pair, "utf8").toString("base64");
    headers.push({ id: uid("h"), key: "Authorization", value: `Basic ${token}`, enabled: true });
  }

  // Detect content type to refine body mode.
  const ct = headers.find((h) => h.key.toLowerCase() === "content-type")?.value || "";
  if (bodyRaw && bodyMode !== "form-data") {
    const lowerCt = ct.toLowerCase();
    if (lowerCt.includes("application/json")) bodyMode = "json";
    else if (lowerCt.includes("application/x-www-form-urlencoded") || isUrlEncoded) bodyMode = "form-urlencoded";
    else if (looksLikeJson(bodyRaw)) bodyMode = "json";
    else if (/^<\?xml|^<[a-zA-Z]/.test(bodyRaw.trim())) bodyMode = "xml";
  }

  // Extract query params from URL
  if (url.includes("?")) {
    const [base, q] = url.split("?");
    url = base;
    for (const pair of q.split("&")) {
      if (!pair) continue;
      const [k, v] = splitOnce(pair, "=");
      params.push({
        id: uid("p"),
        key: safeDecode(k),
        value: safeDecode(v),
        enabled: true,
      });
    }
  }

  const urlencoded: KeyValue[] = bodyMode === "form-urlencoded"
    ? bodyRaw.split("&").filter(Boolean).map((p) => {
        const [k, v] = splitOnce(p, "=");
        return {
          id: uid("u"),
          key: safeDecode(k),
          value: safeDecode(v),
          enabled: true,
        };
      })
    : [];

  return autoFlagSecretsOnRequest({
    id: uid("req"),
    name: url || "Imported from cURL",
    method,
    url,
    headers,
    params,
    auth: emptyAuth(),
    body: {
      mode: bodyMode,
      raw: bodyMode === "form-urlencoded" || bodyMode === "form-data" ? "" : bodyRaw,
      urlencoded,
      formdata,
      graphql: { query: "", variables: "" },
    },
    preRequestScript: "",
    testScript: "",
  });
}

function looksLikeJson(s: string): boolean {
  const t = s.trim();
  if (!(t.startsWith("{") || t.startsWith("["))) return false;
  try { JSON.parse(t); return true; } catch { return false; }
}

export function toCurl(req: SignalRequest): string {
  const parts: string[] = ["curl"];
  if (req.method !== "GET") parts.push(`-X ${req.method}`);
  const q = req.params
    .filter((p) => p.enabled && p.key)
    .map((p) => `${encodeURIComponent(p.key)}=${encodeURIComponent(p.value)}`)
    .join("&");
  const url = q ? `${req.url}${req.url.includes("?") ? "&" : "?"}${q}` : req.url;
  parts.push(`'${shellQuote(url)}'`);
  for (const h of req.headers) {
    if (!h.enabled || !h.key) continue;
    parts.push(`-H '${h.key}: ${shellQuote(h.value)}'`);
  }
  const b = req.body;
  if (b.mode === "json" || b.mode === "text" || b.mode === "xml") {
    if (b.raw) parts.push(`--data-raw '${shellQuote(b.raw)}'`);
  } else if (b.mode === "form-urlencoded" && b.urlencoded) {
    for (const kv of b.urlencoded) {
      if (kv.enabled && kv.key) {
        parts.push(`--data-urlencode '${kv.key}=${shellQuote(kv.value)}'`);
      }
    }
  } else if (b.mode === "form-data" && b.formdata) {
    for (const kv of b.formdata) {
      if (!kv.enabled || !kv.key) continue;
      if (kv.type === "file") parts.push(`-F '${kv.key}=@${kv.fileName ?? ""}'`);
      else parts.push(`-F '${kv.key}=${shellQuote(kv.value)}'`);
    }
  } else if (b.mode === "graphql" && b.graphql) {
    const payload = JSON.stringify({
      query: b.graphql.query,
      variables: safeJSON(b.graphql.variables),
    });
    parts.push(`--data-raw '${shellQuote(payload)}'`);
  }
  return parts.join(" \\\n  ");
}

/** Escape a value for single-quoted shell context. */
function shellQuote(v: string): string {
  return v.replace(/'/g, "'\\''");
}

function safeJSON(src: string) {
  try { return src ? JSON.parse(src) : {}; } catch { return {}; }
}
