// @vitest-environment node
/**
 * REFUTATION of: "the cross-site guard compares only the host, so an origin
 * differing from the app only by scheme is treated as the app itself."
 *
 * The mechanics are real, but the finding does not survive its three parts:
 *   1. the failing test offered as proof does not demonstrate the claim;
 *   2. the origin in the claim cannot be occupied by any caller that the
 *      Origin check is there to stop;
 *   3. the requested fix cannot work — the scheme it would compare against is
 *      read out of a request header the same caller supplies.
 */
import { describe, test, expect } from "vitest";
import { POST as configure } from "@/app/api/mock-config/route";

const post = (appUrl: string, body: unknown, headers: Record<string, string> = {}) =>
  configure(new Request(appUrl + "/api/mock-config", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  }) as never);

const route = () => ({ id: "1", method: "GET", path: "/z", status: 200, headers: {}, body: "x" });
const write = (appUrl: string, headers: Record<string, string>) =>
  post(appUrl, { mockId: "m", routes: [route()] }, headers).then((r) => r.status);

// -- 1. The offered proof does not demonstrate the claim ---------------------
describe("the failing test offered as proof", () => {
  test("it is a default-port collapse, not a scheme collapse", () => {
    // URL.host drops the default port. The test's two URLs are not the same
    // server on two schemes; they are port 443 and port 80 - two listeners.
    expect(new URL("https://localhost").host).toBe("localhost");   // :443
    expect(new URL("http://localhost").host).toBe("localhost");    // :80
    expect(new URL("https://localhost").port).toBe("");
    expect(new URL("https://localhost:3517").port).toBe("3517");
  });

  test("its assertion holds in every configuration the app actually runs in", async () => {
    // The finder's own live server (3517) and `next dev`'s default (3000).
    expect(await write("http://localhost:3517", { origin: "https://localhost" })).toBe(400);
    expect(await write("http://localhost:3000", { origin: "https://localhost" })).toBe(400);
    // It fails only when the app is bound to port 80, which is the one place
    // this app is never served - and there https://localhost is a real,
    // separately-bindable origin, so that case is about ports, not schemes.
    expect(await write("http://localhost", { origin: "https://localhost" })).toBe(200);
  });
});

// -- 2. The claimed origin is unreachable by anything the check stops --------
describe("who could actually send Origin: https://localhost:3517", () => {
  test("a browser also sends Sec-Fetch-Site, and that is refused first", async () => {
    const app = "http://localhost:3517";
    for (const site of ["cross-site", "same-site", "none-of-your-business"]) {
      expect(await write(app, { origin: "https://localhost:3517", "sec-fetch-site": site })).toBe(400);
    }
    // Only a caller that omits Sec-Fetch-Site entirely gets through...
    expect(await write(app, { origin: "https://localhost:3517" })).toBe(200);
    // ...and such a caller is a native one, which may already omit Origin too.
    // That is the documented, intended allowance - no header spoofing needed.
    expect(await write(app, {})).toBe(200);
  });
});

// -- 3. The requested hardening cannot work ---------------------------------
describe("a scheme-strict comparison would not close anything", () => {
  /** exactly what next-server.js:1278 builds for req.url */
  const initUrl = (headers: Record<string, string>, host: string, port: number) =>
    `${headers["x-forwarded-proto"]?.includes("https") ? "https" : "http"}://${host}:${port}/api/mock-config`;

  /** the "hardened" guard the finding asks for */
  const strictCrossSite = (origin: string, reqUrl: string) =>
    new URL(origin).origin !== new URL(reqUrl).origin;

  test("the attacker just adds x-forwarded-proto: https and it matches again", () => {
    const attack = { origin: "https://localhost:3517", "x-forwarded-proto": "https" };
    // Next derives req.url's scheme from that caller-supplied header
    // (base-server.js:608-611 uses ??=, so the client's value survives).
    expect(initUrl(attack, "localhost", 3517)).toBe("https://localhost:3517/api/mock-config");
    expect(strictCrossSite(attack.origin, initUrl(attack, "localhost", 3517))).toBe(false);
  });

  test("meanwhile the host half of the anchor is server-derived, not spoofable", async () => {
    // req.url is built from the server's own bind hostname:port, so a forged
    // Host header cannot move the anchor - verified live below in the notes.
    expect(initUrl({ host: "evil.com" } as never, "localhost", 3517))
      .toBe("http://localhost:3517/api/mock-config");
  });
});
