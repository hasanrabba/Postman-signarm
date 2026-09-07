/**
 * Pretty-printing must not change what the response says.
 *
 * Both printers used to rebuild the document from a parse, which is how they
 * changed the content: JSON went through JSON.stringify(JSON.parse(body)), so
 * a snowflake id came out as a different number; HTML was reflowed with
 * regexes that deleted the spaces between words and whose depth counter never
 * came back down for an <img>.
 */
import { describe, test, expect } from "vitest";
import { prettyJson, prettyXml, MAX_PRETTY_BYTES } from "@/lib/pretty";

describe("JSON: every value survives the trip to the screen", () => {
  test("an id past 2^53 is the id the server sent", () => {
    // A Postgres bigint key, a Discord id, a snowflake. JSON.parse turns this
    // into a double and prints back ...992 — a different row in the database.
    expect(prettyJson('{"id":9007199254740993}').text).toContain("9007199254740993");
    expect(prettyJson('{"tweet_id":1234567890123456789}').text).toContain("1234567890123456789");
  });

  test("a number too big for a double is still a number, not null", () => {
    // JSON.parse gives Infinity, JSON.stringify writes null — so a balance the
    // server sent read as absent.
    expect(prettyJson('{"balance":1e400}').text).toContain("1e400");
    expect(prettyJson('{"balance":1e400}').text).not.toContain("null");
  });

  test("decimals keep the form the server chose", () => {
    const t = prettyJson('{"price":1.0,"pi":3.141592653589793238462643383279,"z":-0}').text;
    expect(t).toContain("1.0");
    expect(t).toContain("3.141592653589793238462643383279");
    expect(t).toContain("-0");
  });

  test("a duplicated key keeps both values", () => {
    expect(prettyJson('{"a":1,"a":2}').text).toBe('{\n  "a": 1,\n  "a": 2\n}');
  });

  test("numeric-looking keys stay in the order they arrived", () => {
    // JS objects reorder integer-like keys, so JSON.stringify shuffled them.
    expect(prettyJson('{"2":"b","1":"a","10":"c"}').text)
      .toBe('{\n  "2": "b",\n  "1": "a",\n  "10": "c"\n}');
  });

  test("string contents are copied verbatim, braces and escapes and all", () => {
    const src = '{"s":"a{b}[c], \\"q\\": v \\\\ \\u00e9 \\ud83d\\ude00"}';
    expect(prettyJson(src).text).toContain('"a{b}[c], \\"q\\": v \\\\ \\u00e9 \\ud83d\\ude00"');
  });

  test("nesting and empty containers are laid out sensibly", () => {
    expect(prettyJson('{"a":[],"b":{},"c":[1,{"d":2}]}').text)
      .toBe('{\n  "a": [],\n  "b": {},\n  "c": [\n    1,\n    {\n      "d": 2\n    }\n  ]\n}');
  });

  test("a BOM in front of JSON does not stop it formatting", () => {
    expect(prettyJson('﻿{"a":1}').text).toBe('{\n  "a": 1\n}');
  });

  test("a body that is not JSON says so instead of silently doing nothing", () => {
    // The old code swallowed the failure, so ticking pretty on a truncated
    // body looked exactly like ticking it on one that needed no work.
    const r = prettyJson('{"a":1');
    expect(r.text).toBe('{"a":1');
    expect(r.note).toMatch(/not valid JSON/i);
  });

  test("a body past the cap is left alone and says why", () => {
    const big = '{"a":"' + "x".repeat(MAX_PRETTY_BYTES) + '"}';
    const r = prettyJson(big);
    expect(r.text).toBe(big);
    expect(r.note).toMatch(/unformatted/i);
  });

  test("a bare scalar is returned as-is", () => {
    expect(prettyJson("true").text).toBe("true");
    expect(prettyJson('"hello"').text).toBe('"hello"');
  });
});

describe("XML/HTML: indentation only, never content", () => {
  test("the spaces between words are not deleted", () => {
    // The old printer replaced this space with a newline rather than losing it
    // outright, so nothing visibly ran together — but the text node is content
    // and a formatter has no business rewriting it. Kept as a guard on this
    // implementation, not as evidence of a fixed defect.
    const t = prettyXml("<p>hello <b>world</b></p>").text;
    expect(t).toContain("hello");
    expect(t).toContain("world");
    expect(t).not.toContain("helloworld");
  });

  test("void elements do not push the rest of the page rightwards", () => {
    const html = "<div>" + "<img><br>".repeat(200) + "<span>x</span></div>";
    const t = prettyXml(html).text;
    const deepest = Math.max(...t.split("\n").map((l) => l.length - l.trimStart().length));
    // Real nesting depth here is 2. It used to reach 400 levels of indent.
    expect(deepest).toBeLessThanOrEqual(4);
  });

  test("an ordinary page does not balloon", () => {
    // 4000 <img> + 4000 <br> measured 162KB in, 61MB out before this.
    const html = "<html><body>" + '<img src="x"><br>'.repeat(4000) + "</body></html>";
    const started = performance.now();
    const t = prettyXml(html).text;
    const ms = performance.now() - started;
    expect(t.length).toBeLessThan(html.length * 4);
    expect(ms).toBeLessThan(2000);
  });

  test("closing tags line up with their openers", () => {
    const lines = prettyXml("<div><p><span>b</span></p></div>").text.split("\n");
    const col = (s: string) => lines.find((l) => l.includes(s))!.search(/\S/);
    // <p> is one character between < and >, which the old open-tag regex
    // needed two of — so </p> closed a level that was never opened and the
    // content drifted left past its parent.
    expect(col("<div>")).toBe(col("</div>"));
    expect(col("<p>")).toBe(col("</p>"));
    expect(col("<span>")).toBeGreaterThan(col("<p>"));
  });

  test("an attribute containing > does not split the tag", () => {
    expect(prettyXml('<a title="a > b">x</a>').text).toContain('<a title="a > b">');
  });

  test("<pre> content keeps its own whitespace", () => {
    expect(prettyXml("<div><pre>a\n  b   c</pre></div>").text).toContain("a\n  b   c");
  });

  test("a certificate inside CDATA is not re-indented", () => {
    const src = "<r><![CDATA[-----BEGIN CERT-----\nAAAA\n  BBBB\n-----END CERT-----]]></r>";
    expect(prettyXml(src).text).toContain("-----BEGIN CERT-----\nAAAA\n  BBBB\n-----END CERT-----");
  });

  test("comments and declarations survive", () => {
    const t = prettyXml('<?xml version="1.0"?><!-- keep > this --><r/>').text;
    expect(t).toContain('<?xml version="1.0"?>');
    expect(t).toContain("<!-- keep > this -->");
  });
});
