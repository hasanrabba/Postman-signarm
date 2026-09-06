/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Records every HTTP request it receives as one JSON line, so a test can see
 * the exact bytes a client put on the wire. Used by the cURL differential
 * harness to compare real curl against Signal.
 *
 *   ECHO_PORT=8899 ECHO_OUT=/tmp/echo.jsonl node tests/support/echo-server.cjs
 */
const http = require("node:http");
const fs = require("node:fs");

const OUT = process.env.ECHO_OUT || "/tmp/echo.jsonl";
const PORT = Number(process.env.ECHO_PORT || 8899);

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    fs.appendFileSync(OUT, JSON.stringify({
      method: req.method,
      url: req.url,
      headers: req.headers,
      body: Buffer.concat(chunks).toString("utf8"),
    }) + "\n");
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
  });
});

server.listen(PORT, "127.0.0.1", () => console.log("echo on " + PORT + " ->", OUT));
