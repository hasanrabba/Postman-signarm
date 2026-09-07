// @vitest-environment node
import { describe, it, expect } from "vitest";
import { POST as configPOST } from "@/app/api/mock-config/route";
import { GET as serveGET } from "@/app/api/mock/[mockId]/[[...path]]/route";
import { NextRequest } from "next/server";
import { MAX_BODY_BYTES, validateRoutes } from "@/lib/mock";

const enc = new TextEncoder();

function post(payload: unknown) {
  return new NextRequest("http://localhost:3000/api/mock-config", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

describe("refute: 5MB body limit is a char limit", () => {
  it("euro body of exactly MAX_BODY_BYTES chars: validate, store, serve", async () => {
    const body = "€".repeat(MAX_BODY_BYTES);
    expect(body.length).toBe(MAX_BODY_BYTES);
    const utf8 = enc.encode(body).length;
    console.log("[refute] chars=", body.length, "utf8 bytes=", utf8);

    // 1. pure validator
    const v = validateRoutes([{ method: "GET", path: "/big", status: 200, headers: {}, body }]);
    console.log("[refute] validateRoutes ok=", v.ok, "err=", v.ok ? null : v.error);

    // 2. real config handler
    const t0 = Date.now();
    const res = await configPOST(post({ mockId: "m1", routes: [{ method: "GET", path: "/big", status: 200, headers: {}, body }] }));
    const json = await res.json();
    console.log("[refute] config status=", res.status, "json=", JSON.stringify(json), "ms=", Date.now() - t0);

    // 3. real serve handler
    const sres = await serveGET(
      new NextRequest("http://localhost:3000/api/mock/m1/big", { method: "GET" }),
      { params: Promise.resolve({ mockId: "m1", path: ["big"] }) }
    );
    const buf = new Uint8Array(await sres.arrayBuffer());
    console.log("[refute] serve status=", sres.status, "served bytes=", buf.length, "declared cap=", MAX_BODY_BYTES);

    expect(true).toBe(true);
  }, 120_000);
});
