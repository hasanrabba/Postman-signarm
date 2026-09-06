import { uid } from "./id";
import type { KeyValue, Method, SignalRequest } from "./types";
import { base64Utf8, emptyAuth } from "./auth";
import { autoFlagSecretsOnRequest } from "./secrets";
import { appendQuery, buildQuery, splitFragment } from "./url";
import { defaultContentType } from "./executor";
import { shellArg } from "./shell";

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

/**
 * Inside double quotes a backslash only escapes these; before anything else it
 * is a literal backslash the shell passes through. Dropping it turned a JSON
 * body pasted in double quotes — `-d "{\"text\":\"a\\nb\"}"` — into
 * `{"text":"anb"}`: still valid JSON, so nothing warned that the value had
 * changed. Windows paths lost their separators the same way.
 */
const DQ_ESCAPES = new Set(['"', "\\", "$", "`", "\n"]);

/**
 * The escapes bash decodes inside $'...' — what Chrome's "Copy as cURL (bash)"
 * emits whenever a value holds a newline or a non-ASCII character.
 *
 * It works in BYTES, not characters: bash writes `é` as `\xc3\xa9`, two bytes
 * of UTF-8, and turning each into its own code point would send four bytes
 * where curl sends two.
 */
function decodeAnsiC(body: string): string {
  const bytes: number[] = [];
  const utf8 = new TextEncoder();
  const push = (str: string) => { for (const b of utf8.encode(str)) bytes.push(b); };

  for (let i = 0; i < body.length; i++) {
    if (body[i] !== "\\" || i + 1 >= body.length) { push(body[i]); continue; }
    const c = body[++i];
    switch (c) {
      case "n": bytes.push(0x0a); break;
      case "t": bytes.push(0x09); break;
      case "r": bytes.push(0x0d); break;
      case "a": bytes.push(0x07); break;
      case "b": bytes.push(0x08); break;
      case "e": case "E": bytes.push(0x1b); break;
      case "f": bytes.push(0x0c); break;
      case "v": bytes.push(0x0b); break;
      case "\\": bytes.push(0x5c); break;
      case "'": bytes.push(0x27); break;
      case '"': bytes.push(0x22); break;
      case "?": bytes.push(0x3f); break;
      case "x": {
        const m = /^[0-9a-fA-F]{1,2}/.exec(body.slice(i + 1));
        if (m) { bytes.push(parseInt(m[0], 16)); i += m[0].length; } else push("x");
        break;
      }
      case "u": case "U": {
        const width = c === "u" ? 4 : 8;
        const m = new RegExp(`^[0-9a-fA-F]{1,${width}}`).exec(body.slice(i + 1));
        if (m) { push(String.fromCodePoint(parseInt(m[0], 16))); i += m[0].length; } else push(c);
        break;
      }
      default: {
        const m = /^[0-7]{1,3}/.exec(c + body.slice(i + 1));
        if (m) { bytes.push(parseInt(m[0], 8) & 0xff); i += m[0].length - 1; }
        else { push("\\" + c); }
      }
    }
  }
  // Anything that is not valid UTF-8 comes back as replacement characters,
  // which is still closer than mangling every byte into its own code point.
  return new TextDecoder("utf-8").decode(new Uint8Array(bytes));
}

/** Shell-style tokenizer that understands single/double quotes, $'...' quoting,
 *  escapes, and line continuations. */
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
      // $'...' is ANSI-C quoting and $"..." is locale translation; Chrome's
      // "Copy as cURL (bash)" emits the first whenever a value holds a newline
      // or a non-ASCII character. Both used to fall through as a literal `$`
      // followed by an ordinary quoted string, so `$'a\nb'` was sent as the
      // five characters `$a\nb` — and a `$'...'` URL never left at all.
      if (c === "$" && (s[i + 1] === "'" || s[i + 1] === '"')) {
        const ansi = s[i + 1] === "'";
        const quote = s[i + 1];
        i += 2;
        let raw = "";
        while (i < s.length && s[i] !== quote) {
          if (s[i] === "\\" && i + 1 < s.length) { raw += s[i] + s[i + 1]; i += 2; }
          else raw += s[i++];
        }
        i++;
        buf += ansi ? decodeAnsiC(raw) : raw;
        continue;
      }
      if (c === '"' || c === "'") {
        const quote = c; i++;
        while (i < s.length && s[i] !== quote) {
          if (quote === '"' && s[i] === "\\" && i + 1 < s.length) {
            // Keep the backslash unless the shell would have eaten it.
            if (DQ_ESCAPES.has(s[i + 1])) buf += s[i + 1];
            else buf += s[i] + s[i + 1];
            i += 2;
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

/** Short flags that take a value, which curl allows to be written attached. */
const SHORT_FLAGS_WITH_ARG = new Set([
  "X", "d", "H", "F", "u", "A", "e", "b", "T", "o", "w", "m", "r",
  "U", "x", "K", "E", "c", "D", "C", "y", "Y", "z", "t", "P",
]);

/**
 * Expand combined short flags. `-sLX POST` → `-s -L -X POST`.
 *
 * curl also lets the value ride along attached to the flag, and people write
 * it that way constantly: `-XPOST`, `-d'{"a":1}'`, `-H'Accept: x'`. Splitting
 * every letter turned `-XPOST` into `-X -P -O -S -T`, so `-X` took the literal
 * `-P` as its method, found it was not one, and the request imported as a GET
 * with no body and nothing to say why. Everything after the first letter that
 * takes a value is that value.
 */
function expandShortFlags(tokens: string[]): string[] {
  const out: string[] = [];
  for (const t of tokens) {
    if (!t.startsWith("--") && /^-[A-Za-z]/.test(t) && t.length > 2) {
      const letters = t.slice(1);
      let consumed = false;
      for (let i = 0; i < letters.length; i++) {
        const l = letters[i];
        if (SHORT_FLAGS_WITH_ARG.has(l)) {
          out.push(`-${l}`);
          const rest = letters.slice(i + 1);
          if (rest) out.push(rest);
          consumed = true;
          break;
        }
        if (!SHORT_FLAGS_NO_ARG.has(l) && !/^[A-Za-z]$/.test(l)) break;
        out.push(`-${l}`);
      }
      if (consumed) continue;
      // Every letter was a no-arg flag; they are all already pushed.
      if (letters.split("").every((l) => /^[A-Za-z]$/.test(l))) continue;
      out.length -= letters.length;
      out.push(t);
      continue;
    }
    out.push(t);
  }
  return out;
}

/**
 * Flags we do not act on but that always consume the next token. Without
 * this, `curl --proxy http://proxy:8080 https://real/` treated the proxy as
 * the URL, because the generic unknown-flag heuristic refuses to swallow a
 * value that looks like a URL.
 */
const FLAGS_WITH_ARG = new Set([
  "-x", "--proxy", "--proxy-user", "-U", "--noproxy",
  "-o", "--output", "-w", "--write-out", "-m", "--max-time",
  "--connect-timeout", "--retry", "--retry-delay", "--retry-max-time",
  "--resolve", "--interface", "--limit-rate", "--max-redirs",
  "--cacert", "--capath", "--cert", "--key", "--cert-type", "--key-type",
  "--dns-servers", "--unix-socket", "--range", "-r",
  "--trace", "--trace-ascii", "--stderr", "--cookie-jar", "-c",
  "--proto", "--proto-default", "--proto-redir", "--request-target",
  "--alt-svc", "--hsts", "--doh-url", "--etag-save", "--etag-compare",
  "--ciphers", "--crlfile", "--pinnedpubkey", "--pubkey", "--engine",
  "--dns-interface", "--dns-ipv4-addr", "--dns-ipv6-addr",
  "--local-port", "--max-filesize", "--continue-at", "-C",
  "--speed-limit", "-Y", "--speed-time", "-y", "--keepalive-time",
  "--expect100-timeout", "--happy-eyeballs-timeout-ms",
  "--login-options", "--mail-from", "--mail-rcpt", "--netrc-file",
  "--proxy-header", "--sasl-authzid", "--service-name", "--socks4",
  "--socks4a", "--socks5", "--socks5-hostname", "--tftp-blksize",
  "--tlsuser", "--tlspassword", "--tlsauthtype", "--tls-max",
  "--libcurl", "--url-query", "--ftp-port", "-P", "--krb", "--config",
]);

/**
 * Long flags that take no argument. Without this list they fell to the
 * unknown-flag heuristic, which swallows the following token unless it starts
 * with `-` or `http` — so `curl -O example.com/f.zip` ate its own URL and
 * imported a request with an empty URL field and no error to explain it.
 */
const FLAGS_NO_ARG = new Set([
  "-O", "--remote-name", "-4", "--ipv4", "-6", "--ipv6",
  "--http1.0", "--http1.1", "--http2", "--http2-prior-knowledge", "--http3",
  "--path-as-is", "--raw", "-g", "--globoff", "--anyauth", "--basic",
  "--tlsv1", "--tlsv1.0", "--tlsv1.1", "--tlsv1.2", "--tlsv1.3",
  "--ssl", "--ssl-reqd", "--ssl-no-revoke", "--ssl-allow-beast",
  "--tcp-nodelay", "--tcp-fastopen", "--no-alpn", "--no-npn",
  "--no-keepalive", "--no-sessionid", "--no-progress-meter",
  "--create-dirs", "--fail-early", "--fail-with-body", "--location-trusted",
  "--parallel", "-Z", "--parallel-immediate", "--progress-bar", "-#",
  "--remote-header-name", "-J", "--remote-time", "-R",
  "--retry-connrefused", "--retry-all-errors", "--styled-output",
  "--suppress-connect-headers", "--trace-time", "--xattr", "--disable", "-q",
  "--list-only", "-l", "--append", "-a", "--use-ascii", "-B", "--crlf",
  "--ignore-content-length", "--netrc", "-n", "--netrc-optional",
  "--post301", "--post302", "--post303", "--proxytunnel", "-p",
  "--proxy-anyauth", "--proxy-basic", "--proxy-digest", "--proxy-negotiate",
  "--proxy-ntlm", "--proxy-insecure", "--proxy-ssl-allow-beast",
  "--ftp-pasv", "--disable-eprt", "--disable-epsv", "--ftp-create-dirs",
  "--ftp-skip-pasv-ip", "--cert-status", "--false-start", "--form-escape",
]);

/**
 * Does this token look like somewhere to send a request, rather than a flag's
 * value? The unknown-flag heuristic used to accept anything not starting with
 * `-` or `http`, which is every URL written without a scheme.
 */
function looksLikeHost(t: string): boolean {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return true;
  return /^(localhost|\[[0-9a-fA-F:]+\])(:\d+)?([/?#]|$)/i.test(t)
    || /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+(:\d+)?([/?#]|$)/.test(t);
}

/**
 * curl talks HTTP to a host written without a scheme. Signal upgraded every
 * one to HTTPS, which is right for `curl example.com` and wrong for
 * `curl localhost:3000/api` — the dev server the user is working against,
 * which then could not be reached at all.
 */
function withScheme(t: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return t;
  const host = t.split(/[/?#]/)[0].replace(/:\d+$/, "").toLowerCase();
  const local =
    host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") ||
    host === "0.0.0.0" || host === "[::1]" || /^127\./.test(host) ||
    !host.includes(".");
  return `${local ? "http" : "https"}://${t}`;
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
  let getWithData = false;
  let headOnly = false;
  let dataFlag = false;
  let negotiatedAuth = false;

  const addHeader = (raw: string | undefined) => {
    if (!raw) return;
    const colon = raw.indexOf(":");
    if (colon <= 0) return;
    const key = raw.slice(0, colon).trim();
    const value = raw.slice(colon + 1).trim();
    if (!key) return;
    headers.push({ id: uid("h"), key, value, enabled: true });
  };

  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    // A command truncated mid-copy ends on a flag. Returning undefined here
    // instead of walking off the end is what lets each case decide to ignore
    // itself, rather than pushing the literal string "undefined" into a body.
    const next = (): string | undefined => (i + 1 < tokens.length ? tokens[++i] : undefined);
    switch (t) {
      case "-X": case "--request": {
        const m = next()?.toUpperCase();
        if (m && METHODS.includes(m as Method)) { method = m as Method; explicitMethod = true; }
        break;
      }
      case "-H": case "--header":
        addHeader(next());
        break;
      // `--data-raw` exists precisely so a leading @ stays literal: posting
      // "@channel deploy is green" went out as "[file:channel deploy is green]".
      case "--data-raw": {
        const v = next();
        if (v === undefined) break;
        dataFlag = true;
        bodyRaw += (bodyRaw ? "&" : "") + v;
        bodyMode = "text";
        if (!explicitMethod) method = "POST";
        break;
      }
      case "-d": case "--data": case "--data-binary": case "--data-ascii": {
        let v = next();
        if (v === undefined) break;
        if (v.startsWith("@")) v = `[file:${v.slice(1)}]`;
        dataFlag = true;
        bodyRaw += (bodyRaw ? "&" : "") + v;
        bodyMode = "text";
        if (!explicitMethod) method = "POST";
        break;
      }
      // `curl --json '{...}'` is shorthand for a POST with both the content
      // type and the accept header. It was unknown, so the JSON payload was
      // eaten as if it were the flag's value and the request imported as a
      // bare GET.
      case "--json": {
        const v = next();
        if (v === undefined) break;
        bodyRaw += v;
        bodyMode = "json";
        if (!explicitMethod) method = "POST";
        if (!headers.some((h) => h.key.toLowerCase() === "content-type"))
          headers.push({ id: uid("h"), key: "Content-Type", value: "application/json", enabled: true });
        if (!headers.some((h) => h.key.toLowerCase() === "accept"))
          headers.push({ id: uid("h"), key: "Accept", value: "application/json", enabled: true });
        break;
      }
      // `curl -T file host/path` is a PUT of that file. It imported as a GET
      // with no body, so the upload silently disappeared.
      case "-T": case "--upload-file": {
        const v = next();
        if (v === undefined) break;
        bodyRaw = `[file:${v}]`;
        bodyMode = "text";
        if (!explicitMethod) { method = "PUT"; explicitMethod = true; }
        break;
      }
      case "--oauth2-bearer": {
        const v = next();
        if (v) headers.push({ id: uid("h"), key: "Authorization", value: `Bearer ${v}`, enabled: true });
        break;
      }
      case "--data-urlencode": {
        const raw = next();
        if (raw === undefined) break;
        let encoded: string;
        const eq = raw.indexOf("=");
        // `=content` is curl's spelling for "encode this, it has no field
        // name". Treating the empty name as a real one sent `=hello%20world`
        // where curl sends `hello+world`.
        if (eq === 0) {
          encoded = encodeURIComponent(raw.slice(1));
        } else if (eq > 0) {
          encoded = encodeURIComponent(raw.slice(0, eq)) + "=" + encodeURIComponent(raw.slice(eq + 1));
        } else {
          encoded = encodeURIComponent(raw);
        }
        bodyRaw += (bodyRaw ? "&" : "") + encoded;
        bodyMode = "form-urlencoded";
        isUrlEncoded = true;
        dataFlag = true;
        if (!explicitMethod) method = "POST";
        break;
      }
      case "-F": case "--form": case "--form-string": {
        const raw = next();
        if (raw === undefined) break;
        const eq = raw.indexOf("=");
        if (eq < 0) break;
        const key = raw.slice(0, eq);
        let value = raw.slice(eq + 1);
        let type: "text" | "file" = "text";
        let fileName: string | undefined;
        // `--form-string` is the spelling that keeps @ and < literal — it is
        // what you reach for to post a message starting with "@someone".
        if (t !== "--form-string" && (value.startsWith("@") || value.startsWith("<"))) {
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
      // These negotiate rather than send a credential outright, so the -u
      // secret must not become a Basic header. `--aws-sigv4` uses it as an
      // HMAC key and never transmits it; turning the pair into Basic auth put
      // a long-lived AWS secret access key on the wire in base64, to whatever
      // host the command targeted, and saved it in the request.
      case "--aws-sigv4": case "--negotiate": case "--ntlm": case "--ntlm-wb":
      case "--digest": case "--anyauth":
        negotiatedAuth = true;
        if (t === "--aws-sigv4") i++;
        break;
      // Everything after --next belongs to a second transfer curl performs
      // separately. Merging it into the request already being built aimed the
      // second request's method and body at the FIRST request's URL, so
      // `curl .../items --next -X DELETE .../items/1` sent DELETE to the whole
      // collection. Import the leading request and stop.
      case "--next":
        i = tokens.length;
        break;
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
        if (v) url = withScheme(v);
        break;
      }
      case "-G": case "--get":
        method = "GET"; explicitMethod = true; getWithData = true;
        break;
      // `curl -I` asks for headers only. It imported as a GET, so the
      // request downloaded the whole body it was meant to skip. `-X` still
      // wins, whichever order the two appear in, as it does in real curl.
      case "-I": case "--head":
        headOnly = true;
        break;
      // no-arg flags we can safely ignore
      case "--compressed": case "-L": case "--location":
      case "-k": case "--insecure": case "-s": case "--silent":
      case "-S": case "--show-error": case "-i": case "--include":
      case "-v": case "--verbose": case "-j": case "--junk-session-cookies":
      case "-f": case "--fail":
      case "-N": case "--no-buffer":
        break;
      default:
        if (FLAGS_NO_ARG.has(t)) break;
        if (FLAGS_WITH_ARG.has(t)) { i++; break; }
        if (t.startsWith("-")) {
          // Unknown flag; if the next token starts with `-` or we're at the end,
          // treat this as a no-arg flag. Otherwise skip its value too to avoid
          // accidentally treating the arg as the URL.
          // Never swallow something that looks like somewhere to send the
          // request: `curl -O example.com/f.zip` used to eat its own URL and
          // import a request with an empty URL and no error to explain it.
          const peek = tokens[i + 1];
          if (peek !== undefined && !peek.startsWith("-") && !looksLikeHost(peek)) i++;
          break;
        }
        if (!url && t && !t.startsWith("-")) url = withScheme(t);
    }
  }

  if (headOnly && !explicitMethod) method = "HEAD";

  // `curl https://user:pass@host/` sends Basic auth and drops the credentials
  // from the URL. Keeping them there meant the request could not be sent at
  // all: fetch() refuses a URL that carries credentials, so pressing Send
  // returned "Request cannot be constructed from a URL that includes
  // credentials" instead of the response curl gets.
  const withUserinfo = /^([a-z][a-z0-9+.-]*:\/\/)([^/?#@]+)@/i.exec(url);
  if (withUserinfo) {
    const [, scheme, credentials] = withUserinfo;
    const [user, pass] = splitOnce(credentials, ":");
    if (basicUser === undefined) {
      basicUser = credentials.includes(":")
        ? `${safeDecode(user)}:${safeDecode(pass)}`
        : safeDecode(user);
    }
    url = scheme + url.slice(withUserinfo[0].length);
  }

  if (basicUser && !negotiatedAuth) {
    // `curl -u alice` prompts for a password and sends `alice:`; without the
    // colon the header decodes to a username with no separator, which every
    // server rejects.
    const pair = basicUser.includes(":") ? basicUser : `${basicUser}:`;
    // btoa() alone throws on any code point above U+00FF, so `curl -u
    // user:пароль` aborted the whole import. RFC 7617 wants UTF-8 anyway.
    const token = base64Utf8(pair);
    headers.push({ id: uid("h"), key: "Authorization", value: `Basic ${token}`, enabled: true });
  }

  let liftedBody: KeyValue[] | null = null;

  // Detect content type to refine body mode.
  const ct = headers.find((h) => h.key.toLowerCase() === "content-type")?.value || "";
  if (bodyRaw && bodyMode !== "form-data") {
    const lowerCt = ct.toLowerCase();
    if (lowerCt.includes("application/json")) bodyMode = "json";
    else if (lowerCt.includes("application/x-www-form-urlencoded") || isUrlEncoded) {
      // Showing a body as key/value rows means re-serialising it from those
      // rows on every send. `-d 'plaintext'` is not a form, and came back out
      // as `plaintext=`; a body that is not made of named fields stays raw
      // text so its bytes go out the way curl sent them.
      liftedBody = liftPairs(bodyRaw);
      bodyMode = liftedBody ? "form-urlencoded" : "text";
    }
    else if (looksLikeJson(bodyRaw)) bodyMode = "json";
    else if (/^<\?xml|^<[a-zA-Z]/.test(bodyRaw.trim())) bodyMode = "xml";
  }


  // Extract query params from URL. The fragment is not part of the query —
  // splitting on "?" alone left the last param holding "1#section" — and
  // destructuring the split dropped everything after a second "?".
  const [beforeHash, fragment] = splitFragment(url);
  const qStart = beforeHash.indexOf("?");
  if (qStart >= 0) {
    const query = beforeHash.slice(qStart + 1);
    const lifted: KeyValue[] = [];
    for (const pair of query.split("&")) {
      if (!pair) continue;
      const [k, v] = splitOnce(pair, "=");
      lifted.push({
        id: uid("p"),
        key: safeDecode(k),
        value: safeDecode(v),
        enabled: true,
      });
    }
    // Lifting the query into the params table means rebuilding it from that
    // table on every send, and the rebuild is not always what came in:
    // `?q=a+b` went out as `?q=a%2Bb` (a literal plus where the command meant
    // a space), `?flag` gained an `=`, and `?x=1;y=2` came back percent
    // encoded. Only lift a query we can put back byte for byte; anything else
    // stays on the URL, where it is passed through untouched.
    if (buildQuery(lifted) === query) {
      url = beforeHash.slice(0, qStart) + fragment;
      params.push(...lifted);
    }
  }

  // `curl -G -d 'a=b'` sends a GET with a=b in the query string, not a GET
  // carrying a body. Keeping it as a body meant the server never saw it.
  if (getWithData && bodyRaw) {
    // Same rule as the URL's own query: only lift into the params table what
    // can be put back byte for byte. `-G -d 'flag'` gained an equals sign and
    // `-G -d 'q=a+b'` had its plus re-encoded.
    const lifted = liftPairs(bodyRaw);
    if (lifted) params.push(...lifted);
    else url = appendQuery(url, bodyRaw);
    bodyRaw = "";
    bodyMode = "none";
    isUrlEncoded = false;
  }

  // Real curl labels every -d body `application/x-www-form-urlencoded`,
  // whatever it holds. Signal sent no Content-Type at all, so a server that
  // dispatches on it saw an imported request arrive with none. Never over a
  // header the command set for itself, never over a detected mode that brings
  // its own type, and never on `-G`, which by now has moved the data into the
  // query string and has no body left to label.
  if (dataFlag && bodyRaw && bodyMode === "text" && !ct) {
    headers.push({
      id: uid("h"),
      key: "Content-Type",
      value: "application/x-www-form-urlencoded",
      enabled: true,
    });
  }

  const urlencoded: KeyValue[] = bodyMode === "form-urlencoded" ? (liftedBody ?? []) : [];

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

/**
 * Split an `&`-separated body or query into key/value rows, or return null if
 * showing it that way would change what goes on the wire.
 *
 * Rows are re-serialised on every send, so this only holds when every segment
 * is a named field AND rebuilding reproduces the original bytes. `-d
 * 'plaintext'` came back out as `plaintext=`, and `-d 'a=1+2'` as `a=1%2B2` —
 * a literal plus where curl's bytes mean a space, which is a different value
 * to every form parser.
 */
function liftPairs(raw: string): KeyValue[] | null {
  const pairs = raw.split("&").filter(Boolean);
  if (!pairs.length) return null;
  if (!pairs.every((p) => p.includes("=") && !p.startsWith("="))) return null;
  const rows = pairs.map((p) => {
    const [k, v] = splitOnce(p, "=");
    return { id: uid("u"), key: safeDecode(k), value: safeDecode(v), enabled: true };
  });
  return buildQuery(rows) === raw ? rows : null;
}

function looksLikeJson(s: string): boolean {
  const t = s.trim();
  if (!(t.startsWith("{") || t.startsWith("["))) return false;
  try { JSON.parse(t); return true; } catch { return false; }
}

export function toCurl(req: SignalRequest): string {
  const parts: string[] = ["curl"];
  // `-X HEAD` makes curl wait for a body that a HEAD response never sends, so
  // the exported command sat there until the user killed it. `-I` is the
  // spelling that works.
  if (req.method === "HEAD") parts.push("-I");
  else if (req.method !== "GET") parts.push(`-X ${req.method}`);
  const url = appendQuery(req.url, buildQuery(req.params));
  parts.push(shellArg(url));
  let hasContentType = false;
  for (const h of req.headers) {
    if (!h.enabled || !h.key) continue;
    if (h.key.toLowerCase() === "content-type") hasContentType = true;
    // The key shares the quoted argument with the value, so a quote in the
    // key used to close the string early and mangle the whole command.
    // `-H 'X: '` makes curl DROP the header rather than send it empty; the
    // trailing-semicolon spelling is the one that sends it.
    parts.push(h.value === ""
      ? `-H ${shellArg(`${h.key};`)}`
      : `-H ${shellArg(`${h.key}: ${h.value}`)}`);
  }
  const b = req.body;
  // curl sets its own type for -F and --data-urlencode; everything else has to
  // carry the type the app would have sent, or the command means something
  // different from the request it was copied from.
  if (!hasContentType && (b.mode === "json" || b.mode === "xml" || b.mode === "graphql")) {
    const auto = defaultContentType(b.mode);
    if (auto) parts.push(`-H ${shellArg(`Content-Type: ${auto}`)}`);
  }
  if (b.mode === "json" || b.mode === "text" || b.mode === "xml") {
    if (b.raw) parts.push(`--data-raw ${shellArg(b.raw)}`);
  } else if (b.mode === "form-urlencoded" && b.urlencoded) {
    for (const kv of b.urlencoded) {
      if (kv.enabled && kv.key) {
        parts.push(`--data-urlencode ${shellArg(`${kv.key}=${kv.value}`)}`);
      }
    }
  } else if (b.mode === "form-data" && b.formdata) {
    for (const kv of b.formdata) {
      if (!kv.enabled || !kv.key) continue;
      if (kv.type === "file") parts.push(`-F ${shellArg(`${kv.key}=@${kv.fileName ?? ""}`)}`);
      else parts.push(`-F ${shellArg(`${kv.key}=${kv.value}`)}`);
    }
  } else if (b.mode === "graphql" && b.graphql) {
    const payload = JSON.stringify({
      query: b.graphql.query,
      variables: safeJSON(b.graphql.variables),
    });
    parts.push(`--data-raw ${shellArg(payload)}`);
  }
  return parts.join(" \\\n  ");
}

function safeJSON(src: string) {
  try { return src ? JSON.parse(src) : {}; } catch { return {}; }
}
