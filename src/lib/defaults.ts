import { emptyAuth } from "./auth";
import { uid } from "./id";
import type { SignalRequest } from "./types";

export function emptyRequest(overrides: Partial<SignalRequest> = {}): SignalRequest {
  return {
    id: uid("req"),
    name: "Untitled request",
    method: "GET",
    url: "",
    params: [],
    headers: [],
    auth: emptyAuth(),
    body: {
      mode: "none",
      raw: "",
      urlencoded: [],
      formdata: [],
      graphql: { query: "", variables: "" },
    },
    preRequestScript: "",
    testScript: "",
    ...overrides,
  };
}
