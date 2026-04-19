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

/** Visual mask for display — replaces the whole value with dots. */
export function maskValue(value: string): string {
  if (!value) return "";
  const len = Math.min(value.length, 12);
  return "•".repeat(len);
}
