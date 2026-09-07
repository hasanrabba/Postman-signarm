/**
 * What a mock route may contain, and what to do with one that does not.
 *
 * The registry is shared by the route that writes it and the route that serves
 * it, and only the writer can give a useful error. Anything it lets through
 * has to be survivable at serve time, because a route that throws while the
 * response is being built takes down every path in that mock — the matcher
 * walks the whole list, so one bad route 500s the good ones next to it.
 */

export type MockRoute = {
  id: string;
  method: string;
  path: string;
  status: number;
  headers: Record<string, string>;
  body: string;
  delayMs?: number;
};

/**
 * Long enough to test a client timeout, short of pinning the connection and
 * the handler behind it. 600000 was accepted, and ten minutes of that is a
 * mock server the user cannot get back.
 */
export const MAX_DELAY_MS = 30_000;
export const MAX_ROUTES = 2_000;
export const MAX_BODY_BYTES = 5 * 1024 * 1024;

/** RFC 9110 field-name token. */
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
/** A CR, LF or NUL in a value is response splitting; the rest is field-vchar. */
const HEADER_VALUE_BAD = /[\r\n\0]/;
/** RFC 9110 method token — same shape as a field name. */
const METHOD = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export type Validation = { ok: true; routes: MockRoute[] } | { ok: false; error: string };

function describe(r: unknown, i: number): string {
  const o = r as Partial<MockRoute> | null;
  const method = typeof o?.method === "string" ? o.method : "?";
  const path = typeof o?.path === "string" ? o.path : "?";
  return `Route ${i + 1} (${method} ${path})`;
}

export function validateRoutes(input: unknown): Validation {
  if (!Array.isArray(input)) return { ok: false, error: "routes must be an array." };
  if (input.length > MAX_ROUTES) {
    return { ok: false, error: `${input.length} routes is more than the ${MAX_ROUTES} allowed.` };
  }

  const routes: MockRoute[] = [];
  for (let i = 0; i < input.length; i++) {
    const r = input[i] as Partial<MockRoute> | null;
    const where = describe(r, i);
    if (!r || typeof r !== "object" || Array.isArray(r)) {
      return { ok: false, error: `${where} is not an object.` };
    }
    // `r.method.toUpperCase()` runs for every route on every request, so a
    // method that is not a string threw before any route could be matched.
    if (typeof r.method !== "string" || !METHOD.test(r.method)) {
      return { ok: false, error: `${where} has an invalid method; expected a word like GET or POST.` };
    }
    if (typeof r.path !== "string" || !r.path.startsWith("/")) {
      return { ok: false, error: `${where} has an invalid path; it must start with "/".` };
    }
    if (!Number.isInteger(r.status) || (r.status as number) < 200 || (r.status as number) > 599) {
      return {
        ok: false,
        error: `${where} has status ${r.status ?? "empty"}; expected an integer between 200 and 599.`,
      };
    }
    if (typeof r.body !== "string") {
      return { ok: false, error: `${where} has a body that is not text.` };
    }
    if (r.body.length > MAX_BODY_BYTES) {
      return { ok: false, error: `${where} has a body larger than ${MAX_BODY_BYTES} bytes.` };
    }
    if (r.delayMs !== undefined) {
      if (!Number.isFinite(r.delayMs) || (r.delayMs as number) < 0) {
        return { ok: false, error: `${where} has an invalid delay.` };
      }
      if ((r.delayMs as number) > MAX_DELAY_MS) {
        return { ok: false, error: `${where} has a delay of ${r.delayMs}ms; the most allowed is ${MAX_DELAY_MS}ms.` };
      }
    }
    const headers = r.headers ?? {};
    if (typeof headers !== "object" || headers === null || Array.isArray(headers)) {
      return { ok: false, error: `${where} has headers that are not a set of name/value pairs.` };
    }
    for (const [name, value] of Object.entries(headers)) {
      if (!HEADER_NAME.test(name)) {
        return { ok: false, error: `${where} has an invalid header name "${name}".` };
      }
      if (typeof value !== "string" || HEADER_VALUE_BAD.test(value)) {
        return {
          ok: false,
          error: `${where} has an invalid value for "${name}" — a header cannot contain a line break.`,
        };
      }
    }
    routes.push({
      id: typeof r.id === "string" ? r.id : String(i),
      method: r.method,
      path: r.path,
      status: r.status as number,
      headers: { ...(headers as Record<string, string>) },
      body: r.body,
      ...(r.delayMs !== undefined ? { delayMs: r.delayMs as number } : {}),
    });
  }
  return { ok: true, routes };
}

/**
 * Drop anything that would throw while the response is built. Routes stored
 * before this validation existed, or written straight into the registry, still
 * have to serve rather than 500.
 */
export function safeHeaders(headers: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) return out;
  for (const [name, value] of Object.entries(headers as Record<string, unknown>)) {
    if (!HEADER_NAME.test(name)) continue;
    if (typeof value !== "string" || HEADER_VALUE_BAD.test(value)) continue;
    out[name] = value;
  }
  return out;
}
