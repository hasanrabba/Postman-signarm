# Signarm Signal — Windows executable

A **single-file** Windows binary for Signarm Signal.

## Files

| File | Size | Purpose |
|---|---|---|
| `SignarmSignal.exe` | ~5.3 MB | Self-extracting launcher (GUI) |

That's it — no side-car DLL. The launcher embeds the main Tauri binary
and `WebView2Loader.dll` and writes them to
`%LOCALAPPDATA%\SignarmSignal\<version>\` on first run. Subsequent
launches reuse the extracted files.

## Run it

On Windows:

1. Make sure **Microsoft Edge WebView2 Runtime** is installed.
   - Pre-installed on Windows 11 and recent Windows 10 updates.
   - Otherwise download the "Evergreen Standalone Installer" from
     <https://developer.microsoft.com/microsoft-edge/webview2/>.
2. Double-click `SignarmSignal.exe`.

On first run the launcher extracts to
`%LOCALAPPDATA%\SignarmSignal\0.1.0\` (takes <1 second). If
`%LOCALAPPDATA%` isn't set (unlikely), it falls back to the system
temp directory.

The binary is unsigned — Windows SmartScreen will show a warning the
first time. Click **More info → Run anyway**. For a signed build or
Microsoft Store submission, follow the checklist in the top-level
`README.md`.

## How the launcher works

- Source: [`launcher/src/main.rs`](../launcher/src/main.rs)
- `include_bytes!` embeds the real `SignarmSignal.exe` and
  `WebView2Loader.dll` at compile time
- At startup it writes them to `%LOCALAPPDATA%\SignarmSignal\<version>\`
  (only if the files aren't already there with the right size)
- It then spawns the real binary via `std::process::Command` and
  propagates the exit code

The launcher itself has no WebView2 dependency, so Windows loads it
cleanly before `main()` runs and we control how the real binary is
invoked.

## Caveats vs a Windows-native MSVC build

This EXE was cross-compiled with `x86_64-pc-windows-gnu` (MinGW) from
Linux. A Windows-native MSVC build (`x86_64-pc-windows-msvc`, via
`npm run build:desktop` on a Windows host) will:

- Be a few hundred KB smaller and a hair faster to start.
- Produce `.msi` and NSIS `-setup.exe` installers for proper install,
  uninstall, and Start-menu integration.
- Be required if you want to sign it with a standard Windows code
  signing certificate chain.

For the Microsoft Store you will want the MSVC build and the MSI/MSIX
installer, not this raw launcher.
