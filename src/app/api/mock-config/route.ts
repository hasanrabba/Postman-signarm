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
  var __signalMocks: Record<string, MockRoute[]> | undefined;
}
// Null-prototype: a mockId of "__proto__" would otherwise reassign the
// prototype of the shared registry instead of storing a route set.
const mocks: Record<string, MockRoute[]> = (globalThis.__signalMocks ??= Object.create(null));

export async function POST(req: NextRequest) {
  const body = (await req.json()) as { mockId: string; routes: MockRoute[] };
  if (!body.mockId || typeof body.mockId !== "string" || !Array.isArray(body.routes)) {
    return NextResponse.json({ ok: false, error: "Invalid payload" }, { status: 400 });
  }
  if (body.mockId === "__proto__" || body.mockId === "constructor" || body.mockId === "prototype") {
    return NextResponse.json({ ok: false, error: "Reserved mockId" }, { status: 400 });
  }
  mocks[body.mockId] = body.routes;
  return NextResponse.json({ ok: true, count: body.routes.length });
}
