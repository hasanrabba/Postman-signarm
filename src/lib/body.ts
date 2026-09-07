/**
 * Turning response bytes into something the viewer can show.
 *
 * Three decisions live here, and each one used to be wrong in a way that
 * destroyed data before the user ever saw it:
 *
 *  1. Is this text?  The old list enumerated exact subtypes, so every media
 *     type that uses a structured suffix — application/soap+xml (all of SOAP),
 *     application/hal+json, application/atom+xml, image/svg+xml — was declared
 *     binary and hidden behind the "Binary response" card.
 *  2. What encoding?  Everything was decoded as UTF-8 regardless of the
 *     charset the server declared, so a `text/plain; charset=iso-8859-1`
 *     response came back with every accented character replaced by U+FFFD and
 *     no way to recover the bytes.
 *  3. What if there is no content-type at all?  An empty type counted as text,
 *     so a PNG served without one was run through a UTF-8 decoder, mangled,
 *     and shown as mojibake — with no Download button, because nothing knew it
 *     was binary.
 *
 * The rule now: decode only what we can decode faithfully, and when we can't,
 * keep the bytes. A base64 body the user can download beats a text body that
 * silently isn't what the server sent.
 */

/** Subtypes that are text even though they are not under `text/`. */
const TEXT_SUBTYPES = new Set([
  "json", "xml", "javascript", "ecmascript", "x-javascript",
  "x-www-form-urlencoded", "graphql", "graphql-response",
  "yaml", "x-yaml", "x-ndjson", "ndjson", "jsonl",
  "csv", "x-csv", "sql", "x-sh", "x-httpd-php", "rtf",
]);

/** Whole types that are text regardless of subtype. */
const TEXT_TYPES = new Set(["text"]);

/** Exact types that are text but fit no rule above. */
const TEXT_EXACT = new Set(["image/svg+xml", "application/x-empty"]);

export function contentTypeOf(ct: string): { type: string; subtype: string } {
  const mime = (ct || "").split(";")[0].trim().toLowerCase();
  const slash = mime.indexOf("/");
  if (slash === -1) return { type: mime, subtype: "" };
  return { type: mime.slice(0, slash), subtype: mime.slice(slash + 1) };
}

/**
 * Is a body with this content-type readable as text?
 *
 * Note what is NOT here: an empty content-type. It used to count as text,
 * which is how a PNG served without a type got destroyed. An absent type
 * means "we don't know", and the caller sniffs the bytes instead.
 */
export function isTextContentType(ct: string): boolean {
  const { type, subtype } = contentTypeOf(ct);
  if (!type || !subtype) return false;
  if (TEXT_EXACT.has(`${type}/${subtype}`)) return true;
  if (TEXT_TYPES.has(type)) return true;
  if (type !== "application") return false;
  if (TEXT_SUBTYPES.has(subtype)) return true;
  // Structured suffixes, RFC 6839: anything+json, anything+xml. This is the
  // rule an enumeration can never keep up with — every vendor media type in
  // the wild is application/vnd.something+json.
  const plus = subtype.lastIndexOf("+");
  return plus !== -1 && TEXT_SUBTYPES.has(subtype.slice(plus + 1));
}

/** The charset parameter, lowercased, or "" when the server named none. */
export function charsetOf(ct: string): string {
  // Quoted per RFC 2045: charset="utf-8" is as legal as charset=utf-8.
  const m = /;\s*charset\s*=\s*("([^"]*)"|([^;\s]+))/i.exec(ct || "");
  return (m?.[2] ?? m?.[3] ?? "").trim().toLowerCase();
}

function decodeWith(buf: Uint8Array, label: string, fatal: boolean): string | null {
  try {
    // ignoreBOM defaults to false, which is what we want: a UTF-8 BOM in front
    // of a JSON body is consumed here rather than left to break JSON.parse.
    return new TextDecoder(label, { fatal }).decode(buf);
  } catch {
    return null;
  }
}

export interface DecodedBody {
  body: string;
  bodyIsBase64: boolean;
}

/**
 * Decode a response body, or keep it as base64 when decoding would lie.
 *
 * `toBase64` is passed in because the server has Buffer and the browser does
 * not; neither should be imported into the other's bundle.
 */
export function decodeBody(
  buf: Uint8Array,
  ct: string,
  toBase64: (b: Uint8Array) => string
): DecodedBody {
  const binary = (): DecodedBody => ({ body: toBase64(buf), bodyIsBase64: true });

  if (buf.byteLength === 0) return { body: "", bodyIsBase64: false };

  if (!ct.trim()) {
    // No content-type: guess from the bytes rather than assuming. Strict UTF-8
    // is a good detector — real binary formats fail it within a few bytes, and
    // a text body that passes it is genuinely text.
    const text = decodeWith(buf, "utf-8", true);
    return text === null ? binary() : { body: text, bodyIsBase64: false };
  }

  if (!isTextContentType(ct)) return binary();

  const charset = charsetOf(ct);
  if (!charset || charset === "utf-8" || charset === "utf8") {
    // Declared UTF-8 but not actually UTF-8 is a real thing (mislabelled
    // latin-1 pages). Lossy-decode it rather than refuse — the content-type
    // said text, and U+FFFD in a page of otherwise-fine HTML is not the same
    // harm as silently mangling a binary download.
    return { body: decodeWith(buf, "utf-8", false) ?? toBase64(buf), bodyIsBase64: false };
  }

  const text = decodeWith(buf, charset, false);
  // An encoding label the runtime does not know. Keeping the bytes means the
  // user can still download them; decoding as UTF-8 anyway would throw them
  // away and show nonsense.
  return text === null ? binary() : { body: text, bodyIsBase64: false };
}

/**
 * Response headers as an ordered list of pairs, duplicates intact.
 *
 * `Headers.forEach` folds repeats into one comma-joined value — except
 * Set-Cookie, which it yields once per cookie, so writing into a plain object
 * kept only the LAST one. A login that sets a session cookie and then a CSRF
 * cookie showed only the CSRF cookie, and the session cookie was gone from the
 * app entirely: not in the pane, not in history, nowhere.
 */
export function headerPairs(h: Headers, strip: Set<string>): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  h.forEach((v, k) => {
    const lk = k.toLowerCase();
    if (strip.has(lk)) return;
    // Handled below, in full, from getSetCookie().
    if (lk === "set-cookie") return;
    out.push([k, v]);
  });
  const cookies = typeof h.getSetCookie === "function" ? h.getSetCookie() : [];
  for (const c of cookies) out.push(["set-cookie", c]);
  return out;
}

/**
 * The flat map scripts read as `sg.response.headers`.
 *
 * Repeats are joined the way the HTTP spec joins them — with a comma — with
 * one exception: Set-Cookie values may themselves contain commas (`Expires=Wed,
 * 09 Jun 2027`), so joining them that way produces something no one can split
 * again. They are joined with a newline instead.
 */
export function headerMap(pairs: Array<[string, string]>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of pairs) {
    const sep = k.toLowerCase() === "set-cookie" ? "\n" : ", ";
    out[k] = k in out ? `${out[k]}${sep}${v}` : v;
  }
  return out;
}
