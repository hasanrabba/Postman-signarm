/**
 * Re-indenting a response body without changing what it says.
 *
 * Pretty-printing is a formatting job, and the old implementations both did it
 * by rebuilding the document from a parse, which is how they changed the
 * content:
 *
 *  - JSON went through `JSON.stringify(JSON.parse(body))`, so every number was
 *    decoded into a double and printed back from it. A Postgres bigint or a
 *    snowflake id — 9007199254740993 — was displayed as 9007199254740992, a
 *    different id, with nothing on screen to say so. 1e400 became `null`, so a
 *    field the server sent as a number read as absent. Duplicate keys lost one
 *    of the two values, and numeric-looking keys were reordered.
 *  - HTML/XML was reflowed with regexes whose depth counter never came back
 *    down for a void element (`<img>`, `<br>`, `<meta>`), so indentation grew
 *    with the NUMBER of such tags rather than the nesting: a 162KB gallery page
 *    became a 61MB string of mostly spaces, synchronously, during render.
 *
 * Both now re-indent the original text. Every character of content is copied
 * through verbatim; only whitespace between tokens is rewritten.
 */

/** Above this we do not reformat at all — see prettyJson/prettyXml. */
export const MAX_PRETTY_BYTES = 2 * 1024 * 1024;

export type PrettyResult = { text: string; note?: string };

/**
 * Re-indent JSON by walking its tokens, copying literals through untouched.
 *
 * Returns a `note` instead of throwing when it cannot: the old code swallowed
 * the failure with `catch {}`, so a truncated body or one behind a BOM looked
 * exactly like a body that needed no formatting, and ticking "pretty" appeared
 * to do nothing for no reason.
 */
export function prettyJson(src: string): PrettyResult {
  if (src.length > MAX_PRETTY_BYTES) {
    return { text: src, note: `Body is ${src.length} characters — shown unformatted.` };
  }
  const out: string[] = [];
  let depth = 0;
  let i = 0;
  const n = src.length;
  // Whether the innermost container is an object, so a "," inside an array
  // still breaks the line but a ":" only ever appears in an object.
  const stack: string[] = [];

  const nl = (d: number) => { out.push("\n"); out.push("  ".repeat(d)); };

  // Leading whitespace and a BOM are not content; drop them before deciding.
  while (i < n && (src[i] === "﻿" || /\s/.test(src[i]))) i++;
  if (i >= n) return { text: src };
  if (src[i] !== "{" && src[i] !== "[") {
    // A bare scalar (`true`, `12`, `"hi"`) is already as formatted as it gets.
    return { text: src.slice(i).trimEnd() };
  }

  while (i < n) {
    const c = src[i];

    if (c === '"') {
      // Copy the string literal byte for byte, escapes and all. Re-encoding it
      // is what turned "é" into a raw é and lone surrogates into U+FFFD.
      const start = i;
      i++;
      while (i < n) {
        if (src[i] === "\\") { i += 2; continue; }
        if (src[i] === '"') { i++; break; }
        i++;
      }
      if (i > n) return { text: src, note: "Body is not valid JSON — shown unformatted." };
      out.push(src.slice(start, i));
      continue;
    }

    if (c === "{" || c === "[") {
      stack.push(c);
      depth++;
      out.push(c);
      // Peek: an empty container stays on one line.
      let j = i + 1;
      while (j < n && /\s/.test(src[j])) j++;
      if (src[j] === (c === "{" ? "}" : "]")) {
        out.push(src[j]);
        stack.pop();
        depth--;
        i = j + 1;
        continue;
      }
      nl(depth);
      i++;
      continue;
    }

    if (c === "}" || c === "]") {
      stack.pop();
      depth = Math.max(0, depth - 1);
      nl(depth);
      out.push(c);
      i++;
      continue;
    }

    if (c === ",") { out.push(","); nl(depth); i++; continue; }
    if (c === ":") { out.push(": "); i++; continue; }
    if (/\s/.test(c)) { i++; continue; }

    // A number, true, false, null, or something that is none of those. Copy
    // the run verbatim — this is the whole point: 9007199254740993 stays
    // 9007199254740993, and 1.0 stays 1.0.
    const start = i;
    while (i < n && !/[\s,:{}[\]"]/.test(src[i])) i++;
    if (i === start) return { text: src, note: "Body is not valid JSON — shown unformatted." };
    out.push(src.slice(start, i));
  }

  if (depth !== 0 || stack.length !== 0) {
    return { text: src, note: "Body is not valid JSON (unclosed brackets) — shown unformatted." };
  }
  return { text: out.join("") };
}

/**
 * HTML elements that have no closing tag. Counting them as "open" is what made
 * indentation grow without bound on any real-world page.
 */
const VOID_ELEMENTS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link",
  "meta", "param", "source", "track", "wbr",
  // Not void, but their content is whitespace-significant and must not be
  // reflowed; handled separately below.
]);

/** Elements whose text content must survive byte for byte. */
const PRESERVE = new Set(["pre", "textarea", "script", "style", "code"]);

const MAX_DEPTH = 40;

/**
 * Re-indent XML/HTML.
 *
 * Only whitespace *between* tags is touched, and only where it is not
 * significant. Text content, CDATA, comments and the insides of <pre> are
 * copied through unchanged — the old version's unconditional
 * `replace(/>\s*</g, ">\n<")` deleted the space in `<p>hello <b>world</b></p>`,
 * so the pane read "helloworld".
 */
export function prettyXml(src: string): PrettyResult {
  if (src.length > MAX_PRETTY_BYTES) {
    return { text: src, note: `Body is ${src.length} characters — shown unformatted.` };
  }

  const out: string[] = [];
  let depth = 0;
  let i = 0;
  const n = src.length;
  let preserve = 0;
  let lastWasTag = false;

  const indent = () => "  ".repeat(Math.min(depth, MAX_DEPTH));
  const push = (s: string) => out.push(s);

  while (i < n) {
    if (src[i] !== "<") {
      const next = src.indexOf("<", i);
      const end = next === -1 ? n : next;
      const raw = src.slice(i, end);
      if (preserve > 0) {
        push(raw);
        lastWasTag = false;
      } else if (raw.trim()) {
        // Real text. Keep it on the line it belongs to, collapsed but never
        // emptied — the spaces between words are content.
        if (lastWasTag) push("\n" + indent());
        push(raw.trim());
        lastWasTag = false;
      }
      i = end;
      continue;
    }

    // A markup construct. Find its end, honouring the ones that can contain ">".
    let end: number;
    let kind: "comment" | "cdata" | "decl" | "tag";
    if (src.startsWith("<!--", i)) {
      kind = "comment";
      const close = src.indexOf("-->", i + 4);
      end = close === -1 ? n : close + 3;
    } else if (src.startsWith("<![CDATA[", i)) {
      kind = "cdata";
      const close = src.indexOf("]]>", i + 9);
      end = close === -1 ? n : close + 3;
    } else if (src.startsWith("<!", i) || src.startsWith("<?", i)) {
      kind = "decl";
      const close = src.indexOf(">", i);
      end = close === -1 ? n : close + 1;
    } else {
      kind = "tag";
      // Skip over quoted attribute values so `<a title="a > b">` is one tag.
      let j = i + 1;
      let quote = "";
      while (j < n) {
        const ch = src[j];
        if (quote) { if (ch === quote) quote = ""; }
        else if (ch === '"' || ch === "'") quote = ch;
        else if (ch === ">") break;
        j++;
      }
      end = Math.min(j + 1, n);
    }

    const tag = src.slice(i, end);
    i = end;

    if (kind !== "tag") {
      // CDATA and comments are content: never reflowed, never re-indented
      // inside. A certificate or a log inside CDATA came out re-indented.
      if (preserve === 0) push((out.length ? "\n" : "") + indent());
      push(tag);
      lastWasTag = true;
      continue;
    }

    const nameMatch = /^<\s*(\/?)\s*([A-Za-z_][\w.:-]*)/.exec(tag);
    const closing = nameMatch?.[1] === "/";
    const name = (nameMatch?.[2] ?? "").toLowerCase();
    const selfClosing = /\/\s*>$/.test(tag) || VOID_ELEMENTS.has(name);

    if (preserve > 0) {
      push(tag);
      if (PRESERVE.has(name)) preserve += closing ? -1 : selfClosing ? 0 : 1;
      lastWasTag = false;
      continue;
    }

    if (closing) depth = Math.max(0, depth - 1);
    push((out.length ? "\n" : "") + indent());
    push(tag);
    if (!closing && !selfClosing) {
      depth++;
      if (PRESERVE.has(name)) preserve = 1;
    }
    lastWasTag = true;
  }

  return { text: out.join("").replace(/^\n/, "") };
}
