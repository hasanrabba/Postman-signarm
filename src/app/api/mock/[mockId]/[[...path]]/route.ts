import { NextRequest, NextResponse } from "next/server";

type MockRoute = {
  id: string;
  method: string;
  path: string;
  status: number;
  headers: Record<string, string>;
  body: string;
  delayMs?: number;
};

declare global {
  // eslint-disable-next-line no-var
  var __signalMocks: Record<string, MockRoute[]> | undefined;
}
const mocks: Record<string, MockRoute[]> = (globalThis.__signalMocks ??= {});

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
  const match = routes.find(
    (r) => r.method.toUpperCase() === req.method && r.path === mockPath
  );
  if (!match) {
    return NextResponse.json(
      { error: "No matching mock route", method: req.method, path: mockPath, mockId },
      { status: 404 }
    );
  }
  if (match.delayMs && match.delayMs > 0) {
    await new Promise((r) => setTimeout(r, match.delayMs));
  }
  return new NextResponse(match.body, { status: match.status, headers: match.headers });
}
