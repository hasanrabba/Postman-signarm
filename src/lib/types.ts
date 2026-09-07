export type Method =
  | "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";

export type BodyMode =
  | "none" | "json" | "text" | "xml" | "form-urlencoded" | "form-data" | "graphql";

export interface KeyValue {
  id: string;
  key: string;
  value: string;
  enabled: boolean;
  description?: string;
  /**
   * Materialised by applyAuth on the way to the wire — an Authorization header
   * built from the request's auth config, not a row the user typed. History
   * keeps them so it shows what was actually sent; a replay drops them, or the
   * redacted copy comes back as a second `Authorization: [REDACTED]` row and
   * every later send goes out with both.
   */
  derived?: boolean;
  /**
   * When true, the UI masks the value behind a reveal toggle and redacts
   * it from history entries and console logs. Auto-applied to well-known
   * credential header names during cURL import.
   */
  secret?: boolean;
}

export type AuthType =
  | "none" | "basic" | "bearer" | "apikey" | "oauth2";

export interface Auth {
  type: AuthType;
  basic?: { username: string; password: string };
  bearer?: { token: string };
  apikey?: { key: string; value: string; in: "header" | "query" };
  oauth2?: { accessToken: string; tokenType?: string };
}

export interface RequestBody {
  mode: BodyMode;
  raw?: string;
  urlencoded?: KeyValue[];
  formdata?: (KeyValue & { type?: "text" | "file"; fileName?: string })[];
  graphql?: { query: string; variables: string };
}

export interface SignalRequest {
  id: string;
  name: string;
  method: Method;
  url: string;
  params: KeyValue[];
  headers: KeyValue[];
  auth: Auth;
  body: RequestBody;
  preRequestScript: string;
  testScript: string;
  description?: string;
}

export interface Folder {
  id: string;
  name: string;
  requestIds: string[];
  folderIds: string[];
  collapsed?: boolean;
}

export interface Collection {
  id: string;
  name: string;
  rootFolderId: string;
  folders: Record<string, Folder>;
  requests: Record<string, SignalRequest>;
  variables: KeyValue[];
  versions: CollectionVersion[];
  createdAt: number;
  updatedAt: number;
}

export interface CollectionVersion {
  id: string;
  message: string;
  timestamp: number;
  snapshot: Omit<Collection, "versions">;
}

export interface Environment {
  id: string;
  name: string;
  variables: KeyValue[];
  active?: boolean;
}

export interface SignalResponse {
  status: number;
  statusText: string;
  /** Flat map for scripts. Repeats are joined — see headerMap in lib/body.ts. */
  headers: Record<string, string>;
  /**
   * Every header line the server sent, in order, repeats intact. A plain map
   * cannot hold two Set-Cookie headers, and the one it dropped was the session
   * cookie; the headers pane reads this instead.
   */
  headerList?: Array<[string, string]>;
  body: string;
  bodyIsBase64?: boolean;
  /**
   * Set on a history copy whose body was cut down before being persisted, to
   * the original length. History is saved to localStorage, and one 32MB body
   * used to break saving for everything else, permanently.
   */
  bodyTruncated?: number;
  elapsedMs: number;
  sizeBytes: number;
  timings?: Record<string, number>;
  error?: string;
  contentType?: string;
  finalUrl?: string;
}

export interface HistoryEntry {
  id: string;
  timestamp: number;
  request: SignalRequest;
  response?: SignalResponse;
  testResults?: TestResult[];
}

export interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
}

export interface Secret {
  id: string;
  name: string;
  value: string;
  createdAt: number;
}

export interface MockRoute {
  id: string;
  method: Method;
  path: string;
  status: number;
  headers: Record<string, string>;
  body: string;
  delayMs?: number;
}

export interface MockServer {
  id: string;
  name: string;
  routes: MockRoute[];
}
