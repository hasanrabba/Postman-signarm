# Signal — Windows executable

This folder contains a prebuilt Windows binary for Signal, cross-compiled
from Linux using the GNU toolchain (x86_64-pc-windows-gnu).

## Files

| File | Size | Purpose |
|---|---|---|
| `Signal.exe` | 4.6 MB | The main GUI executable (PE32+, stripped) |
| `WebView2Loader.dll` | 160 KB | Runtime shim that loads the system WebView2 |

Keep both files together — `Signal.exe` looks for `WebView2Loader.dll` in
its own directory at launch.

## Run it

On Windows:

1. Make sure **Microsoft Edge WebView2 Runtime** is installed.
   - Pre-installed on Windows 11 and recent Windows 10 updates.
   - Otherwise download the "Evergreen Standalone Installer" from
     <https://developer.microsoft.com/microsoft-edge/webview2/>.
2. Double-click `Signal.exe`.

The binary is unsigned — Windows SmartScreen will show a warning the
first time. Click **More info → Run anyway**. For a signed build or
Microsoft Store submission, follow the checklist in the top-level
`README.md`.

## Caveats vs a Windows-native build

This EXE was produced with `x86_64-pc-windows-gnu` (MinGW) because the
build host is Linux. A Windows-native MSVC build (`x86_64-pc-windows-msvc`,
the path documented in the main README) will:

- Be a few hundred KB smaller and a hair faster to start.
- Integrate with the standard Windows Installer (`npm run build:desktop`
  produces `.msi` and NSIS `-setup.exe` installers — this folder only
  contains the raw EXE).
- Be required if you later want to sign it with a standard Windows code
  signing certificate chain.

For the Microsoft Store you will want the MSVC build and the MSI/MSIX
installers, not this raw EXE.
