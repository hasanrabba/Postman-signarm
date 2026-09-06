import type { SignalRequest } from "./types";
import { applyAuth } from "./auth";
import { toCurl } from "./curl";
import { appendQuery, buildQuery } from "./url";
import { combineHeaders, defaultContentType } from "./executor";
import { shellArg } from "./shell";
import { sendsBody } from "./wire";

export type SnippetLang = "curl" | "fetch" | "node-fetch" | "python-requests" | "go" | "httpie";

export function generateSnippet(request: SignalRequest, lang: SnippetLang): string {
  const req = applyAuth(request);
  switch (lang) {
    case "curl": return toCurl(req);
    case "fetch": return fetchSnippet(req);
    case "node-fetch": return fetchSnippet(req, true);
    case "python-requests": return pythonSnippet(req);
    case "go": return goSnippet(req);
    case "httpie": return httpieSnippet(req);
  }
}

function bodyString(req: SignalRequest): string | undefined {
  const b = req.body;
  // The app drops it, so a snippet that sends one is doing something the app
  // never does — and fetch and node-fetch refuse to run at all with one.
  if (!sendsBody(req.method)) return undefined;
  if (b.mode === "none") return undefined;
  if (b.mode === "json" || b.mode === "text" || b.mode === "xml") return b.raw || "";
  if (b.mode === "form-urlencoded") {
    return buildQuery(b.urlencoded ?? []);
  }
  if (b.mode === "graphql") {
    let variables: unknown = {};
    try { variables = b.graphql?.variables ? JSON.parse(b.graphql.variables) : {}; } catch { /* noop */ }
    return JSON.stringify({ query: b.graphql?.query || "", variables });
  }
  if (b.mode === "form-data") {
    // Rendered by each generator as native multipart rather than a string —
    // returning undefined here used to drop the fields silently.
    return undefined;
  }
  return undefined;
}

/** Enabled form-data fields, or undefined when this isn't a multipart body. */
function formFields(req: SignalRequest) {
  if (!sendsBody(req.method)) return undefined;
  if (req.body.mode !== "form-data") return undefined;
  const fields = (req.body.formdata ?? []).filter((f) => f.enabled && f.key);
  return fields.length ? fields : undefined;
}

/**
 * The headers a generated snippet must carry: the request's own, plus the
 * Content-Type the app adds for the body mode. Without it the copied code
 * meant something different from the request it came from — a JSON body went
 * out unlabelled, and the API that answered in Signal returned 415.
 *
 * Multipart is left out: every client generates its own boundary.
 */
function snippetHeaders(req: SignalRequest, multipart: boolean): Record<string, string> {
  // Built the same way the sender builds it: a map keyed by name kept only
  // the LAST of two rows sharing a name, so a second Cookie or a second
  // Authorization vanished from the copied code.
  const headers = combineHeaders(req.headers);
  if (multipart) {
    delete headers[Object.keys(headers).find((k) => k.toLowerCase() === "content-type") ?? ""];
    return headers;
  }
  const auto = defaultContentType(req.body.mode);
  if (auto && !Object.keys(headers).some((k) => k.toLowerCase() === "content-type")) {
    headers["Content-Type"] = auto;
  }
  return headers;
}

function urlWithQuery(req: SignalRequest): string {
  return appendQuery(req.url, buildQuery(req.params));
}

function fetchSnippet(req: SignalRequest, node = false): string {
  const fields = formFields(req);
  // The browser sets the multipart boundary itself; a hand-copied
  // Content-Type would not match the body FormData produces.
  const headers = snippetHeaders(req, Boolean(fields));
  const body = bodyString(req);
  const init: Record<string, unknown> = { method: req.method, headers };
  if (body !== undefined) init.body = body;
  const lines = [
    node ? "import fetch, { FormData } from 'node-fetch';" : "",
    ...(fields
      ? [
          "const form = new FormData();",
          ...fields.map((f) =>
            f.type === "file"
              ? `// form.append(${JSON.stringify(f.key)}, fileInput.files[0]); // ${f.fileName ?? "choose a file"}`
              : `form.append(${JSON.stringify(f.key)}, ${JSON.stringify(f.value)});`
          ),
        ]
      : []),
    `const res = await fetch(${JSON.stringify(urlWithQuery(req))}, ${
      fields
        ? `{\n  method: ${JSON.stringify(req.method)},\n  headers: ${JSON.stringify(headers)},\n  body: form,\n}`
        : JSON.stringify(init, null, 2)
    });`,
    "const text = await res.text();",
    "console.log(res.status, text);",
  ].filter(Boolean);
  return lines.join("\n");
}

function pythonSnippet(req: SignalRequest): string {
  const fields = formFields(req);
  const headers = snippetHeaders(req, Boolean(fields));
  const body = bodyString(req);
  const pyFiles = fields
    ? `files = {${fields
        .map((f) =>
          f.type === "file"
            ? `${JSON.stringify(f.key)}: open(${JSON.stringify(f.fileName ?? "file.bin")}, "rb")`
            : `${JSON.stringify(f.key)}: (None, ${JSON.stringify(f.value)})`
        )
        .join(", ")}}`
    : "";
  return [
    "import requests",
    `url = ${JSON.stringify(urlWithQuery(req))}`,
    `headers = ${JSON.stringify(headers)}`,
    pyFiles,
    body !== undefined ? `data = ${JSON.stringify(body)}` : "",
    `resp = requests.request(${JSON.stringify(req.method)}, url, headers=headers${
      fields ? ", files=files" : body !== undefined ? ", data=data" : ""
    })`,
    "print(resp.status_code, resp.text)",
  ].filter(Boolean).join("\n");
}

function goSnippet(req: SignalRequest): string {
  const body = bodyString(req);
  const fields = formFields(req);
  const lines = [
    "package main",
    "",
    "import (",
    fields ? "    \"bytes\"" : "",
    "    \"fmt\"",
    "    \"io\"",
    fields ? "    \"mime/multipart\"" : "",
    body !== undefined ? "    \"strings\"" : "",
    "    \"net/http\"",
    ")",
    "",
    "func main() {",
    ...(fields
      ? [
          "    var buf bytes.Buffer",
          "    mw := multipart.NewWriter(&buf)",
          ...fields.map((f) =>
            f.type === "file"
              ? `    // fw, _ := mw.CreateFormFile(${JSON.stringify(f.key)}, ${JSON.stringify(f.fileName ?? "file.bin")}); io.Copy(fw, file)`
              : `    mw.WriteField(${JSON.stringify(f.key)}, ${JSON.stringify(f.value)})`
          ),
          "    mw.Close()",
          "    body := &buf",
        ]
      : body !== undefined
        ? [`    body := strings.NewReader(${JSON.stringify(body)})`]
        : ["    var body io.Reader = nil"]),
    `    req, _ := http.NewRequest(${JSON.stringify(req.method)}, ${JSON.stringify(urlWithQuery(req))}, body)`,
  ];
  // multipart.Writer owns the Content-Type: it carries the boundary.
  for (const [k, v] of Object.entries(snippetHeaders(req, Boolean(fields)))) {
    lines.push(`    req.Header.Set(${JSON.stringify(k)}, ${JSON.stringify(v)})`);
  }
  if (fields) lines.push('    req.Header.Set("Content-Type", mw.FormDataContentType())');
  lines.push(
    "    resp, err := http.DefaultClient.Do(req)",
    "    if err != nil { panic(err) }",
    "    defer resp.Body.Close()",
    "    data, _ := io.ReadAll(resp.Body)",
    "    fmt.Println(resp.StatusCode, string(data))",
    "}"
  );
  return lines.filter(Boolean).join("\n");
}

/**
 * HTTPie decides what a request item means from the first separator it finds:
 * `=` is a data field, `:` a header, `==` a query parameter, `:=` embeds raw
 * JSON, and `=@` reads a FILE off disk. So a name holding one of those
 * characters, or a value starting with one, silently changed the request —
 * a form field holding "@channel deploy is green" made HTTPie try to open a
 * file called "channel deploy is green" and refuse to run at all, and a header
 * value starting with `=` turned into a JSON body. A backslash escapes them.
 *
 * An empty value is its own case: `Name:` tells HTTPie to REMOVE the header,
 * and `Name;` is the spelling that sends it empty — the same trap curl has.
 */
function httpieItem(name: string, sep: string, value: string): string {
  const n = name.replace(/([\\=:@])/g, "\\$1");
  if (sep === ":" && value === "") return `${n};`;
  const v = value.replace(/^([@=:])/, "\\$1");
  return `${n}${sep}${v}`;
}

function httpieSnippet(req: SignalRequest): string {
  const fields = formFields(req);
  const body = fields ? undefined : bodyString(req);
  const parts: string[] = ["http"];
  // Without this, HTTPie sees a non-tty stdin and refuses to mix it with
  // key=value items: run from a script or a CI job rather than typed at a
  // terminal, the snippet died with a usage error. Only the piped-body form
  // below actually wants stdin.
  if (!body) parts.push("--ignore-stdin");
  // `--form` means form-URLENCODED to HTTPie, not multipart: a form-data
  // request exported as `--form` arrived at the server as
  // application/x-www-form-urlencoded with a completely different body, which
  // any endpoint expecting an upload rejects. `--multipart` is the flag that
  // means what this body mode means.
  if (fields) parts.push("--multipart");
  parts.push(req.method, shellArg(urlWithQuery(req)));
  // HTTPie derives the multipart boundary itself.
  for (const [k, v] of Object.entries(snippetHeaders(req, Boolean(fields)))) {
    parts.push(shellArg(httpieItem(k, ":", v)));
  }
  if (fields) {
    for (const f of fields) {
      parts.push(shellArg(
        f.type === "file"
          ? httpieItem(f.key, "@", f.fileName ?? "file.bin")
          : httpieItem(f.key, "=", f.value)
      ));
    }
    return parts.join(" ");
  }
  // The body has to precede the command's stdin, not trail its args.
  //
  // `echo "..."` was doing two things wrong. It appends a newline, so every
  // body arrived one byte longer than the app sends — enough to break a signed
  // or hashed payload. And a double-quoted shell string still expands `$` and
  // backticks: a body holding `id -u` in backticks RAN that command and put its
  // output on the wire. printf writes the bytes exactly, and single quotes stop
  // the shell reading any of it.
  if (body) return `printf '%s' ${shellArg(body)} | ${parts.join(" ")}`;
  return parts.join(" ");
}
