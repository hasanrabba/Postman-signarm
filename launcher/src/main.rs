// Signarm Signal single-file launcher.
//
// The main Tauri binary imports WebView2Loader.dll at PE-load time, so a raw
// EXE needs the DLL sitting next to it. Rather than ship two files, we embed
// both payloads inside this tiny launcher and extract them to a per-version
// folder in LOCALAPPDATA the first time the user runs it. Subsequent launches
// skip the extraction and just spawn the real binary.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::error::Error;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};

const APP_EXE: &[u8] = include_bytes!("../payload/SignarmSignal.exe");
const WEBVIEW2_DLL: &[u8] = include_bytes!("../payload/WebView2Loader.dll");
const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

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

fn launch() -> Result<i32, Box<dyn Error>> {
    let install = cache_root().join(APP_VERSION);
    let exe_path = install.join("SignarmSignal.exe");
    let dll_path = install.join("WebView2Loader.dll");

    write_if_missing(&exe_path, APP_EXE)?;
    write_if_missing(&dll_path, WEBVIEW2_DLL)?;

    let mut cmd = Command::new(&exe_path);
    // Forward CLI args so double-click and command-line flags both work.
    cmd.args(std::env::args().skip(1));
    cmd.current_dir(&install);

    // Use status() rather than spawn() so the launcher's exit code tracks
    // the child's. The launcher is a GUI subsystem binary, so the parent
    // shell doesn't block on it — this really only matters for automation
    // that invokes it from a console.
    let status = cmd.status()?;
    Ok(status.code().unwrap_or(0))
}

fn main() -> ExitCode {
    match launch() {
        Ok(code) => ExitCode::from(code.clamp(0, 255) as u8),
        Err(e) => {
            // Surface the error in a Windows MessageBox so GUI users see it.
            #[cfg(windows)]
            unsafe {
                let title: Vec<u16> = "Signarm Signal".encode_utf16().chain([0]).collect();
                let msg: String = format!("Failed to launch Signarm Signal:\n\n{e}");
                let msg_wide: Vec<u16> = msg.encode_utf16().chain([0]).collect();
                MessageBoxW(std::ptr::null_mut(), msg_wide.as_ptr(), title.as_ptr(), 0x10);
            }
            #[cfg(not(windows))]
            eprintln!("launcher: {e}");
            ExitCode::from(1)
        }
    }
}

#[cfg(windows)]
#[link(name = "user32")]
extern "system" {
    fn MessageBoxW(hwnd: *mut (), text: *const u16, caption: *const u16, utype: u32) -> i32;
}
