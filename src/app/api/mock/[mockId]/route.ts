import { NextRequest, NextResponse } from "next/server";

/**
 * Lightweight in-memory mock dispatcher. The client registers routes via POST
 * to /api/mock-config and they're served here. Primarily illustrative — the
 * state does not persist across a process restart.
 */

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

export async function GET(req: NextRequest, ctx: { params: Promise<{ mockId: string }> }) {
  return handle(req, ctx);
}
export async function POST(req: NextRequest, ctx: { params: Promise<{ mockId: string }> }) {
  return handle(req, ctx);
}
export async function PUT(req: NextRequest, ctx: { params: Promise<{ mockId: string }> }) {
  return handle(req, ctx);
}
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ mockId: string }> }) {
  return handle(req, ctx);
}
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ mockId: string }> }) {
  return handle(req, ctx);
}

async function handle(req: NextRequest, ctx: { params: Promise<{ mockId: string }> }) {
  const { mockId } = await ctx.params;
  const routes = mocks[mockId] || [];
  const url = new URL(req.url);
  const path = url.pathname.replace(`/api/mock/${mockId}`, "") || "/";
  const match = routes.find((r) => r.method.toUpperCase() === req.method && r.path === path);
  if (!match) return NextResponse.json({ error: "No matching mock route" }, { status: 404 });
  if (match.delayMs && match.delayMs > 0) {
    await new Promise((r) => setTimeout(r, match.delayMs));
  }
  return new NextResponse(match.body, { status: match.status, headers: match.headers });
}

export function __registerMockRoutes(mockId: string, routes: MockRoute[]) {
  mocks[mockId] = routes;
}
