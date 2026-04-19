# Signarm Signal — Windows binaries

Two flavours of the same app. Most users want the installer.

| File | Size | What it does |
|---|---|---|
| `SignarmSignal-Setup.exe` | ~2.2 MB | **Proper installer.** UAC prompt → "Next → Next → Install" wizard. Drops the app in `Program Files\Signarm Signal\`, adds Start menu + optional Desktop shortcut, and registers with Settings → Apps → Installed apps so you can uninstall like any other Windows app. |
| `SignarmSignal.exe` | ~5.5 MB | **Portable single-file build.** Double-click to run. Extracts itself under `%LOCALAPPDATA%\SignarmSignal\`. Good for USB drives or locked-down machines where you can't install software. |

## Install it (recommended path)

1. Download `SignarmSignal-Setup.exe`.
2. Double-click. Windows SmartScreen will warn (unsigned, one-time) →
   **More info → Run anyway**.
3. UAC prompts for admin → **Yes**.
4. Walk the wizard (Next → Install → Finish).
   - Optional "Create a desktop shortcut" checkbox on the last screen.
   - Optional "Launch Signarm Signal" checkbox on the last screen.
5. From now on the app shows up in:
   - **Start menu** → Signarm Signal → `Signarm Signal`
   - **Settings → Apps → Installed apps** → Signarm Signal (click →
     Uninstall)
   - Desktop shortcut (if you ticked the box)

WebView2 Runtime is detected automatically on first run; if it's not
present the app will offer to install it from Microsoft (one-time).

## Uninstall

Either:
- **Settings → Apps → Installed apps → Signarm Signal → Uninstall**, or
- **Start menu → Signarm Signal → Uninstall Signarm Signal**

The uninstaller removes the program and shortcuts but **does not** wipe
your collections, environments, history, and vault data
(stored under `%LOCALAPPDATA%\SignarmSignal\…\WebView2`), so you can
reinstall without losing anything. To wipe everything too:

```cmd
rd /s /q %LOCALAPPDATA%\SignarmSignal
```

## Portable run

If you don't want to install:

1. Download `SignarmSignal.exe`.
2. Double-click. It unpacks to `%LOCALAPPDATA%\SignarmSignal\<version>\`
   the first time and launches the app.
3. No Start menu entry, no Add/Remove Programs entry.

## Caveats

Both builds are **unsigned**. SmartScreen will warn the first time. For
Microsoft Store submission you'd need:

- MSVC-native build (`npm run build:desktop` on a Windows host).
- Code signing certificate.
- MSIX packaging (not MSI/NSIS).

Full checklist in the top-level `README.md`.
