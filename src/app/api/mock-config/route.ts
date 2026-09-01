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
  // A route whose status isn't a legal HTTP code makes every later request
  // to it throw at response-construction time. Reject it here, where the
  // caller can see why, instead of 500ing on each hit.
  const bad = body.routes.findIndex(
    (r) => !Number.isInteger(r?.status) || r.status < 200 || r.status > 599
  );
  if (bad !== -1) {
    return NextResponse.json(
      {
        ok: false,
        error: `Route ${bad + 1} (${body.routes[bad]?.method ?? "?"} ${body.routes[bad]?.path ?? "?"}) has status ${
          body.routes[bad]?.status ?? "empty"
        }; expected an integer between 200 and 599.`,
      },
      { status: 400 }
    );
  }
  mocks[body.mockId] = body.routes;
  return NextResponse.json({ ok: true, count: body.routes.length });
}
