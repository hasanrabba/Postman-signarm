//! The HTTP proxy, ported from the Next.js route. In the desktop build the
//! browser calls `invoke("proxy_fetch", …)` directly, so no web server is
//! needed. Same SSRF guards; no allowlist env var because the desktop user
//! is trusted to hit their own LAN.

use base64::Engine;
use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};
use url::Url;

#[derive(Debug, Deserialize)]
pub struct ProxyPayload {
    pub method: String,
    pub url: String,
    #[serde(default)]
    pub headers: std::collections::HashMap<String, String>,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Serialize, Default)]
pub struct ProxyResponse {
    pub status: u16,
    pub status_text: String,
    pub headers: std::collections::HashMap<String, String>,
    pub body: String,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub body_is_base64: bool,
    pub elapsed_ms: u128,
    pub size_bytes: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub final_url: Option<String>,
}

fn err(status_text: &str, error: String, elapsed: u128) -> ProxyResponse {
    ProxyResponse {
        status: 0,
        status_text: status_text.to_string(),
        headers: Default::default(),
        body: String::new(),
        body_is_base64: false,
        elapsed_ms: elapsed,
        size_bytes: 0,
        error: Some(error),
        content_type: None,
        final_url: None,
    }
}

const FORBIDDEN_REQUEST_HEADERS: &[&str] = &[
    "accept-charset", "accept-encoding", "access-control-request-headers",
    "access-control-request-method", "connection", "content-length", "cookie",
    "date", "dnt", "expect", "host", "keep-alive", "origin", "permissions-policy",
    "referer", "te", "trailer", "transfer-encoding", "upgrade", "via",
];

const STRIP_RESPONSE_HEADERS: &[&str] = &[
    "content-encoding", "content-length", "transfer-encoding", "connection",
    "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer",
    "upgrade",
];

fn filter_request_headers(
    raw: std::collections::HashMap<String, String>,
) -> std::collections::HashMap<String, String> {
    raw.into_iter()
        .filter(|(k, _)| {
            let lk = k.to_ascii_lowercase();
            if FORBIDDEN_REQUEST_HEADERS.contains(&lk.as_str()) { return false; }
            if lk.starts_with("proxy-") || lk.starts_with("sec-") { return false; }
            true
        })
        .collect()
}

fn is_text_content_type(ct: &str) -> bool {
    let lc = ct.to_ascii_lowercase();
    lc.is_empty()
        || lc.starts_with("text/")
        || lc.starts_with("application/json")
        || lc.starts_with("application/xml")
        || lc.starts_with("application/javascript")
        || lc.starts_with("application/x-www-form-urlencoded")
        || lc.starts_with("application/graphql")
        || lc.starts_with("application/ld+json")
        || lc.starts_with("application/problem+json")
        || lc.starts_with("application/vnd.api+json")
}

/// SSRF guard: reject non-http(s) and — when `SIGNAL_ALLOW_LOCAL` is
/// unset — reject loopback, private, and link-local addresses. The
/// desktop binary defaults to allowing local traffic because the user
/// is running this on their own machine.
fn should_block(host: &str) -> bool {
    if std::env::var("SIGNAL_BLOCK_LOCAL").ok().as_deref() != Some("1") {
        return false;
    }
    let h = host.to_ascii_lowercase();
    if h == "localhost" || h == "127.0.0.1" || h == "::1" || h.ends_with(".localhost") {
        return true;
    }
    if let Ok(ip) = h.parse::<std::net::IpAddr>() {
        match ip {
            std::net::IpAddr::V4(v4) => {
                let o = v4.octets();
                if o[0] == 10 { return true; }
                if o[0] == 172 && (16..=31).contains(&o[1]) { return true; }
                if o[0] == 192 && o[1] == 168 { return true; }
                if o[0] == 169 && o[1] == 254 { return true; }
                if o[0] == 0 { return true; }
            }
            std::net::IpAddr::V6(v6) => {
                let s = v6.to_string();
                if s.starts_with("fc") || s.starts_with("fd") { return true; }
                if s.starts_with("fe80") { return true; }
            }
        }
    }
    false
}

#[tauri::command]
pub async fn proxy_fetch(payload: ProxyPayload) -> Result<ProxyResponse, String> {
    let started = Instant::now();
    let parsed = match Url::parse(&payload.url) {
        Ok(u) => u,
        Err(e) => {
            return Ok(err(
                "Invalid URL",
                format!("Invalid URL: {} ({})", payload.url, e),
                started.elapsed().as_millis(),
            ));
        }
    };
    if !matches!(parsed.scheme(), "http" | "https") {
        return Ok(err(
            "Blocked",
            format!("Only http/https are allowed (got {}).", parsed.scheme()),
            started.elapsed().as_millis(),
        ));
    }
    if let Some(host) = parsed.host_str() {
        if should_block(host) {
            return Ok(err(
                "Blocked",
                format!("Host {} is blocked by the proxy.", host),
                started.elapsed().as_millis(),
            ));
        }
    }

    let timeout = Duration::from_millis(
        payload.timeout_ms.unwrap_or(30_000).clamp(1_000, 120_000),
    );
    let method = match payload.method.to_ascii_uppercase().as_str() {
        "GET" => reqwest::Method::GET,
        "POST" => reqwest::Method::POST,
        "PUT" => reqwest::Method::PUT,
        "PATCH" => reqwest::Method::PATCH,
        "DELETE" => reqwest::Method::DELETE,
        "HEAD" => reqwest::Method::HEAD,
        "OPTIONS" => reqwest::Method::OPTIONS,
        other => return Err(format!("Unsupported method: {other}")),
    };

    let client = match reqwest::Client::builder()
        .timeout(timeout)
        .user_agent(concat!("SignarmSignal/", env!("CARGO_PKG_VERSION")))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            return Ok(err(
                "Error",
                format!("client build: {e}"),
                started.elapsed().as_millis(),
            ));
        }
    };

    let mut req = client.request(method.clone(), parsed.clone());
    for (k, v) in filter_request_headers(payload.headers) {
        req = req.header(&k, v);
    }
    let has_body = !matches!(method, reqwest::Method::GET | reqwest::Method::HEAD);
    if has_body {
        if let Some(body) = payload.body {
            if !body.is_empty() {
                req = req.body(body);
            }
        }
    }

    let res = match req.send().await {
        Ok(r) => r,
        Err(e) if e.is_timeout() => {
            return Ok(err(
                "Timeout",
                format!("Request timed out after {}ms", timeout.as_millis()),
                started.elapsed().as_millis(),
            ));
        }
        Err(e) => {
            return Ok(err(
                "Error",
                e.to_string(),
                started.elapsed().as_millis(),
            ));
        }
    };

    let status = res.status();
    let final_url = {
        let u = res.url().to_string();
        if u != parsed.to_string() { Some(u) } else { None }
    };
    let mut out_headers = std::collections::HashMap::new();
    let mut content_type = String::new();
    for (k, v) in res.headers().iter() {
        let name = k.as_str().to_string();
        let lower = name.to_ascii_lowercase();
        if STRIP_RESPONSE_HEADERS.contains(&lower.as_str()) { continue; }
        let val = v.to_str().unwrap_or("").to_string();
        if lower == "content-type" {
            content_type = val.clone();
        }
        out_headers.insert(name, val);
    }

    let bytes = match res.bytes().await {
        Ok(b) => b,
        Err(e) => {
            return Ok(err(
                "Error",
                format!("body read: {e}"),
                started.elapsed().as_millis(),
            ));
        }
    };
    let size = bytes.len();
    let (body, body_is_base64) = if is_text_content_type(&content_type) {
        (String::from_utf8_lossy(&bytes).into_owned(), false)
    } else {
        (
            base64::engine::general_purpose::STANDARD.encode(&bytes),
            true,
        )
    };

    Ok(ProxyResponse {
        status: status.as_u16(),
        status_text: status.canonical_reason().unwrap_or("").to_string(),
        headers: out_headers,
        body,
        body_is_base64,
        elapsed_ms: started.elapsed().as_millis(),
        size_bytes: size,
        error: None,
        content_type: if content_type.is_empty() { None } else { Some(content_type) },
        final_url,
    })
}
