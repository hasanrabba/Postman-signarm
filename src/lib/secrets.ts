import type { Auth, KeyValue, SignalRequest } from "./types";

/**
 * Header names whose values we treat as secret by default. Matching is
 * case-insensitive and also matches substrings for the wildcard entries.
 */
const SECRET_HEADER_EXACT = new Set([
  "authorization", "cookie", "set-cookie", "proxy-authorization",
  "x-api-key", "x-auth-token", "x-access-token", "x-csrf-token",
  "api-key", "apikey",
]);

const SECRET_HEADER_SUBSTRINGS = [
  "secret", "password", "passwd", "credential", "bearer",
];

const SECRET_PARAM_SUBSTRINGS = [
  "token", "api_key", "apikey", "access_key", "accesskey",
  "secret", "password", "signature",
];

/** Should this header name be treated as sensitive by default? */
export function isSecretHeaderName(name: string): boolean {
  const n = name.toLowerCase();
  if (SECRET_HEADER_EXACT.has(n)) return true;
  return SECRET_HEADER_SUBSTRINGS.some((s) => n.includes(s));
}

/** Should this URL query parameter name be treated as sensitive? */
export function isSecretParamName(name: string): boolean {
  const n = name.toLowerCase();
  return SECRET_PARAM_SUBSTRINGS.some((s) => n.includes(s));
}

/**
 * Mark sensitive headers/params/body variables as secret. Used when
 * importing a cURL command so the user's tokens don't land in the UI as
 * plaintext. Does not redact — the value stays on the KeyValue, but is
 * flagged so the UI masks it.
 */
export function autoFlagSecretsOnRequest(req: SignalRequest): SignalRequest {
  const flag = (list: KeyValue[], predicate: (k: string) => boolean) =>
    list.map((kv) => (predicate(kv.key) ? { ...kv, secret: true } : kv));
  return {
    ...req,
    headers: flag(req.headers, isSecretHeaderName),
    params: flag(req.params, isSecretParamName),
    body: {
      ...req.body,
      urlencoded: req.body.urlencoded
        ? flag(req.body.urlencoded, isSecretParamName)
        : req.body.urlencoded,
    },
  };
}

const REDACTED = "[REDACTED]";

/** Return a copy of the request with secret fields replaced by [REDACTED].
 *  Used for history display and logging — never feed this back into a send. */
export function redactRequest(req: SignalRequest): SignalRequest {
  const redactKV = (list: KeyValue[], autoDetect: (n: string) => boolean) =>
    list.map((kv) =>
      kv.secret || autoDetect(kv.key)
        ? { ...kv, value: REDACTED }
        : kv
    );
  const auth = redactAuth(req.auth);
  return {
    ...req,
    headers: redactKV(req.headers, isSecretHeaderName),
    params: redactKV(req.params, isSecretParamName),
    auth,
    body: {
      ...req.body,
      raw: redactBodyString(req.body.raw ?? ""),
      urlencoded: req.body.urlencoded
        ? redactKV(req.body.urlencoded, isSecretParamName)
        : req.body.urlencoded,
    },
  };
}

function redactAuth(auth: Auth): Auth {
  switch (auth.type) {
    case "basic":
      return { ...auth, basic: { username: auth.basic?.username ?? "", password: auth.basic?.password ? REDACTED : "" } };
    case "bearer":
      return { ...auth, bearer: { token: auth.bearer?.token ? REDACTED : "" } };
    case "apikey":
      return { ...auth, apikey: {
        key: auth.apikey?.key ?? "", value: auth.apikey?.value ? REDACTED : "",
        in: auth.apikey?.in ?? "header",
      } };
    case "oauth2":
      return { ...auth, oauth2: {
        accessToken: auth.oauth2?.accessToken ? REDACTED : "",
        tokenType: auth.oauth2?.tokenType,
      } };
    default:
      return auth;
  }
}

/**
 * Redact obvious bearer tokens / api keys / passwords that appear inside
 * raw JSON or form bodies. We only target common key names to avoid
 * mangling unrelated strings.
 */
function redactBodyString(raw: string): string {
  if (!raw) return raw;
  return raw.replace(
    /"(password|passwd|secret|token|api_?key|access_?key)"\s*:\s*"([^"]*)"/gi,
    (_m, k) => `"${k}":"${REDACTED}"`
  );
}

/**
 * Inverse of `redactRequest`: put real values back into an entry that was
 * redacted before it was persisted.
 *
 * History deliberately stores a redacted copy so credentials never reach
 * localStorage, which also means an entry cannot be re-sent as-is. When the
 * request it came from still exists, its current values are matched by key
 * and restored; anything with no match keeps the [REDACTED] placeholder so
 * the gap is visible rather than silently empty.
 */
export function restoreRedacted(entry: SignalRequest, source?: SignalRequest): SignalRequest {
  if (!source) return entry;

  const byKey = (list: KeyValue[]) => {
    const m = new Map<string, string>();
    for (const kv of list) if (kv.key) m.set(kv.key.toLowerCase(), kv.value);
    return m;
  };
  const restoreList = (list: KeyValue[], srcList: KeyValue[]): KeyValue[] => {
    const src = byKey(srcList);
    return list.map((kv) => {
      if (kv.value !== REDACTED) return kv;
      const real = src.get(kv.key.toLowerCase());
      return real === undefined ? kv : { ...kv, value: real };
    });
  };

  return {
    ...entry,
    headers: restoreList(entry.headers, source.headers),
    params: restoreList(entry.params, source.params),
    auth: restoreAuth(entry.auth, source.auth),
    body: {
      ...entry.body,
      raw: restoreBodyString(entry.body.raw ?? "", source.body.raw ?? ""),
      urlencoded: entry.body.urlencoded && source.body.urlencoded
        ? restoreList(entry.body.urlencoded, source.body.urlencoded)
        : entry.body.urlencoded,
    },
  };
}

function restoreAuth(auth: Auth, source: Auth): Auth {
  if (auth.type !== source.type) return auth;
  switch (auth.type) {
    case "basic":
      return auth.basic?.password === REDACTED
        ? { ...auth, basic: { username: auth.basic.username, password: source.basic?.password ?? "" } }
        : auth;
    case "bearer":
      return auth.bearer?.token === REDACTED
        ? { ...auth, bearer: { token: source.bearer?.token ?? "" } }
        : auth;
    case "apikey":
      return auth.apikey?.value === REDACTED
        ? { ...auth, apikey: { ...auth.apikey, value: source.apikey?.value ?? "" } }
        : auth;
    case "oauth2":
      return auth.oauth2?.accessToken === REDACTED
        ? { ...auth, oauth2: { ...auth.oauth2, accessToken: source.oauth2?.accessToken ?? "" } }
        : auth;
    default:
      return auth;
  }
}

/** Put back the values `redactBodyString` masked, matching on the same keys. */
function restoreBodyString(raw: string, sourceRaw: string): string {
  if (!raw.includes(REDACTED) || !sourceRaw) return raw;
  const KEYS = /"(password|passwd|secret|token|api_?key|access_?key)"\s*:\s*"([^"]*)"/gi;
  const src = new Map<string, string>();
  for (const m of sourceRaw.matchAll(KEYS)) src.set(m[1].toLowerCase(), m[2]);
  return raw.replace(KEYS, (whole, k: string, v: string) => {
    if (v !== REDACTED) return whole;
    const real = src.get(k.toLowerCase());
    return real === undefined ? whole : `"${k}":"${real}"`;
  });
}

/** Visual mask for display — replaces the whole value with dots. */
export function maskValue(value: string): string {
  if (!value) return "";
  const len = Math.min(value.length, 12);
  return "•".repeat(len);
}
