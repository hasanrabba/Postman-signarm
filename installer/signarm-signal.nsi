; NSIS installer for Signarm Signal
;
; Produces SignarmSignal-Setup.exe that:
;   * Installs to %ProgramFiles%\Signarm Signal\
;   * Creates Start menu and Desktop shortcuts
;   * Registers with Add/Remove Programs (Settings > Apps > Installed apps)
;   * Writes a matching uninstaller
;
; Build from the repo root with: node scripts/build-installer.mjs

!define APPNAME        "Signarm Signal"
; Passed in by scripts/build-installer.mjs as -DAPPVERSION=<package.json
; version>. The literal below is only a fallback for a hand-run makensis:
; this value has to match the launcher's CARGO_PKG_VERSION, because the
; uninstaller cleans a cache directory stamped with it.
!ifndef APPVERSION
  !define APPVERSION   "0.1.0"
!endif
!ifndef APPVERSION4
  !define APPVERSION4  "${APPVERSION}.0"
!endif
!define APPEXE         "SignarmSignal.exe"
!define PUBLISHER      "Signarm"
!define PUBLISHER_URL  "https://github.com/hasanrabba/Postman-signarm"
!define REG_UNINSTALL  "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPNAME}"
!define STAGING        "staging"

Name           "${APPNAME}"
OutFile        "SignarmSignal-Setup.exe"
InstallDir     "$PROGRAMFILES64\${APPNAME}"
InstallDirRegKey HKLM "Software\${PUBLISHER}\${APPNAME}" "InstallDir"
RequestExecutionLevel admin
Unicode        True
ShowInstDetails show
ShowUnInstDetails show
SetCompressor  /SOLID lzma

!include "MUI2.nsh"
!include "LogicLib.nsh"

!define MUI_ICON   "${STAGING}\icon.ico"
!define MUI_UNICON "${STAGING}\icon.ico"
!define MUI_ABORTWARNING

!define MUI_WELCOMEPAGE_TITLE "Welcome to the ${APPNAME} Setup"
!define MUI_WELCOMEPAGE_TEXT  "This wizard will install ${APPNAME} ${APPVERSION} on your computer.$\r$\n$\r$\nClick Next to continue."

!define MUI_FINISHPAGE_RUN "$INSTDIR\${APPEXE}"
!define MUI_FINISHPAGE_RUN_TEXT "Launch ${APPNAME}"
!define MUI_FINISHPAGE_SHOWREADME ""
!define MUI_FINISHPAGE_SHOWREADME_NOTCHECKED
!define MUI_FINISHPAGE_SHOWREADME_TEXT "Create a desktop shortcut"
!define MUI_FINISHPAGE_SHOWREADME_FUNCTION CreateDesktopShortcut

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

VIProductVersion "${APPVERSION4}"
VIAddVersionKey  "ProductName"     "${APPNAME}"
VIAddVersionKey  "CompanyName"     "${PUBLISHER}"
VIAddVersionKey  "FileDescription" "${APPNAME} installer"
VIAddVersionKey  "FileVersion"     "${APPVERSION}"
VIAddVersionKey  "ProductVersion"  "${APPVERSION}"
VIAddVersionKey  "LegalCopyright"  "Copyright (c) 2026 ${PUBLISHER}"

Function CreateDesktopShortcut
  ; "current" resolves to whoever UAC elevated as, which is often not the
  ; person installing. This is a per-machine install, so use the shared
  ; desktop and every user gets the shortcut.
  SetShellVarContext all
  CreateShortCut "$DESKTOP\${APPNAME}.lnk" "$INSTDIR\${APPEXE}" "" "$INSTDIR\icon.ico" 0
FunctionEnd

!macro AddFileSize FilePath
  ${If} ${FileExists} "${FilePath}"
    FileOpen   $1 "${FilePath}" r
    FileSeek   $1 0 END $2
    FileClose  $1
    IntOp $0 $0 + $2
  ${EndIf}
!macroend

Function CalcSize
  ; Estimate installed size in KB for the Add/Remove Programs listing.
  ; Counting only the exe under-reported the install by the icon and the
  ; uninstaller.
  ClearErrors
  IntOp $0 0 + 0
  !insertmacro AddFileSize "$INSTDIR\${APPEXE}"
  !insertmacro AddFileSize "$INSTDIR\icon.ico"
  !insertmacro AddFileSize "$INSTDIR\uninstall.exe"
  IntOp $0 $0 / 1024
  Push $0
FunctionEnd

Section "Signarm Signal" SecMain
  SectionIn RO
  SetOutPath "$INSTDIR"

  File "${STAGING}\${APPEXE}"
  File "${STAGING}\icon.ico"

  ; Uninstaller
  WriteUninstaller "$INSTDIR\uninstall.exe"

  ; Start menu — top-level shortcut so Windows 11 Start and Windows Search
  ; surface "Signarm Signal" as a first-class result, plus a subfolder with
  ; the uninstaller for users who go looking for it.
  SetShellVarContext all
  CreateShortCut  "$SMPROGRAMS\${APPNAME}.lnk" "$INSTDIR\${APPEXE}" "" "$INSTDIR\icon.ico" 0
  CreateDirectory "$SMPROGRAMS\${APPNAME}"
  CreateShortCut  "$SMPROGRAMS\${APPNAME}\${APPNAME}.lnk" "$INSTDIR\${APPEXE}" "" "$INSTDIR\icon.ico" 0
  CreateShortCut  "$SMPROGRAMS\${APPNAME}\Uninstall ${APPNAME}.lnk" "$INSTDIR\uninstall.exe" "" "$INSTDIR\icon.ico" 0

  ; App Paths — lets users type the exe name into the Run dialog (Win+R)
  ; or Start search and have Windows resolve it to the install location.
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\App Paths\${APPEXE}" "" "$INSTDIR\${APPEXE}"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\App Paths\${APPEXE}" "Path" "$INSTDIR"

  ; Explicit registration with RegisteredApplications so the Start menu
  ; search indexer picks the app up quickly rather than waiting for a
  ; background Start Menu scan.
  WriteRegStr HKLM "Software\RegisteredApplications" "${APPNAME}" "Software\${PUBLISHER}\${APPNAME}\Capabilities"
  WriteRegStr HKLM "Software\${PUBLISHER}\${APPNAME}\Capabilities" "ApplicationName"        "${APPNAME}"
  WriteRegStr HKLM "Software\${PUBLISHER}\${APPNAME}\Capabilities" "ApplicationDescription" "${APPNAME} — API platform"
  WriteRegStr HKLM "Software\${PUBLISHER}\${APPNAME}\Capabilities" "ApplicationIcon"        "$INSTDIR\icon.ico,0"

  ; Install path record
  WriteRegStr HKLM "Software\${PUBLISHER}\${APPNAME}" "InstallDir" "$INSTDIR"
  WriteRegStr HKLM "Software\${PUBLISHER}\${APPNAME}" "Version"    "${APPVERSION}"

  ; Add / Remove Programs (Settings > Apps > Installed apps)
  WriteRegStr   HKLM "${REG_UNINSTALL}" "DisplayName"     "${APPNAME}"
  WriteRegStr   HKLM "${REG_UNINSTALL}" "DisplayVersion"  "${APPVERSION}"
  WriteRegStr   HKLM "${REG_UNINSTALL}" "DisplayIcon"     "$INSTDIR\icon.ico"
  WriteRegStr   HKLM "${REG_UNINSTALL}" "Publisher"       "${PUBLISHER}"
  WriteRegStr   HKLM "${REG_UNINSTALL}" "URLInfoAbout"    "${PUBLISHER_URL}"
  WriteRegStr   HKLM "${REG_UNINSTALL}" "InstallLocation" "$INSTDIR"
  WriteRegStr   HKLM "${REG_UNINSTALL}" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegStr   HKLM "${REG_UNINSTALL}" "QuietUninstallString" '"$INSTDIR\uninstall.exe" /S'
  WriteRegDWORD HKLM "${REG_UNINSTALL}" "NoModify" 1
  WriteRegDWORD HKLM "${REG_UNINSTALL}" "NoRepair" 1

  ; Size in KB
  Call CalcSize
  Pop $0
  WriteRegDWORD HKLM "${REG_UNINSTALL}" "EstimatedSize" $0
SectionEnd

Section "Uninstall"
  ; Deleting a running exe fails silently: the files would stay behind while
  ; the Add/Remove Programs entry disappeared, leaving an install that can no
  ; longer be uninstalled from Settings. Windows holds a write lock on a
  ; running image, so opening it for append tells us without needing a
  ; third-party process-list plugin.
  ${If} ${FileExists} "$INSTDIR\${APPEXE}"
    ClearErrors
    FileOpen $0 "$INSTDIR\${APPEXE}" a
    ${If} ${Errors}
      MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION \
        "${APPNAME} appears to be running.$\r$\n$\r$\nClose it, then click OK to continue." \
        IDOK continue
      Abort
      continue:
    ${Else}
      FileClose $0
    ${EndIf}
  ${EndIf}

  SetShellVarContext all

  Delete "$SMPROGRAMS\${APPNAME}.lnk"
  Delete "$SMPROGRAMS\${APPNAME}\${APPNAME}.lnk"
  Delete "$SMPROGRAMS\${APPNAME}\Uninstall ${APPNAME}.lnk"
  RMDir  "$SMPROGRAMS\${APPNAME}"

  SetShellVarContext current
  Delete "$DESKTOP\${APPNAME}.lnk"

  Delete "$INSTDIR\${APPEXE}"
  Delete "$INSTDIR\icon.ico"
  Delete "$INSTDIR\uninstall.exe"
  RMDir  "$INSTDIR"
  ${If} ${FileExists} "$INSTDIR\${APPEXE}"
    MessageBox MB_OK|MB_ICONEXCLAMATION \
      "Some files could not be removed from $INSTDIR.$\r$\n$\r$\nDelete the folder manually once ${APPNAME} has closed."
  ${EndIf}

  DeleteRegKey HKLM "${REG_UNINSTALL}"
  DeleteRegKey HKLM "Software\${PUBLISHER}\${APPNAME}"
  DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\App Paths\${APPEXE}"
  DeleteRegValue HKLM "Software\RegisteredApplications" "${APPNAME}"

  ; Best-effort cleanup of the per-user launcher cache. Removing the whole
  ; tree rather than only this version's folder, because upgrades leave one
  ; directory per version behind and the uninstaller is the last chance to
  ; collect them. The webview2 user data (LocalStorage with the user's
  ; collections) lives under com.signarm.signal and is deliberately left
  ; alone so reinstalls are lossless; see the README for the manual path.
  SetShellVarContext current
  RMDir /r "$LOCALAPPDATA\SignarmSignal"
SectionEnd
