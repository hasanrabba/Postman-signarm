import { NextRequest, NextResponse } from "next/server";
import { MAX_DELAY_MS, safeHeaders, type MockRoute } from "@/lib/mock";

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

async function handle(req: NextRequest, ctx: Ctx) {
  const { mockId, path = [] } = await ctx.params;
  const routes = mocks[mockId] || [];
  const mockPath = "/" + path.join("/");
  // Guarded rather than trusting: the matcher walks every route, so one whose
  // method is not a string used to throw here and take down every other path
  // in the same mock, not just its own.
  const match = routes.find(
    (r) =>
      typeof r?.method === "string" &&
      r.method.toUpperCase() === req.method &&
      r.path === mockPath
  );
  if (!match) {
    return NextResponse.json(
      { error: "No matching mock route", method: req.method, path: mockPath, mockId },
      { status: 404 }
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
  return new NextResponse(typeof match.body === "string" ? match.body : String(match.body ?? ""), {
    status,
    headers: safeHeaders(match.headers),
  });
}
