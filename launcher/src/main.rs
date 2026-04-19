// Signarm Signal single-file launcher.
//
// The Tauri binary imports WebView2Loader.dll at PE-load time, so the DLL
// must sit next to it when it starts. Rather than ship two files we embed
// both payloads inside this launcher and extract them to a per-version
// folder in LOCALAPPDATA the first time the user runs it.
//
// We also detect the Microsoft Edge WebView2 Runtime and silently install
// it via the Evergreen Bootstrapper if it's missing. That happens through
// a one-line PowerShell helper so we don't have to embed the bootstrapper
// binary itself — the runtime is a Microsoft Windows component, always
// available from Microsoft's CDN, and PowerShell is guaranteed to exist
// on every supported Windows version.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::error::Error;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};

const APP_EXE: &[u8] = include_bytes!("../payload/SignarmSignal.exe");
const WEBVIEW2_DLL: &[u8] = include_bytes!("../payload/WebView2Loader.dll");
const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

// Microsoft's stable Evergreen Bootstrapper shortlink. Tiny (~150 KB)
// installer that downloads and installs the full WebView2 runtime.
const EVERGREEN_URL: &str = "https://go.microsoft.com/fwlink/p/?LinkId=2124703";

fn cache_root() -> PathBuf {
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        if !local.is_empty() {
            return PathBuf::from(local).join("SignarmSignal");
        }
    }
    std::env::temp_dir().join("SignarmSignal")
}

fn write_if_missing(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Ok(meta) = fs::metadata(path) {
        if meta.len() == bytes.len() as u64 {
            return Ok(());
        }
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, bytes)?;
    let _ = fs::rename(&tmp, path);
    Ok(())
}

#[cfg(windows)]
fn webview2_installed() -> bool {
    use winreg::enums::*;
    use winreg::RegKey;
    // The Edge team publishes the installed runtime version under this
    // CLSID. Presence of a non-zero `pv` value means the runtime is ready.
    const CLSID: &str = "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";
    let paths: &[(winreg::HKEY, String)] = &[
        (HKEY_LOCAL_MACHINE, format!("SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\{CLSID}")),
        (HKEY_LOCAL_MACHINE, format!("SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\{CLSID}")),
        (HKEY_CURRENT_USER, format!("Software\\Microsoft\\EdgeUpdate\\Clients\\{CLSID}")),
    ];
    for (hive, path) in paths {
        if let Ok(key) = RegKey::predef(*hive).open_subkey(path) {
            if let Ok(pv) = key.get_value::<String, _>("pv") {
                if !pv.is_empty() && pv != "0.0.0.0" {
                    return true;
                }
            }
        }
    }
    false
}

#[cfg(not(windows))]
fn webview2_installed() -> bool { true }

#[cfg(windows)]
fn install_webview2_runtime() -> Result<(), Box<dyn Error>> {
    // Ask the user first — silent system-wide installs without consent
    // would fail UAC anyway, and consent makes the behaviour predictable.
    let choice = message_box(
        "Signarm Signal needs Microsoft Edge WebView2.\n\n\
         Download and install it now? (~150 MB, one-time)",
        "Signarm Signal",
        MB_YESNO | MB_ICONINFO,
    );
    if choice != IDYES {
        return Err("User declined WebView2 install".into());
    }

    // One-shot PowerShell: download the Evergreen Bootstrapper to %TEMP%
    // and run it with /silent /install. The bootstrapper then fetches the
    // full runtime from Microsoft and installs per-user (no admin needed).
    let script = format!(
        "$ErrorActionPreference='Stop'; \
         [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; \
         $tmp = Join-Path $env:TEMP 'SignarmSignal-WebView2Setup.exe'; \
         Invoke-WebRequest -UseBasicParsing -Uri '{EVERGREEN_URL}' -OutFile $tmp; \
         $p = Start-Process -Wait -PassThru -FilePath $tmp -ArgumentList '/silent','/install'; \
         if ($p.ExitCode -ne 0) {{ exit $p.ExitCode }}"
    );
    let status = Command::new("powershell")
        .args([
            "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
            "-WindowStyle", "Hidden", "-Command", &script,
        ])
        .status()?;
    if !status.success() {
        return Err(format!("WebView2 installer failed (exit {:?})", status.code()).into());
    }
    Ok(())
}

#[cfg(not(windows))]
fn install_webview2_runtime() -> Result<(), Box<dyn Error>> { Ok(()) }

fn launch() -> Result<i32, Box<dyn Error>> {
    if !webview2_installed() {
        install_webview2_runtime()?;
        if !webview2_installed() {
            return Err("WebView2 runtime did not finish installing".into());
        }
    }

    let install = cache_root().join(APP_VERSION);
    let exe_path = install.join("SignarmSignal.exe");
    let dll_path = install.join("WebView2Loader.dll");

    write_if_missing(&exe_path, APP_EXE)?;
    write_if_missing(&dll_path, WEBVIEW2_DLL)?;

    let mut cmd = Command::new(&exe_path);
    cmd.args(std::env::args().skip(1));
    cmd.current_dir(&install);

    let status = cmd.status()?;
    Ok(status.code().unwrap_or(0))
}

fn main() -> ExitCode {
    match launch() {
        Ok(code) => ExitCode::from(code.clamp(0, 255) as u8),
        Err(e) => {
            #[cfg(windows)]
            {
                message_box(
                    &format!("Failed to launch Signarm Signal:\n\n{e}"),
                    "Signarm Signal",
                    MB_ICONERROR,
                );
            }
            #[cfg(not(windows))]
            eprintln!("launcher: {e}");
            ExitCode::from(1)
        }
    }
}

// ---- tiny Win32 MessageBoxW wrapper (no windows crate needed) ----

#[cfg(windows)]
const MB_ICONINFO: u32 = 0x40;
#[cfg(windows)]
const MB_ICONERROR: u32 = 0x10;
#[cfg(windows)]
const MB_YESNO: u32 = 0x04;
#[cfg(windows)]
const IDYES: i32 = 6;

#[cfg(windows)]
fn message_box(text: &str, caption: &str, flags: u32) -> i32 {
    unsafe {
        let caption_w: Vec<u16> = caption.encode_utf16().chain([0]).collect();
        let text_w: Vec<u16> = text.encode_utf16().chain([0]).collect();
        MessageBoxW(std::ptr::null_mut(), text_w.as_ptr(), caption_w.as_ptr(), flags)
    }
}

#[cfg(windows)]
#[link(name = "user32")]
extern "system" {
    fn MessageBoxW(hwnd: *mut (), text: *const u16, caption: *const u16, utype: u32) -> i32;
}
