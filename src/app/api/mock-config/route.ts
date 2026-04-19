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

export async function POST(req: NextRequest) {
  const body = (await req.json()) as { mockId: string; routes: MockRoute[] };
  if (!body.mockId || !Array.isArray(body.routes)) {
    return NextResponse.json({ ok: false, error: "Invalid payload" }, { status: 400 });
  }
  mocks[body.mockId] = body.routes;
  return NextResponse.json({ ok: true, count: body.routes.length });
}
