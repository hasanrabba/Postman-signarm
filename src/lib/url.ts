/**
 * Append a query string to a URL, keeping it in front of any fragment.
 *
 * Appending blindly turns "http://x/p#frag" into "http://x/p#frag?a=1", where
 * the params are part of the fragment and never reach the server. Three copies
 * of this logic had drifted apart — the sender, the cURL exporter and the
 * snippet generators — so it lives here now.
 */
export function appendQuery(url: string, query: string): string {
  if (!query) return url;
  const [base, fragment] = splitFragment(url);
  return `${base}${base.includes("?") ? "&" : "?"}${query}${fragment}`;
}

/** Split a URL into the part before the fragment and the fragment itself. */
export function splitFragment(url: string): [string, string] {
  const i = url.indexOf("#");
  return i === -1 ? [url, ""] : [url.slice(0, i), url.slice(i)];
}

/**
 * Percent-encode a query-string VALUE, leaving alone the characters RFC 3986
 * allows there unencoded and that no parser reinterprets: `= ? / : @ , $ ;`.
 *
 * encodeURIComponent escapes all of them, so `?sig=abc=def` went out as
 * `?sig=abc%3Ddef` and `?b=1?2` as `?b=1%3F2` — the same thing to a server
 * that decodes, but not the bytes the user pasted, and enough to break a
 * signed URL. `&` and `#` stay escaped because they end the value, and `+`
 * stays escaped because a form parser reads a bare one as a space.
 *
 * The key is still escaped in full: an `=` there really would split the pair.
 */
const QUERY_SAFE: Record<string, string> = {
  "3D": "=", "3F": "?", "2F": "/", "3A": ":", "40": "@", "2C": ",", "24": "$", "3B": ";",
};
export function encodeQueryValue(v: string): string {
  // Every %XX in the output was produced by encodeURIComponent — a literal
  // percent is already %25 — so this cannot rewrite the user's own text.
  return encodeURIComponent(v).replace(/%(3D|3F|2F|3A|40|2C|24|3B)/g, (_, h) => QUERY_SAFE[h]);
}

/** The query string a request's param rows produce. */
export function buildQuery(rows: { key: string; value: string; enabled: boolean }[]): string {
  return rows
    .filter((p) => p.enabled && p.key)
    .map((p) => `${encodeURIComponent(p.key)}=${encodeQueryValue(p.value)}`)
    .join("&");
}
