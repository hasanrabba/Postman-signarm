// End-to-end test: exercises the full pipeline (pre-request script →
// variable resolution → auth → proxy → response → test script).
// Requires the dev server to be running on PROXY_BASE (default
// http://localhost:3100) with SIGNAL_PROXY_ALLOW_LOCAL=1 and a mock
// registered at mockId=e2e.
import { executeRequest } from "../src/lib/executor";
import { emptyRequest } from "../src/lib/defaults";

const BASE = process.env.PROXY_BASE ?? "http://localhost:3100";

async function registerMock() {
  const res = await fetch(`${BASE}/api/mock-config`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      mockId: "e2e",
      routes: [
        {
          id: "r1", method: "GET", path: "/user",
          status: 200, headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: "u_42", name: "Ada" }),
        },
        {
          id: "r2", method: "POST", path: "/echo",
          status: 201, headers: { "content-type": "application/json" },
          body: JSON.stringify({ ok: true }),
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`mock-config: ${res.status}`);
}

async function main() {
  await registerMock();

  // Request 1 — run a test, capture userId into env
  const req1 = emptyRequest({
    name: "Get user",
    method: "GET",
    url: `${BASE}/api/mock/e2e/user`,
    testScript: `
      sg.test("status 200", () => sg.expect(sg.response.status).toBe(200));
      const u = sg.response.json();
      sg.test("has id", () => sg.expect(u.id).toBe("u_42"));
      sg.env.set("userId", u.id);
    `,
  });
  const r1 = await executeRequest(req1, {
    scope: { environment: [] },
    proxyUrl: `${BASE}/api/proxy`,
  });
  console.log("REQUEST 1:", r1.response.status, r1.response.body, "tests=", r1.tests);
  if (r1.tests.some((t) => !t.passed)) process.exit(1);

  // Request 2 — uses captured env var in URL path segment via variable substitution
  const req2 = emptyRequest({
    name: "Echo for user",
    method: "POST",
    url: `${BASE}/api/mock/e2e/echo`,
    headers: [
      { id: "h1", key: "X-User", value: "{{userId}}", enabled: true },
    ],
    body: { mode: "json", raw: `{"uid":"{{userId}}"}`, urlencoded: [], formdata: [], graphql: { query: "", variables: "" } },
    auth: { type: "bearer", bearer: { token: "{{token}}" } },
    testScript: `sg.test("201", () => sg.expect(sg.response.status).toBe(201));`,
  });
  const r2 = await executeRequest(req2, {
    scope: {
      environment: [
        { id: "e1", key: "userId", value: r1.envUpdates.userId ?? "MISSING", enabled: true },
        { id: "e2", key: "token", value: "abc123", enabled: true },
      ],
    },
    proxyUrl: `${BASE}/api/proxy`,
  });
  console.log("REQUEST 2:", r2.response.status, r2.response.body);
  console.log("  X-User header sent:", r2.request.headers.find((h) => h.key === "X-User")?.value);
  console.log("  Authorization sent:", r2.request.headers.find((h) => h.key === "Authorization")?.value);
  console.log("  body sent:", (r2.request.body.raw ?? ""));
  if (r2.tests.some((t) => !t.passed)) process.exit(1);
  console.log("\nE2E: OK");
}

main().catch((e) => { console.error(e); process.exit(1); });
