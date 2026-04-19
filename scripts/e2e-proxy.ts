// End-to-end test for the proxy's header handling and the executor's
// form-data + GraphQL serialization. Requires the dev server running on
// PROXY_BASE with SIGNAL_PROXY_ALLOW_LOCAL=1 and a mock echo endpoint
// seeded via /api/mock-config.
import { executeRequest } from "../src/lib/executor";
import { emptyRequest } from "../src/lib/defaults";

const BASE = process.env.PROXY_BASE ?? "http://localhost:3100";

async function registerMocks() {
  const res = await fetch(`${BASE}/api/mock-config`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      mockId: "px",
      routes: [
        { id: "a", method: "GET", path: "/ok", status: 200,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ok: true }) },
        { id: "b", method: "POST", path: "/echo", status: 200,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ok: true }) },
      ],
    }),
  });
  if (!res.ok) throw new Error(`mock-config: ${res.status}`);
}

let pass = 0, fail = 0;
function check(label: string, cond: unknown, extra?: unknown) {
  if (cond) { console.log(`  ✓ ${label}`); pass++; }
  else { console.log(`  ✗ ${label}`, extra ?? ""); fail++; }
}

async function main() {
  await registerMocks();

  console.log("\nproxy response header stripping");
  {
    const req = emptyRequest({ method: "GET", url: `${BASE}/api/mock/px/ok` });
    const r = await executeRequest(req, { scope: {}, proxyUrl: `${BASE}/api/proxy` });
    check("status 200", r.response.status === 200);
    const lower = Object.fromEntries(Object.entries(r.response.headers).map(([k, v]) => [k.toLowerCase(), v]));
    check("content-length stripped", !("content-length" in lower), lower);
    check("transfer-encoding stripped", !("transfer-encoding" in lower), lower);
  }

  console.log("\nproxy SSRF guards");
  {
    const blockedBody = await (await fetch(`${BASE}/api/proxy`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ method: "GET", url: "file:///etc/passwd" }),
    })).json();
    check("file:// rejected", blockedBody.statusText === "Blocked", blockedBody);

    const invalid = await (await fetch(`${BASE}/api/proxy`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ method: "GET", url: "not a url" }),
    })).json();
    check("invalid URL rejected", invalid.statusText === "Invalid URL", invalid);
  }

  console.log("\nform-data serialization");
  {
    const req = emptyRequest({
      method: "POST",
      url: `${BASE}/api/mock/px/echo`,
      body: {
        mode: "form-data",
        raw: "",
        urlencoded: [],
        formdata: [
          { id: "1", key: "name", value: "alice", enabled: true },
          { id: "2", key: "role", value: "admin", enabled: true },
        ],
        graphql: { query: "", variables: "" },
      },
    });
    const r = await executeRequest(req, { scope: {}, proxyUrl: `${BASE}/api/proxy` });
    check("form-data request succeeded", r.response.status === 200, r.response);
    const ct = r.request.headers.find((h) => h.key.toLowerCase() === "content-type")?.value ?? "";
    check("Content-Type includes multipart boundary", ct.startsWith("multipart/form-data; boundary="));
  }

  console.log("\nGraphQL body");
  {
    const req = emptyRequest({
      method: "POST",
      url: `${BASE}/api/mock/px/echo`,
      body: {
        mode: "graphql",
        raw: "",
        urlencoded: [],
        formdata: [],
        graphql: { query: "query Hello { hi }", variables: '{"x":1}' },
      },
    });
    const r = await executeRequest(req, { scope: {}, proxyUrl: `${BASE}/api/proxy` });
    check("graphql request succeeded", r.response.status === 200);
    const ct = r.request.headers.find((h) => h.key.toLowerCase() === "content-type")?.value ?? "";
    check("Content-Type defaults to JSON", ct.includes("application/json"));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
