/**
 * Flag and tokenizer fidelity. Every expectation here was checked against real
 * curl 8.5.0 first; tests/curl-wire-differential.test.ts runs the same
 * commands through both for real.
 */
import { describe, test, expect, vi, beforeEach } from "vitest";

const sent: { method: string; url: string; headers: Record<string, string>; body?: string }[] = [];
vi.mock("@/lib/transport", () => ({
  sendProxy: vi.fn(async (p: never) => {
    sent.push(p);
    return { status: 200, statusText: "OK", headers: {}, body: "", elapsedMs: 1, sizeBytes: 0 };
  }),
  registerMock: vi.fn(async () => ({ ok: true })),
  mockBaseUrl: vi.fn(async () => undefined),
}));

import { parseCurl } from "@/lib/curl";
import { executeRequest } from "@/lib/executor";

beforeEach(() => { sent.length = 0; });

async function wire(cmd: string) {
  const req = parseCurl(cmd);
  if (!req) throw new Error("parseCurl returned null");
  await executeRequest(req, { scope: {} });
  const p = sent.at(-1)!;
  const h = Object.fromEntries(Object.entries(p.headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { method: p.method, url: p.url, headers: h, body: p.body ?? "" };
}

/* People write the value attached to the flag constantly. `-XPOST` was split
   into `-X -P -O -S -T`, so the method was the literal token `-P`. */
describe("a short flag's value may be attached", () => {
  test("-XPOST", async () => expect((await wire("curl -XPOST http://x.test/a")).method).toBe("POST"));
  test("-d with an attached body", async () =>
    expect((await wire(`curl -d'{"a":1}' http://x.test/a`)).body).toBe('{"a":1}'));
  test("-H with an attached header", async () =>
    expect((await wire("curl -H'X-A: 1' http://x.test/a")).headers["x-a"]).toBe("1"));
  test("-sLX POST still works", async () =>
    expect((await wire("curl -sLX POST http://x.test/a")).method).toBe("POST"));
  test("-ksS still works", async () =>
    expect((await wire("curl -ksS http://x.test/a")).url).toBe("http://x.test/a"));
});

/* Inside double quotes a backslash is only an escape before " \ $ ` or a
   newline. Eating it turned a pasted JSON body into different JSON. */
describe("a backslash in double quotes survives", () => {
  test("a JSON escape stays an escape", async () =>
    expect((await wire('curl http://x.test/a -d "{\\"text\\":\\"a\\nb\\"}"')).body)
      .toBe('{"text":"a\\nb"}'));
  test("a windows path keeps its separators", async () =>
    expect((await wire('curl http://x.test/a -d "C:\\temp\\news"')).body).toBe("C:\\temp\\news"));
  test("an escaped quote is still unescaped", async () =>
    expect((await wire('curl http://x.test/a -d "say \\"hi\\""')).body).toBe('say "hi"'));
});

/* Chrome DevTools' "Copy as cURL (bash)" emits $'...' for any value holding a
   newline or a non-ASCII character. It used to survive as a literal dollar. */
describe("$'...' ANSI-C quoting", () => {
  test("a body with a real newline", async () =>
    expect((await wire("curl http://x.test/a --data-raw $'line1\\nline2'")).body).toBe("line1\nline2"));
  test("a header", async () =>
    expect((await wire("curl http://x.test/a -H $'X-Trace: 1'")).headers["x-trace"]).toBe("1"));
  test("a URL", async () =>
    expect((await wire("curl $'http://x.test/a'")).url).toBe("http://x.test/a"));
  test("non-ASCII arrives as the character, not as its bytes", async () =>
    expect((await wire("curl http://x.test/a -H $'X-Name: Caf\\xc3\\xa9'")).headers["x-name"]).toBe("Café"));
  test("a dollar that is not quoting is left alone", async () =>
    expect((await wire("curl http://x.test/a -d 'cost=$5'")).body).toBe("cost=$5"));
});

describe("flags that carry the request", () => {
  test("--json sets the body, the method and both headers", async () => {
    const w = await wire(`curl --json '{"a":1}' http://x.test/a`);
    expect(w).toMatchObject({ method: "POST", body: '{"a":1}' });
    expect(w.headers["content-type"]).toBe("application/json");
    expect(w.headers["accept"]).toBe("application/json");
  });
  test("-T uploads as a PUT", async () =>
    expect((await wire("curl -T report.csv http://x.test/a")).method).toBe("PUT"));
  test("--upload-file uploads as a PUT", async () =>
    expect((await wire("curl --upload-file report.csv http://x.test/a")).method).toBe("PUT"));
  test("--oauth2-bearer becomes an Authorization header", async () =>
    expect((await wire("curl --oauth2-bearer TOK123 http://x.test/a")).headers["authorization"])
      .toBe("Bearer TOK123"));
});

/* --aws-sigv4 uses the -u secret as an HMAC key and never sends it. Turning
   the pair into Basic auth put a long-lived AWS secret on the wire. */
describe("a negotiated auth scheme does not become Basic auth", () => {
  const secret = "wJalrXUtnFEMI";
  test("--aws-sigv4", async () => {
    const w = await wire(`curl --aws-sigv4 'aws:amz:us-east-1:s3' -u 'AKIDEXAMPLE:${secret}' http://x.test/a`);
    expect(w.headers["authorization"]).toBeUndefined();
    expect(JSON.stringify(w)).not.toContain(btoa(`AKIDEXAMPLE:${secret}`));
  });
  for (const flag of ["--negotiate", "--ntlm", "--digest", "--anyauth"]) {
    test(flag, async () =>
      expect((await wire(`curl ${flag} -u 'alice:${secret}' http://x.test/a`)).headers["authorization"])
        .toBeUndefined());
  }
  test("-u on its own is still Basic auth (control)", async () =>
    expect((await wire("curl -u 'alice:pw' http://x.test/a")).headers["authorization"])
      .toBe(`Basic ${btoa("alice:pw")}`));
});

/* Everything after --next is a second transfer curl performs separately.
   Merging it aimed the second request's method at the first request's URL. */
describe("--next", () => {
  test("a DELETE meant for one path is not aimed at another", async () =>
    expect(await wire("curl http://x.test/items --next -X DELETE http://x.test/items/1"))
      .toMatchObject({ method: "GET", url: "http://x.test/items" }));
  test("the second request's body does not land on the first URL", async () =>
    expect(await wire("curl http://x.test/first --next -X POST -d 'danger=1' http://x.test/second"))
      .toMatchObject({ method: "GET", url: "http://x.test/first", body: "" }));
});

/* curl talks HTTP to a scheme-less host. Upgrading everything to HTTPS meant
   a plain-HTTP dev server could not be reached at all. */
describe("a URL written without a scheme", () => {
  test("localhost gets http", async () =>
    expect((await wire("curl localhost:3000/api")).url).toBe("http://localhost:3000/api"));
  test("127.0.0.1 gets http", async () =>
    expect((await wire("curl 127.0.0.1:8899/a")).url).toBe("http://127.0.0.1:8899/a"));
  test("a bare intranet name gets http", async () =>
    expect((await wire("curl buildbox:8080/status")).url).toBe("http://buildbox:8080/status"));
  test("a public host still gets https", async () =>
    expect((await wire("curl example.com/v1")).url).toBe("https://example.com/v1"));
});

/* An unknown flag used to swallow anything that did not start with `-` or
   `http`, which is every URL written without a scheme. */
describe("an unknown flag does not eat the URL", () => {
  for (const flag of ["-O", "-4", "-6", "--http2", "--path-as-is", "--compressed"]) {
    test(flag, async () =>
      expect((await wire(`curl ${flag} 127.0.0.1:8899/file.zip`)).url)
        .toBe("http://127.0.0.1:8899/file.zip"));
  }
  test("a flag that really does take a value still consumes it", async () =>
    expect((await wire("curl --proxy http://proxy:8080 https://real.test/a")).url)
      .toBe("https://real.test/a"));
});

/* fetch() refuses a URL carrying credentials outright, so these requests
   could not be sent at all. curl turns them into a Basic header. */
describe("credentials in the URL", () => {
  test("become a Basic header and leave the URL", async () => {
    const w = await wire("curl http://user:pass@x.test/a");
    expect(w.url).toBe("http://x.test/a");
    expect(w.headers["authorization"]).toBe(`Basic ${btoa("user:pass")}`);
  });
  test("-u still wins", async () => {
    const w = await wire("curl -u 'real:pw' http://user:pass@x.test/a");
    expect(w.headers["authorization"]).toBe(`Basic ${btoa("real:pw")}`);
  });
});

describe("the literal forms of a body", () => {
  test("--data-raw keeps a leading @ literal", async () =>
    expect((await wire("curl http://x.test/a --data-raw '@channel deploy is green'")).body)
      .toBe("@channel deploy is green"));
  test("-d still reads @ as a file reference (control)", async () =>
    expect((await wire("curl http://x.test/a -d @data.json")).body).toBe("[file:data.json]"));
  test("--form-string keeps a leading @ literal", async () => {
    const r = parseCurl("curl http://x.test/a --form-string 'x=@data.json'")!;
    expect(r.body.formdata![0]).toMatchObject({ key: "x", value: "@data.json", type: "text" });
  });
  test("-F still reads @ as a file (control)", async () => {
    const r = parseCurl("curl http://x.test/a -F 'x=@data.json'")!;
    expect(r.body.formdata![0]).toMatchObject({ key: "x", type: "file", fileName: "data.json" });
  });
  test("--data-urlencode '=content' sends no field name", async () =>
    expect((await wire("curl http://x.test/a --data-urlencode '=hello world'")).body)
      .toBe("hello%20world"));
});

/* A command truncated mid-copy ends on a flag. The body used to become the
   literal seven characters "undefined". */
describe("a command that ends on a flag", () => {
  test("a trailing -d does not invent a body", () => {
    const r = parseCurl("curl http://x.test/a -d");
    expect(r?.body.raw ?? "").toBe("");
  });
  test("a trailing -H does not throw", () => {
    expect(() => parseCurl("curl http://x.test/a -H")).not.toThrow();
  });
  test("a trailing -F does not throw", () => {
    expect(() => parseCurl("curl http://x.test/a -F")).not.toThrow();
  });
  test("a trailing --data-urlencode does not throw", () => {
    expect(() => parseCurl("curl http://x.test/a --data-urlencode")).not.toThrow();
  });
});

/* curl reads -b's argument as a cookie FILE when it holds no `=`. Sending the
   path as the Cookie header sent no cookies and told the server where the
   user keeps their files. */
describe("-b with a cookie file", () => {
  test("does not become a Cookie header", async () =>
    expect((await wire("curl -b /home/me/cookies.txt http://x.test/a")).headers["cookie"])
      .toBeUndefined());
  test("a cookie string still does (control)", async () =>
    expect((await wire("curl -b 'a=1; b=2' http://x.test/a")).headers["cookie"]).toBe("a=1; b=2"));
});

describe("-F file specs", () => {
  test("only the base name is sent, not the local path", () => {
    const r = parseCurl("curl http://x.test/a -F 'x=@/home/me/secrets/report.csv'")!;
    expect(r.body.formdata![0]).toMatchObject({ type: "file", fileName: "report.csv" });
  });
  test("a ;type= option does not end up glued to the filename", () => {
    const r = parseCurl("curl http://x.test/a -F 'avatar=@photo.png;type=image/png'")!;
    expect(r.body.formdata![0].fileName).toBe("photo.png");
  });
  test("a ;filename= option wins", () => {
    const r = parseCurl("curl http://x.test/a -F 'x=@/tmp/a.bin;filename=nice.bin'")!;
    expect(r.body.formdata![0].fileName).toBe("nice.bin");
  });
  test("'<' reads the field's value, so it is a text part not an upload", () => {
    const r = parseCurl("curl http://x.test/a -F 'notes=<notes.txt'")!;
    expect(r.body.formdata![0]).toMatchObject({ type: "text", key: "notes" });
    expect(r.body.formdata![0].fileName).toBeUndefined();
  });
});

test("-d with an empty body still carries curl's Content-Type", async () =>
  expect((await wire("curl -d '' http://x.test/a")).headers["content-type"])
    .toBe("application/x-www-form-urlencoded"));

test("--data-urlencode with no field name carries it too", async () =>
  expect((await wire("curl --data-urlencode 'some text' http://x.test/a")).headers["content-type"])
    .toBe("application/x-www-form-urlencoded"));

/* Two curl spellings that look alike and mean opposite things. */
describe("curl's two empty-header spellings", () => {
  test("'X-Name;' sends the header empty", async () =>
    expect((await wire("curl http://x.test/a -H 'X-Kill;'")).headers["x-kill"]).toBe(""));
  test("'X-Name:' with nothing after it removes it", async () =>
    expect((await wire("curl http://x.test/a -H 'X-Empty:'")).headers["x-empty"]).toBeUndefined());
  test("'X-Name: ' with only a space also removes it", async () =>
    expect((await wire("curl http://x.test/a -H 'X-Empty: '")).headers["x-empty"]).toBeUndefined());
  test("an ordinary header is unaffected (control)", async () =>
    expect((await wire("curl http://x.test/a -H 'X-A: 1'")).headers["x-a"]).toBe("1"));
});

test("--url does not displace a URL already given", async () =>
  expect((await wire("curl http://first.test/a --url http://second.test/b")).url)
    .toBe("http://first.test/a"));
