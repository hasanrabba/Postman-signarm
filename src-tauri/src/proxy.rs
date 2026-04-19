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

// Hard limits on any request reaching the proxy command — these exist to
// prevent a compromised frontend, or a maliciously-constructed Tauri IPC
// call from a misbehaving script, from DoSing the host with a 10 GB body
// or a 64k-header request.
const MAX_URL_LEN: usize = 4 * 1024;                // 4 KB
const MAX_BODY_BYTES: usize = 16 * 1024 * 1024;      // 16 MB
const MAX_HEADERS: usize = 256;
const MAX_HEADER_VALUE_LEN: usize = 8 * 1024;        // 8 KB
const MIN_TIMEOUT_MS: u64 = 1_000;
const MAX_TIMEOUT_MS: u64 = 120_000;

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
        .filter(|(k, v)| {
            if v.len() > MAX_HEADER_VALUE_LEN { return false; }
            let lk = k.to_ascii_lowercase();
            if FORBIDDEN_REQUEST_HEADERS.contains(&lk.as_str()) { return false; }
            if lk.starts_with("proxy-") || lk.starts_with("sec-") { return false; }
            true
        })
        .take(MAX_HEADERS)
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

/// SSRF guard: reject non-http(s) and — by default — reject loopback,
/// private, and link-local addresses. Users who are deliberately testing
/// their own LAN services can opt out with `SIGNAL_ALLOW_LOCAL=1`. This
/// is the opposite default of the web build, where the bundled Next.js
/// mock server uses loopback as a legitimate destination; in the desktop
/// build the Rust-side mock server lives in-process, not over HTTP, so
/// there's no reason a user's request should be hitting loopback.
fn should_block(host: &str) -> bool {
    if std::env::var("SIGNAL_ALLOW_LOCAL").ok().as_deref() == Some("1") {
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

    // Reject oversized inputs before we touch the network. Keeps a rogue
    // caller from forcing us to allocate gigabytes.
    if payload.url.len() > MAX_URL_LEN {
        return Ok(err(
            "Invalid URL",
            format!("URL too long ({} > {} bytes)", payload.url.len(), MAX_URL_LEN),
            started.elapsed().as_millis(),
        ));
    }
    if let Some(body) = payload.body.as_ref() {
        if body.len() > MAX_BODY_BYTES {
            return Ok(err(
                "Payload Too Large",
                format!("Body too large ({} > {} bytes)", body.len(), MAX_BODY_BYTES),
                started.elapsed().as_millis(),
            ));
        }
    }
    if payload.headers.len() > MAX_HEADERS {
        return Ok(err(
            "Too Many Headers",
            format!("Too many headers ({} > {})", payload.headers.len(), MAX_HEADERS),
            started.elapsed().as_millis(),
        ));
    }
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
        payload.timeout_ms.unwrap_or(30_000).clamp(MIN_TIMEOUT_MS, MAX_TIMEOUT_MS),
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

#[cfg(test)]
mod tests {
    use super::*;

    fn kv(k: &str, v: &str) -> (String, String) {
        (k.to_string(), v.to_string())
    }

    #[test]
    fn filter_drops_forbidden_headers() {
        let raw: std::collections::HashMap<String, String> = [
            kv("Host", "attacker.example"),
            kv("Cookie", "session=1"),
            kv("X-Real", "1"),
        ].into_iter().collect();
        let filtered = filter_request_headers(raw);
        assert!(!filtered.keys().any(|k| k.eq_ignore_ascii_case("host")));
        assert!(!filtered.keys().any(|k| k.eq_ignore_ascii_case("cookie")));
        assert!(filtered.keys().any(|k| k == "X-Real"));
    }

    #[test]
    fn filter_drops_oversized_header_values() {
        let big = "a".repeat(MAX_HEADER_VALUE_LEN + 1);
        let raw: std::collections::HashMap<String, String> = [
            kv("X-Huge", &big),
            kv("X-Small", "ok"),
        ].into_iter().collect();
        let filtered = filter_request_headers(raw);
        assert!(!filtered.contains_key("X-Huge"));
        assert!(filtered.contains_key("X-Small"));
    }

    #[test]
    fn filter_caps_header_count() {
        let raw: std::collections::HashMap<String, String> = (0..MAX_HEADERS + 20)
            .map(|i| kv(&format!("X-H-{i}"), "v"))
            .collect();
        let filtered = filter_request_headers(raw);
        assert!(filtered.len() <= MAX_HEADERS);
    }

    #[test]
    fn ssrf_blocks_default() {
        std::env::remove_var("SIGNAL_ALLOW_LOCAL");
        assert!(should_block("localhost"));
        assert!(should_block("127.0.0.1"));
        assert!(should_block("10.0.0.5"));
        assert!(should_block("192.168.1.1"));
        assert!(should_block("172.16.0.1"));
        assert!(should_block("169.254.1.1"));
        assert!(!should_block("example.com"));
    }

    #[test]
    fn ssrf_opt_in_unblocks() {
        std::env::set_var("SIGNAL_ALLOW_LOCAL", "1");
        assert!(!should_block("localhost"));
        assert!(!should_block("127.0.0.1"));
        std::env::remove_var("SIGNAL_ALLOW_LOCAL");
    }

    #[test]
    fn is_text_content_type_recognises_json_and_xml_variants() {
        assert!(is_text_content_type(""));
        assert!(is_text_content_type("application/json"));
        assert!(is_text_content_type("application/vnd.api+json; charset=utf-8"));
        assert!(is_text_content_type("application/ld+json"));
        assert!(is_text_content_type("text/html"));
        assert!(!is_text_content_type("image/png"));
        assert!(!is_text_content_type("application/octet-stream"));
    }
}
