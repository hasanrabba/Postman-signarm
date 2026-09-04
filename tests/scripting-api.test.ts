import { describe, test, expect } from "vitest";
import { runScript } from "@/lib/scripting";
import { mergeVars } from "@/lib/store";
import { emptyRequest } from "@/lib/defaults";
import type { ScriptContext } from "@/lib/scripting";

const ctx = (
  env: Record<string, string> = {},
  global: Record<string, string> = {},
  collection: Record<string, string> = {}
): ScriptContext => ({ request: emptyRequest({}), env, global, collection });

/* resolveVars builds a null-prototype table and variables.get does explicit
   own-property checks, both for this reason. The three scope accessors were
   the place that guard was missed. */
describe("reading a variable that was never defined", () => {
  for (const name of ["toString", "constructor", "valueOf", "hasOwnProperty"]) {
    test(`sg.env.get("${name}") is undefined`, () => {
      const out = runScript(`sg.console.log(typeof sg.env.get(${JSON.stringify(name)}));`, ctx());
      expect(out.logs[0]).toBe("undefined");
    });
  }

  test("globals and collection are guarded too", () => {
    const out = runScript(
      `sg.console.log(typeof sg.globals.get("toString"), typeof sg.collection.get("constructor"));`,
      ctx()
    );
    expect(out.logs[0]).toBe("undefined undefined");
  });

  test("a variable genuinely named toString is still readable", () => {
    const out = runScript(`sg.console.log(sg.env.get("toString"));`, ctx({ toString: "mine" }));
    expect(out.logs[0]).toBe("mine");
  });
});

/* An absent variable renders as a literal {{name}}; one set to "" renders as
   nothing. unset() wrote "", so it was a blank, not an unset. */
describe("sg.env.unset", () => {
  test("marks the variable for deletion rather than blanking it", () => {
    const out = runScript(`sg.env.unset("token");`, ctx({ token: "abc" }));
    expect(out.setEnv).toEqual({ token: null });
  });

  test("mergeVars removes it from the list", () => {
    const base = [
      { id: "1", key: "token", value: "abc", enabled: true },
      { id: "2", key: "keep", value: "yes", enabled: true },
    ];
    expect(mergeVars(base, { token: null }).map((k) => k.key)).toEqual(["keep"]);
  });

  test("unsetting an undefined variable does not create it", () => {
    expect(mergeVars([], { nope: null })).toEqual([]);
  });

  test("set(\"\") still stores an empty value", () => {
    const out = runScript(`sg.env.set("token", "");`, ctx({ token: "abc" }));
    expect(out.setEnv).toEqual({ token: "" });
    expect(mergeVars([{ id: "1", key: "token", value: "abc", enabled: true }], { token: "" }))
      .toEqual([{ id: "1", key: "token", value: "", enabled: true }]);
  });
});

describe("console logging", () => {
  test("the same object in two places is not a cycle", () => {
    const out = runScript(
      `const shared = { a: 1 }; sg.console.log({ first: shared, second: shared });`,
      ctx()
    );
    expect(out.logs[0]).not.toContain("[Circular]");
    expect(JSON.parse(out.logs[0])).toEqual({ first: { a: 1 }, second: { a: 1 } });
  });

  test("the same object twice in an array is not a cycle", () => {
    const out = runScript(`const s = { a: 1 }; sg.console.log([s, s, s]);`, ctx());
    expect(out.logs[0]).not.toContain("[Circular]");
  });

  test("a real cycle is still caught", () => {
    const out = runScript(`const o = { name: "x" }; o.self = o; sg.console.log(o);`, ctx());
    expect(out.logs[0]).toContain("[Circular]");
  });

  test("a deeper real cycle is caught", () => {
    const out = runScript(`const a = {}; const b = { a }; a.b = b; sg.console.log(a);`, ctx());
    expect(out.logs[0]).toContain("[Circular]");
  });
});

describe("a failing test reports why", () => {
  test("an Error message comes through", () => {
    const out = runScript(`sg.test("t", () => { throw new Error("boom"); });`, ctx());
    expect(out.tests[0]).toMatchObject({ passed: false, error: "boom" });
  });

  test("a thrown string is not left blank", () => {
    const out = runScript(`sg.test("t", () => { throw "plain string"; });`, ctx());
    expect(out.tests[0].passed).toBe(false);
    expect(out.tests[0].error).toBe("plain string");
  });

  test("a thrown object is not left blank", () => {
    const out = runScript(`sg.test("t", () => { throw { code: 42 }; });`, ctx());
    expect(out.tests[0].error).toContain("42");
  });

  test("a passing test has no error", () => {
    const out = runScript(`sg.test("t", () => { sg.expect(1).toBe(1); });`, ctx());
    expect(out.tests[0]).toEqual({ name: "t", passed: true });
  });
});
