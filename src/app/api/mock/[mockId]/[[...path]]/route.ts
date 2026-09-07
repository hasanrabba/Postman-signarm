import { NextRequest, NextResponse } from "next/server";
import { MAX_DELAY_MS, NULL_BODY_STATUSES, safeHeaders, type MockRoute } from "@/lib/mock";

declare global {
  var __signalMocks: Record<string, MockRoute[]> | undefined;
}
// Null-prototype: a mockId of "__proto__" would otherwise reassign the
// prototype of the shared registry instead of storing a route set.
const mocks: Record<string, MockRoute[]> = (globalThis.__signalMocks ??= Object.create(null));

type Ctx = { params: Promise<{ mockId: string; path?: string[] }> };

export async function GET(req: NextRequest, ctx: Ctx) { return handle(req, ctx); }
export async function POST(req: NextRequest, ctx: Ctx) { return handle(req, ctx); }
export async function PUT(req: NextRequest, ctx: Ctx) { return handle(req, ctx); }
export async function DELETE(req: NextRequest, ctx: Ctx) { return handle(req, ctx); }
export async function PATCH(req: NextRequest, ctx: Ctx) { return handle(req, ctx); }
export async function HEAD(req: NextRequest, ctx: Ctx) { return handle(req, ctx); }
export async function OPTIONS(req: NextRequest, ctx: Ctx) { return handle(req, ctx); }

/**
 * A mock server exists to be pointed at from somewhere else — usually a web
 * app on another port — and a browser will not let that app read a response
 * without these. Without them the mock answered 200 and the calling app saw a
 * CORS error, and a preflight 404'd, so anything with a JSON content type or a
 * custom header could not reach it at all.
 *
 * The origin is echoed rather than starred so a caller sending credentials is
 * not refused; there is nothing to protect here beyond the canned responses
 * the user wrote themselves.
 */
function cors(req: NextRequest): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": req.headers.get("origin") ?? "*",
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Expose-Headers": "*",
    Vary: "Origin",
  };
}

/** `/users/` and `/users` name the same route; `/` still means the root. */
function trimSlash(p: string): string {
  return p.length > 1 ? p.replace(/\/+$/, "") || "/" : p;
}

async function handle(req: NextRequest, ctx: Ctx) {
  const { mockId, path = [] } = await ctx.params;
  const routes = mocks[mockId] || [];
  const mockPath = "/" + path.join("/");
  // Guarded rather than trusting: the matcher walks every route, so one whose
  // method is not a string used to throw here and take down every other path
  // in the same mock, not just its own.
  const usable = routes.filter((r) => typeof r?.method === "string" && typeof r?.path === "string");
  const exact = usable.find((r) => r.method.toUpperCase() === req.method && r.path === mockPath);
  // An exact match always wins. Failing that: a trailing slash is not worth a
  // 404 — /users/ and /users are the same route to anyone typing them — and
  // HTTP says HEAD is answerable wherever GET is, so a health check against a
  // mocked GET should not come back missing.
  const match = exact ?? usable.find((r) => {
    const m = r.method.toUpperCase();
    const methodOk = m === req.method || (req.method === "HEAD" && m === "GET");
    return methodOk && trimSlash(r.path) === trimSlash(mockPath);
  });
  if (!match) {
    // An unmatched OPTIONS carrying Access-Control-Request-Method is a
    // preflight, not a missing route. A route registered FOR options still
    // wins, because it is matched above.
    if (req.method === "OPTIONS" && req.headers.get("access-control-request-method")) {
      return new NextResponse(null, {
        status: 204,
        headers: {
          ...cors(req),
          "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS",
          "Access-Control-Allow-Headers":
            req.headers.get("access-control-request-headers") ?? "*",
          "Access-Control-Max-Age": "600",
        },
      });
    }
    return NextResponse.json(
      { error: "No matching mock route", method: req.method, path: mockPath, mockId },
      { status: 404, headers: cors(req) }
    );
  }
  // Clamped: a route stored before the limit existed could still hold ten
  // minutes, and that is a mock server the user cannot get back.
  const delay = Number.isFinite(match.delayMs) ? Math.min(Math.max(match.delayMs ?? 0, 0), MAX_DELAY_MS) : 0;
  if (delay > 0) await new Promise((r) => setTimeout(r, delay));
  // Defensive: a route registered before validation existed could still
  // carry a bad status, and NextResponse throws on one.
  const status = Number.isInteger(match.status) && match.status >= 200 && match.status <= 599
    ? match.status
    : 200;
  // A header holding a line break, or a name that is not a token, throws while
  // the response is constructed — a 500 with nothing to say why. Serve what is
  // valid and leave out what is not.
  // The route's own headers win: a user who sets Access-Control-Allow-Origin
  // themselves means it.
  const headers = { ...cors(req), ...safeHeaders(match.headers) };
  // A HEAD response carries the headers of the GET it stands in for, and none
  // of the body.
  const body = typeof match.body === "string" ? match.body : String(match.body ?? "");
  // 204, 205 and 304 forbid a body, and the Response constructor throws rather
  // than dropping one — so passing the route's body made the request 500.
  const sendsBody = !NULL_BODY_STATUSES.has(status) && req.method !== "HEAD";
  return new NextResponse(sendsBody ? body : null, { status, headers });
}
