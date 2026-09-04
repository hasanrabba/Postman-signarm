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
