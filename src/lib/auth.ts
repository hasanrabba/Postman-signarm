import type { Auth, KeyValue, SignalRequest } from "./types";
import { uid } from "./id";

/** Returns a copy of the request with auth applied to headers/params. */
export function applyAuth(req: SignalRequest): SignalRequest {
  const auth = req.auth;
  if (!auth || auth.type === "none") return req;

  const headers: KeyValue[] = [...req.headers];
  const params: KeyValue[] = [...req.params];

  const pushHeader = (key: string, value: string) =>
    headers.push({ id: uid("h"), key, value, enabled: true });
  const pushParam = (key: string, value: string) =>
    params.push({ id: uid("p"), key, value, enabled: true });

  switch (auth.type) {
    case "basic": {
      const { username = "", password = "" } = auth.basic ?? { username: "", password: "" };
      const token = btoa(`${username}:${password}`);
      pushHeader("Authorization", `Basic ${token}`);
      break;
    }
    case "bearer": {
      if (auth.bearer?.token) pushHeader("Authorization", `Bearer ${auth.bearer.token}`);
      break;
    }
    case "apikey": {
      const ak = auth.apikey;
      if (ak && ak.key) {
        if (ak.in === "header") pushHeader(ak.key, ak.value);
        else pushParam(ak.key, ak.value);
      }
      break;
    }
    case "oauth2": {
      if (auth.oauth2?.accessToken) {
        const type = auth.oauth2.tokenType || "Bearer";
        pushHeader("Authorization", `${type} ${auth.oauth2.accessToken}`);
      }
      break;
    }
  }

  return { ...req, headers, params };
}

export function emptyAuth(): Auth {
  return { type: "none" };
}
