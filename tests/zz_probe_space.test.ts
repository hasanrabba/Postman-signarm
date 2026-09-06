import { describe, test, expect } from "vitest";
import { generateSnippet } from "@/lib/snippets";
import { emptyAuth } from "@/lib/auth";
import type { SignalRequest } from "@/lib/types";

const req: SignalRequest = {
  id: "r", name: "r", method: "GET", url: "http://127.0.0.1:8911/a b",
  params: [], headers: [], body: { mode: "none" }, auth: emptyAuth(),
  scripts: { pre: "", post: "" },
} as unknown as SignalRequest;

describe("space in path", () => {
  test("dump", () => {
    for (const l of ["curl","fetch","python-requests","go","httpie"] as const) {
      console.log("=== " + l + " ===");
      console.log(generateSnippet(req, l));
    }
    expect(1).toBe(1);
  });
});
