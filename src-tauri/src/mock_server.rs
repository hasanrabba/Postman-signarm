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
    loop {
        let mut line = String::new();
        let n = reader.read_line(&mut line).await?;
        if n == 0 { break; }
        if line == "\r\n" || line == "\n" { break; }
        if let Some(v) = line.strip_prefix_ignore_ascii_case("content-length:") {
            content_length = v.trim().parse().unwrap_or(0);
        }
    }
    if content_length > 0 {
        let mut buf = vec![0u8; content_length];
        reader.read_exact(&mut buf).await?;
    }

    let (mock_id, mock_path) = split_target(&target);
    let response = route_lookup(&state, &mock_id, &method, &mock_path);

    match response {
        Some(r) => {
            if let Some(ms) = r.delay_ms { tokio::time::sleep(std::time::Duration::from_millis(ms)).await; }
            let status = r.status;
            let reason = status_reason(status);
            let body = r.body.clone();
            let mut resp = format!("HTTP/1.1 {status} {reason}\r\n");
            let mut have_ct = false;
            for (k, v) in &r.headers {
                if k.eq_ignore_ascii_case("content-length") { continue; }
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
            let body = format!(
                r#"{{"error":"No matching mock route","mockId":"{mock_id}","method":"{method}","path":"{mock_path}"}}"#
            );
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
