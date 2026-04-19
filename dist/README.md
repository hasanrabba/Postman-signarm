# Signarm Signal — Windows executable

A **single-file** Windows binary for Signarm Signal.

## Download

`SignarmSignal.exe` (~5.3 MB, PE32+ GUI)

## Run it

Double-click the exe. That's it.

On first launch the wrapper:

1. Checks the registry for **Microsoft Edge WebView2 Runtime**.
   - WebView2 is a Microsoft-maintained Windows component, pre-installed
     on Windows 11 and recent Windows 10 builds.
   - On older systems where it's missing, you'll get a one-time prompt:
     *"Signarm Signal needs Microsoft Edge WebView2. Download and
     install it now?"* → click Yes and it installs silently (~30s).
2. Extracts the real Tauri binary and `WebView2Loader.dll` to
   `%LOCALAPPDATA%\SignarmSignal\<version>\` (idempotent; subsequent
   runs skip this step).
3. Launches the app and forwards the exit code.

### SmartScreen

The binary is **unsigned**, so Windows SmartScreen will warn the first
time. Click **More info → Run anyway**. For a signed build or Microsoft
Store submission, follow the checklist in the top-level `README.md`.

## How the launcher works

Source: [`launcher/src/main.rs`](../launcher/src/main.rs)

- `include_bytes!` embeds the real `SignarmSignal.exe` and
  `WebView2Loader.dll` at compile time
- Registry check for the WebView2 Runtime CLSID
  (`{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}`) under three hives:
  `HKLM\…\EdgeUpdate\Clients\…`,
  `HKLM\WOW6432Node\…` and `HKCU\…`
- If missing: a one-liner PowerShell helper downloads Microsoft's
  Evergreen Bootstrapper from `go.microsoft.com/fwlink/p/?LinkId=2124703`
  and runs `MicrosoftEdgeWebview2Setup.exe /silent /install`
- The launcher itself has no WebView2 dependency, so Windows loads it
  cleanly before `main()` runs
- Spawns the real binary via `std::process::Command` and propagates
  stdout/exit code

Adds ~350 KB over the raw payload for self-extraction + WebView2 detection
and install.

## Caveats vs a Windows-native MSVC build

This EXE was cross-compiled with `x86_64-pc-windows-gnu` (MinGW) from
Linux. A Windows-native MSVC build (`x86_64-pc-windows-msvc`, via
`npm run build:desktop` on a Windows host) will:

- Be a few hundred KB smaller and a hair faster to start.
- Produce `.msi` and NSIS `-setup.exe` installers for proper Add/Remove
  Programs and Start-menu integration.
- Be required if you want to sign it with a standard Windows code
  signing certificate chain.

For the Microsoft Store you will want the MSVC build plus MSIX
packaging, not this raw launcher.
