import { NextRequest, NextResponse } from "next/server";
import { validateRoutes, type MockRoute } from "@/lib/mock";

declare global {
  var __signalMocks: Record<string, MockRoute[]> | undefined;
}
// Null-prototype: a mockId of "__proto__" would otherwise reassign the
// prototype of the shared registry instead of storing a route set.
const mocks: Record<string, MockRoute[]> = (globalThis.__signalMocks ??= Object.create(null));

const bad = (error: string) => NextResponse.json({ ok: false, error }, { status: 400 });

/**
 * Is this write coming from somewhere other than the app?
 *
 * A POST with a text/plain body is a "simple request" — no preflight, so any
 * page the user happens to be visiting could quietly rewrite their mock server
 * and then serve whatever it liked from it. The app always posts JSON from its
 * own origin; both checks below are things a cross-site form or fetch cannot
 * fake, and a native caller (curl, the Tauri shell) sends neither header.
 */
function crossSite(req: NextRequest): boolean {
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return true;
  const origin = req.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).host !== new URL(req.url).host;
  } catch {
    return true;
  }
}

export async function POST(req: NextRequest) {
  if (crossSite(req)) return bad("Mock configuration can only be changed from the app itself.");
  // application/json cannot be sent cross-site without a preflight, so
  // insisting on it closes the no-preflight path as well.
  const type = (req.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (type !== "application/json") return bad("Expected a JSON body.");

  let body: { mockId?: unknown; routes?: unknown };
  try {
    body = (await req.json()) as { mockId?: unknown; routes?: unknown };
  } catch {
    return bad("Body is not valid JSON.");
  }
  if (!body.mockId || typeof body.mockId !== "string") return bad("Invalid payload");
  if (body.mockId === "__proto__" || body.mockId === "constructor" || body.mockId === "prototype") {
    return bad("Reserved mockId");
  }

  const checked = validateRoutes(body.routes);
  if (!checked.ok) return bad(checked.error);

  mocks[body.mockId] = checked.routes;
  return NextResponse.json({ ok: true, count: checked.routes.length });
}
