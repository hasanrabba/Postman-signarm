import { describe, it, expect } from "vitest";
import { resolveVars } from "../src/lib/variables";
import { runScript } from "../src/lib/scripting";
import { emptyRequest } from "../src/lib/defaults";

describe("resolveVars — inherited Object.prototype keys", () => {
  const scope = { environment: [{ id: "1", key: "real", value: "ok", enabled: true }] };
  for (const name of ["toString", "constructor", "hasOwnProperty", "valueOf", "__proto__", "isPrototypeOf"]) {
    it(`leaves {{${name}}} untouched`, () => {
      expect(resolveVars(`{{${name}}}`, scope)).toBe(`{{${name}}}`);
    });
  }
  it("still resolves a real variable literally named toString", () => {
    expect(resolveVars("{{toString}}", {
      environment: [{ id: "1", key: "toString", value: "mine", enabled: true }],
    })).toBe("mine");
  });
  it("resolves ordinary variables", () => {
    expect(resolveVars("hi {{real}}", scope)).toBe("hi ok");
  });
});

describe("sg.variables.get — inherited keys", () => {
  const ctx = { request: emptyRequest({}), env: {}, global: {}, collection: {} };
  it("returns undefined for prototype members", () => {
    const r = runScript(
      `sg.console.log(String(sg.variables.get("toString")), String(sg.variables.get("constructor")));`,
      ctx
    );
    expect(r.logs[0]).toBe("undefined undefined");
  });
  it("still returns real values with correct precedence", () => {
    const r = runScript(`sg.console.log(sg.variables.get("k"));`, {
      request: emptyRequest({}), env: { k: "env" }, global: { k: "glob" }, collection: { k: "col" },
    });
    expect(r.logs[0]).toBe("env");
  });
});
