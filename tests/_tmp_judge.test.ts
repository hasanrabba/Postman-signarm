import { test } from "vitest";
import { generateSnippet, type SnippetLang } from "../src/lib/snippets";
import { emptyRequest } from "../src/lib/defaults";
import type { SignalRequest } from "../src/lib/types";

const kv = (key: string, value: string, enabled = true) => ({ id: key + value, key, value, enabled });
const req: SignalRequest = emptyRequest({
  url: "http://127.0.0.1:8911/a",
  method: "POST",
  headers: [kv("X-Off", "1", false)],
  params: [kv("p", "1", false)],
  body: { mode: "form-urlencoded", raw: "", urlencoded: [kv("a", "1", false)], formdata: [], graphql: { query: "", variables: "" } } as never,
});
const LANGS: SnippetLang[] = ["curl", "fetch", "node-fetch", "python-requests", "go", "httpie"];
test("dump", () => {
  for (const l of LANGS) console.log(`===== ${l} =====\n${generateSnippet(req, l)}`);
});
