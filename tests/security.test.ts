import { describe, expect, test } from "vitest";
import {
  isSecretHeaderName,
  isSecretParamName,
  autoFlagSecretsOnRequest,
  redactRequest,
  maskValue,
} from "@/lib/secrets";
import { parseCurl } from "@/lib/curl";
import { emptyRequest } from "@/lib/defaults";

describe("secret detection", () => {
  test("exact-match header names", () => {
    for (const name of ["Authorization", "Cookie", "X-API-Key", "X-Auth-Token", "ApiKey"]) {
      expect(isSecretHeaderName(name)).toBe(true);
    }
  });
  test("substring-match header names", () => {
    for (const name of ["X-Company-Secret", "My-Bearer", "password-input", "my-credential"]) {
      expect(isSecretHeaderName(name)).toBe(true);
    }
  });
  test("benign header names are not flagged", () => {
    for (const name of ["Accept", "Content-Type", "User-Agent", "Host", "X-Request-Id"]) {
      expect(isSecretHeaderName(name)).toBe(false);
    }
  });
  test("URL query params", () => {
    expect(isSecretParamName("token")).toBe(true);
    expect(isSecretParamName("api_key")).toBe(true);
    expect(isSecretParamName("signature")).toBe(true);
    expect(isSecretParamName("limit")).toBe(false);
    expect(isSecretParamName("page")).toBe(false);
  });
});

describe("autoFlagSecretsOnRequest", () => {
  test("marks Authorization header as secret", () => {
    const req = emptyRequest({
      headers: [
        { id: "h1", key: "Authorization", value: "Bearer x", enabled: true },
        { id: "h2", key: "Accept", value: "application/json", enabled: true },
      ],
    });
    const flagged = autoFlagSecretsOnRequest(req);
    expect(flagged.headers[0].secret).toBe(true);
    expect(flagged.headers[1].secret).toBeFalsy();
  });

  test("marks sensitive query params", () => {
    const req = emptyRequest({
      params: [
        { id: "p1", key: "api_key", value: "xyz", enabled: true },
        { id: "p2", key: "limit", value: "10", enabled: true },
      ],
    });
    const flagged = autoFlagSecretsOnRequest(req);
    expect(flagged.params[0].secret).toBe(true);
    expect(flagged.params[1].secret).toBeFalsy();
  });
});

describe("cURL import auto-flags secrets", () => {
  test("Authorization from -H is flagged", () => {
    const r = parseCurl(
      "curl -H 'Authorization: Bearer super-secret-token' https://api.example.com/me"
    )!;
    const auth = r.headers.find((h) => h.key.toLowerCase() === "authorization");
    expect(auth?.secret).toBe(true);
  });
  test("Cookie from -b is flagged", () => {
    const r = parseCurl(
      "curl -b 'session=abc123; token=xyz' https://api.example.com"
    )!;
    const cookie = r.headers.find((h) => h.key.toLowerCase() === "cookie");
    expect(cookie?.secret).toBe(true);
  });
  test("Basic auth from -u is flagged", () => {
    const r = parseCurl("curl -u admin:hunter2 https://api.example.com")!;
    const basic = r.headers.find((h) => h.key === "Authorization");
    expect(basic?.secret).toBe(true);
  });
});

describe("redactRequest", () => {
  test("replaces secret header values with [REDACTED]", () => {
    const req = emptyRequest({
      headers: [
        { id: "h1", key: "Authorization", value: "Bearer verylong", enabled: true },
        { id: "h2", key: "Accept", value: "application/json", enabled: true },
      ],
    });
    const r = redactRequest(req);
    expect(r.headers[0].value).toBe("[REDACTED]");
    expect(r.headers[1].value).toBe("application/json");
  });

  test("redacts basic/bearer/apikey/oauth in the Auth object", () => {
    expect(redactRequest(emptyRequest({ auth: { type: "bearer", bearer: { token: "secret" } } }))
      .auth.bearer?.token).toBe("[REDACTED]");
    expect(redactRequest(emptyRequest({ auth: { type: "apikey", apikey: { key: "X-Key", value: "vvv", in: "header" } } }))
      .auth.apikey?.value).toBe("[REDACTED]");
    expect(redactRequest(emptyRequest({ auth: { type: "oauth2", oauth2: { accessToken: "abc" } } }))
      .auth.oauth2?.accessToken).toBe("[REDACTED]");
  });

  test("redacts password/token/api_key fields inside a JSON body", () => {
    const req = emptyRequest({
      body: {
        mode: "json",
        raw: '{"email":"a@b.c","password":"hunter2","token":"t123","limit":10}',
        urlencoded: [], formdata: [], graphql: { query: "", variables: "" },
      },
    });
    const r = redactRequest(req);
    expect(r.body.raw).toContain('"password":"[REDACTED]"');
    expect(r.body.raw).toContain('"token":"[REDACTED]"');
    expect(r.body.raw).toContain('"email":"a@b.c"');
    expect(r.body.raw).toContain('"limit":10');
  });

  test("does not mutate the input", () => {
    const req = emptyRequest({
      headers: [{ id: "h1", key: "Authorization", value: "Bearer abc", enabled: true }],
    });
    const before = req.headers[0].value;
    redactRequest(req);
    expect(req.headers[0].value).toBe(before);
  });
});

describe("maskValue", () => {
  test("produces bullets matching the value length, capped at 12", () => {
    expect(maskValue("")).toBe("");
    expect(maskValue("abc")).toBe("•••");
    expect(maskValue("a".repeat(30))).toBe("•".repeat(12));
  });
});
