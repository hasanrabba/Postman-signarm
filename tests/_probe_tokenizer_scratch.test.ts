import { describe, test } from "vitest";
import { parseCurl } from "@/lib/curl";

const B = "http://127.0.0.1:8902/a";

const CASES: [string, string][] = [
  ["ansi-c body", `curl ${B} --data-raw $'a\nb'`],
  ["ansi-c header", `curl ${B} -H $'X-Trace: 1'`],
  ["ansi-c url", `curl $'${B}'`],
  ["locale quote", `curl ${B} -H $"X-Trace: 1"`],
  ["prompt dollar", `$ curl ${B}`],
  ["prompt gt", `> curl ${B}`],
  ["prompt hash", `# curl ${B}`],
  ["sudo", `sudo curl ${B}`],
  ["curl.exe", `curl.exe ${B}`],
  ["caret cont", `curl ^\n  -X POST ^\n  "${B}"`],
  ["backtick cont", "curl `\n  -X POST `\n  \"" + B + "\""],
  ["cmd doubled quotes", `curl ${B} -d "{""a"":1}"`],
  ["dq backslash-n", `curl ${B} -d "{\\"text\\":\\"a\\nb\\"}"`],
  ["dq windows path", `curl ${B} -d "C:\\temp\\new"`],
  ["crlf", `curl ${B} \\\r\n  -H 'X-A: 1'`],
  ["trailing backslash", `curl ${B} -H 'X-A: 1' \\`],
  ["backslash space nl", `curl \\ \n  ${B}`],
  ["unbalanced quote", `curl ${B} -H 'X-A: 1`],
  ["apostrophe body", `curl -d 'it's fine' ${B}`],
  ["escaped quote idiom", `curl -d 'it'\\''s' ${B}`],
  ["empty arg", `curl ${B} -H '' -d ''`],
  ["adjacent quoting", `curl ${B} -H 'X-A: '"$TOKEN"''`],
  ["hash comment", `curl ${B} # get the thing`],
  ["tabs", `curl\t${B}\t-H\t'X-A: 1'`],
  ["leading blank lines", `\n\n  curl ${B}`],
  ["CAPS", `CURL ${B}`],
  ["trailing -H", `curl ${B} -H`],
  ["trailing -d", `curl ${B} -d`],
  ["trailing -F", `curl ${B} -F`],
  ["trailing --data-urlencode", `curl ${B} --data-urlencode`],
  ["multiline quoted body", `curl ${B} -d '{\n  "a": 1\n}'`],
];

describe("scratch", () => {
  for (const [name, cmd] of CASES) {
    test(name, () => {
      let out: unknown;
      try {
        const r = parseCurl(cmd);
        out = r === null ? "NULL" : { method: r.method, url: r.url, headers: r.headers.map((h) => `${h.key}|${h.value}`), params: r.params.map((p) => `${p.key}|${p.value}`), mode: r.body.mode, raw: r.body.raw, ue: r.body.urlencoded?.map((u) => `${u.key}|${u.value}`) };
      } catch (e) {
        out = "THREW: " + (e as Error).message;
      }
      console.log("### " + name + " :: " + JSON.stringify(out));
    });
  }
});
