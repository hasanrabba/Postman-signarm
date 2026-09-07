//! Tiny HTTP server for mock endpoints, baked into the desktop app.
//! Listens on 127.0.0.1:<random-free-port> and serves routes registered by
//! the UI through `mock_register`.

use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tauri::{AppHandle, Manager, State};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct MockRoute {
    pub id: String,
    pub method: String,
    pub path: String,
    pub status: u16,
    #[serde(default)]
    pub headers: HashMap<String, String>,
    #[serde(default)]
    pub body: String,
    #[serde(default, rename = "delayMs")]
    pub delay_ms: Option<u64>,
}

/// The listener is on loopback, but any page in the user's browser can post
/// to it. Nothing a caller sends may decide how much we allocate.
const MAX_REQUEST_BODY: usize = 8 * 1024 * 1024; // 8 MB
const MAX_HEADER_LINES: usize = 100;
const MAX_HEADER_LINE: usize = 8 * 1024;

/// Long enough to test a client timeout, short of pinning the connection and
/// the task behind it. Kept in step with MAX_DELAY_MS in src/lib/mock.ts.
const MAX_DELAY_MS: u64 = 30_000;
const MAX_ROUTES: usize = 2_000;
const MAX_BODY_BYTES: usize = 5 * 1024 * 1024;

/// RFC 9110 field-name token — also the shape of a method.
fn is_token(s: &str) -> bool {
    !s.is_empty()
        && s.bytes().all(|b| {
            b.is_ascii_alphanumeric()
                || matches!(b, b'!' | b'#' | b'$' | b'%' | b'&' | b'\'' | b'*'
                    | b'+' | b'-' | b'.' | b'^' | b'_' | b'`' | b'|' | b'~')
        })
}

/// A CR, LF or NUL in a header value ends the header — and with a
/// Content-Length of its own it ends the whole response, so the client reads
/// the attacker's body and the real one becomes garbage on the connection.
fn is_safe_header_value(v: &str) -> bool {
    !v.bytes().any(|b| b == b'\r' || b == b'\n' || b == 0)
}

/// Reject a route the server could not serve honestly. The UI shows this
/// string, so it names which route and what is wrong with it.
fn validate(routes: &[MockRoute]) -> Result<(), String> {
    if routes.len() > MAX_ROUTES {
        return Err(format!("{} routes is more than the {MAX_ROUTES} allowed.", routes.len()));
    }
    for (i, r) in routes.iter().enumerate() {
        let where_ = format!("Route {} ({} {})", i + 1, r.method, r.path);
        if !is_token(&r.method) {
            return Err(format!("{where_} has an invalid method; expected a word like GET or POST."));
        }
        if !r.path.starts_with('/') {
            return Err(format!("{where_} has an invalid path; it must start with \"/\"."));
        }
        if !(200..=599).contains(&r.status) {
            return Err(format!(
                "{where_} has status {}; expected a number between 200 and 599.", r.status));
        }
        if r.body.len() > MAX_BODY_BYTES {
            return Err(format!("{where_} has a body larger than {MAX_BODY_BYTES} bytes."));
        }
        if let Some(ms) = r.delay_ms {
            if ms > MAX_DELAY_MS {
                return Err(format!(
                    "{where_} has a delay of {ms}ms; the most allowed is {MAX_DELAY_MS}ms."));
            }
        }
        for (k, v) in &r.headers {
            if !is_token(k) {
                return Err(format!("{where_} has an invalid header name \"{k}\"."));
            }
            if !is_safe_header_value(v) {
                return Err(format!(
                    "{where_} has an invalid value for \"{k}\" — a header cannot contain a line break."));
            }
        }
    }
    Ok(())
}

/// Where the embedded mock server is listening, once it is.
///
/// The proxy blocks loopback, and this is the one loopback address it must
/// let through: without it, sending a request at a mock you just published
/// came back "Host 127.0.0.1 is blocked by the proxy", which reads like the
/// mock is broken rather than like a deliberate guard. Exposed as a bare
/// origin so the check can be an exact host:port match rather than a hole for
/// all of loopback.
pub static MOCK_ORIGIN: std::sync::RwLock<Option<String>> = std::sync::RwLock::new(None);

/// Is this the app's own mock server, and nothing else on loopback?
pub fn is_mock_origin(scheme: &str, host: &str, port: Option<u16>) -> bool {
    let Ok(guard) = MOCK_ORIGIN.read() else { return false };
    let Some(base) = guard.as_ref() else { return false };
    match base.strip_prefix("http://") {
        Some(hostport) => {
            let mut it = hostport.rsplitn(2, ':');
            let base_port = it.next().and_then(|p| p.parse::<u16>().ok());
            let base_host = it.next().unwrap_or("");
            scheme == "http" && host == base_host && port == base_port
        }
        None => false,
    }
}

#[derive(Default)]
pub struct MockState {
    pub routes: RwLock<HashMap<String, Vec<MockRoute>>>,
    pub base_url: RwLock<Option<String>>,
}

#[tauri::command]
pub async fn mock_register(
    mock_id: String,
    routes: Vec<MockRoute>,
    state: State<'_, Arc<MockState>>,
) -> Result<u32, String> {
    validate(&routes)?;
    let count = routes.len() as u32;
    state.routes.write().insert(mock_id, routes);
    Ok(count)
}

#[tauri::command]
pub async fn mock_base_url(state: State<'_, Arc<MockState>>) -> Result<String, String> {
    state
        .base_url
        .read()
        .clone()
        .ok_or_else(|| "mock server not started yet".into())
}

pub async fn start(app: AppHandle) {
    let state: Arc<MockState> = Arc::new(MockState::default());
    app.manage(state.clone());

    let listener = match TcpListener::bind("127.0.0.1:0").await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("[mock] bind failed: {e}");
            return;
        }
    };
    let addr = match listener.local_addr() {
        Ok(a) => a,
        Err(e) => { eprintln!("[mock] addr: {e}"); return; }
    };
    let base = format!("http://{}", addr);
    *state.base_url.write() = Some(base.clone());
    if let Ok(mut g) = MOCK_ORIGIN.write() { *g = Some(base.clone()); }
    eprintln!("[mock] listening on {base}");

    loop {
        let (socket, _) = match listener.accept().await {
            Ok(x) => x,
            Err(e) => { eprintln!("[mock] accept: {e}"); continue; }
        };
        let state = state.clone();
        tokio::spawn(async move {
            if let Err(e) = handle(socket, state).await {
                eprintln!("[mock] handler: {e}");
            }
        });
    }
}

async fn handle(mut socket: TcpStream, state: Arc<MockState>) -> std::io::Result<()> {
    let (rd, mut wr) = socket.split();
    let mut reader = BufReader::new(rd);

    let mut request_line = String::new();
    reader.read_line(&mut request_line).await?;
    let request_line = request_line.trim_end().to_string();
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("").to_ascii_uppercase();
    let target = parts.next().unwrap_or("/").to_string();

    let mut content_length = 0usize;
    let mut seen = 0usize;
    loop {
        if seen >= MAX_HEADER_LINES { break; }
        seen += 1;
        let mut line = String::new();
        // Bound each line too, so one endless header can't grow without limit.
        let n = (&mut reader).take(MAX_HEADER_LINE as u64).read_line(&mut line).await?;
        if n == 0 { break; }
        if line == "\r\n" || line == "\n" { break; }
        if let Some(v) = line.strip_prefix_ignore_ascii_case("content-length:") {
            content_length = v.trim().parse().unwrap_or(0);
        }
    }
    if content_length > 0 {
        // Drain, never allocate to a caller-supplied length: `Content-Length:
        // 99999999999` would otherwise ask for 100 GB up front.
        let to_read = content_length.min(MAX_REQUEST_BODY) as u64;
        let mut sink = tokio::io::sink();
        let _ = tokio::io::copy(&mut (&mut reader).take(to_read), &mut sink).await;
    }

    let (mock_id, mock_path) = split_target(&target);
    let response = route_lookup(&state, &mock_id, &method, &mock_path);

    match response {
        Some(r) => {
            // Clamped, not trusted: a route stored before validation existed
            // could still hold ten minutes, and that is a mock server the user
            // cannot get back.
            if let Some(ms) = r.delay_ms {
                tokio::time::sleep(std::time::Duration::from_millis(ms.min(MAX_DELAY_MS))).await;
            }
            let status = if (200..=599).contains(&r.status) { r.status } else { 200 };
            let reason = status_reason(status);
            let body = r.body.clone();
            let mut resp = format!("HTTP/1.1 {status} {reason}\r\n");
            let mut have_ct = false;
            for (k, v) in &r.headers {
                if k.eq_ignore_ascii_case("content-length") { continue; }
                // Anything that could end the header block early is dropped
                // rather than written: a value carrying CRLF used to inject
                // headers and a Content-Length of its own, so the client read
                // the injected body and the real one became garbage on the
                // connection.
                if !is_token(k) || !is_safe_header_value(v) { continue; }
                if k.eq_ignore_ascii_case("content-type") { have_ct = true; }
                resp.push_str(&format!("{k}: {v}\r\n"));
            }
            if !have_ct { resp.push_str("Content-Type: application/octet-stream\r\n"); }
            resp.push_str(&format!("Content-Length: {}\r\n", body.len()));
            resp.push_str("Connection: close\r\n\r\n");
            wr.write_all(resp.as_bytes()).await?;
            wr.write_all(body.as_bytes()).await?;
        }
        None => {
            // Built rather than formatted: the id, method and path come
            // straight off the request line, and a quote in any of them used
            // to break the JSON the caller is trying to read.
            let body = serde_json::json!({
                "error": "No matching mock route",
                "mockId": mock_id,
                "method": method,
                "path": mock_path,
            })
            .to_string();
            let resp = format!(
                "HTTP/1.1 404 Not Found\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            wr.write_all(resp.as_bytes()).await?;
            wr.write_all(body.as_bytes()).await?;
        }
    }
    wr.flush().await?;
    Ok(())
}

fn route_lookup(
    state: &MockState,
    mock_id: &str,
    method: &str,
    path: &str,
) -> Option<MockRoute> {
    let routes = state.routes.read();
    let list = routes.get(mock_id)?;
    list.iter()
        .find(|r| r.method.eq_ignore_ascii_case(method) && r.path == path)
        .cloned()
}

fn split_target(target: &str) -> (String, String) {
    let without_query = target.split('?').next().unwrap_or("/");
    let trimmed = without_query.trim_start_matches('/');
    let mut it = trimmed.splitn(2, '/');
    let mock = it.next().unwrap_or("").to_string();
    let rest = it.next().map(|s| format!("/{}", s)).unwrap_or("/".into());
    (mock, rest)
}

fn status_reason(status: u16) -> &'static str {
    match status {
        200 => "OK", 201 => "Created", 204 => "No Content",
        301 => "Moved Permanently", 302 => "Found", 304 => "Not Modified",
        400 => "Bad Request", 401 => "Unauthorized", 403 => "Forbidden",
        404 => "Not Found", 409 => "Conflict", 422 => "Unprocessable Entity",
        429 => "Too Many Requests", 500 => "Internal Server Error",
        502 => "Bad Gateway", 503 => "Service Unavailable",
        _ => "",
    }
}

// ---- trait helpers ----
trait StrExt {
    fn strip_prefix_ignore_ascii_case<'a>(&'a self, prefix: &str) -> Option<&'a str>;
}
impl StrExt for str {
    fn strip_prefix_ignore_ascii_case<'a>(&'a self, prefix: &str) -> Option<&'a str> {
        if self.len() >= prefix.len()
            && self[..prefix.len()].eq_ignore_ascii_case(prefix)
        {
            Some(&self[prefix.len()..])
        } else {
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    fn route(headers: HashMap<String, String>, status: u16, body: &str) -> MockRoute {
        MockRoute {
            id: "1".into(), method: "GET".into(), path: "/z".into(),
            status, headers, body: body.into(), delay_ms: None,
        }
    }

    /// Serve one request through the real connection handler over a real
    /// socket, and return exactly what the client read.
    async fn serve_once(state: Arc<MockState>, target: &str) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let st = state.clone();
        tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let _ = handle(socket, st).await;
        });
        let mut c = TcpStream::connect(addr).await.unwrap();
        c.write_all(format!("GET {target} HTTP/1.1\r\nHost: x\r\n\r\n").as_bytes())
            .await.unwrap();
        let mut buf = Vec::new();
        let _ = c.read_to_end(&mut buf).await;
        String::from_utf8_lossy(&buf).to_string()
    }

    fn with_route(r: MockRoute) -> Arc<MockState> {
        let st = Arc::new(MockState::default());
        st.routes.write().insert("m".into(), vec![r]);
        st
    }

    /// A header value carrying CRLF used to inject headers AND a
    /// Content-Length of its own, so the client read the injected body and the
    /// real one became garbage on the connection.
    #[tokio::test]
    async fn a_header_value_cannot_split_the_response() {
        let mut h = HashMap::new();
        h.insert("X-A".into(), "ok\r\nX-Injected: yes\r\nContent-Length: 5\r\n\r\nPWNED".into());
        let out = serve_once(with_route(route(h, 200, "real body")), "/m/z").await;
        assert!(!out.contains("X-Injected"), "injected a header: {out:?}");
        assert!(!out.contains("PWNED"), "injected a body: {out:?}");
        assert!(out.ends_with("real body"), "did not serve the real body: {out:?}");
    }

    #[tokio::test]
    async fn a_stored_status_outside_the_http_range_still_serves() {
        let out = serve_once(with_route(route(HashMap::new(), 999, "b")), "/m/z").await;
        assert!(out.starts_with("HTTP/1.1 200 OK"), "bad status line: {out:?}");
    }

    /// The id, method and path come straight off the request line.
    #[tokio::test]
    async fn the_404_body_is_valid_json_whatever_the_path_holds() {
        let out = serve_once(with_route(route(HashMap::new(), 200, "b")), "/m/\"quo\\te").await;
        let body = out.split("\r\n\r\n").nth(1).unwrap_or("");
        let parsed: Result<serde_json::Value, _> = serde_json::from_str(body);
        assert!(parsed.is_ok(), "404 body is not JSON: {body:?}");
    }

    /// MOCK_ORIGIN is process-wide and cargo runs tests in parallel threads.
    static ORIGIN_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn only_the_app_s_own_mock_is_admitted() {
        let _g = ORIGIN_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        *MOCK_ORIGIN.write().unwrap() = Some("http://127.0.0.1:54321".to_string());

        assert!(is_mock_origin("http", "127.0.0.1", Some(54321)), "own mock refused");

        // Everything else on loopback stays blocked.
        assert!(!is_mock_origin("http", "127.0.0.1", Some(3000)), "another port admitted");
        assert!(!is_mock_origin("http", "localhost", Some(54321)), "another host admitted");
        assert!(!is_mock_origin("http", "127.0.0.2", Some(54321)), "another address admitted");
        assert!(!is_mock_origin("https", "127.0.0.1", Some(54321)), "another scheme admitted");
        assert!(!is_mock_origin("http", "127.0.0.1", None), "portless admitted");
        assert!(!is_mock_origin("http", "169.254.169.254", Some(80)), "link-local admitted");

        // And nothing at all is admitted before the server has bound.
        *MOCK_ORIGIN.write().unwrap() = None;
        assert!(!is_mock_origin("http", "127.0.0.1", Some(54321)), "admitted with no server");
    }

    #[test]
    fn registration_refuses_what_cannot_be_served() {
        let mut crlf = HashMap::new();
        crlf.insert("X-A".to_string(), "a\r\nX-Injected: yes".to_string());
        assert!(validate(&[route(crlf, 200, "b")]).is_err(), "CRLF header accepted");

        let mut bad_name = HashMap::new();
        bad_name.insert("X A".to_string(), "v".to_string());
        assert!(validate(&[route(bad_name, 200, "b")]).is_err(), "invalid header name accepted");

        let mut slow = route(HashMap::new(), 200, "b");
        slow.delay_ms = Some(600_000);
        assert!(validate(&[slow]).is_err(), "a ten-minute delay was accepted");

        assert!(validate(&[route(HashMap::new(), 999, "b")]).is_err(), "status 999 accepted");

        let mut bad_method = route(HashMap::new(), 200, "b");
        bad_method.method = "GET POST".into();
        assert!(validate(&[bad_method]).is_err(), "invalid method accepted");

        let mut bad_path = route(HashMap::new(), 200, "b");
        bad_path.path = "z".into();
        assert!(validate(&[bad_path]).is_err(), "path without a leading slash accepted");

        // and a perfectly ordinary route still goes through
        let mut ok = route(HashMap::new(), 200, "b");
        ok.delay_ms = Some(250);
        ok.headers.insert("X-Trace".into(), "1".into());
        assert!(validate(&[ok]).is_ok(), "a valid route was refused");
    }
}
