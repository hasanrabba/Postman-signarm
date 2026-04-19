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
!define APPVERSION     "0.1.0"
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

VIProductVersion "0.1.0.0"
VIAddVersionKey  "ProductName"     "${APPNAME}"
VIAddVersionKey  "CompanyName"     "${PUBLISHER}"
VIAddVersionKey  "FileDescription" "${APPNAME} installer"
VIAddVersionKey  "FileVersion"     "${APPVERSION}"
VIAddVersionKey  "ProductVersion"  "${APPVERSION}"
VIAddVersionKey  "LegalCopyright"  "Copyright (c) 2026 ${PUBLISHER}"

Function CreateDesktopShortcut
  SetShellVarContext current
  CreateShortCut "$DESKTOP\${APPNAME}.lnk" "$INSTDIR\${APPEXE}" "" "$INSTDIR\${APPEXE}" 0
FunctionEnd

Function CalcSize
  ; Estimate installed size in KB for the Add/Remove Programs listing.
  ClearErrors
  IntOp $0 0 + 0
  ${If} ${FileExists} "$INSTDIR\${APPEXE}"
    FileOpen   $1 "$INSTDIR\${APPEXE}" r
    FileSeek   $1 0 END $2
    FileClose  $1
    IntOp $0 $0 + $2
  ${EndIf}
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

  ; Start menu
  SetShellVarContext all
  CreateDirectory "$SMPROGRAMS\${APPNAME}"
  CreateShortCut  "$SMPROGRAMS\${APPNAME}\${APPNAME}.lnk"  "$INSTDIR\${APPEXE}"   "" "$INSTDIR\${APPEXE}" 0
  CreateShortCut  "$SMPROGRAMS\${APPNAME}\Uninstall ${APPNAME}.lnk" "$INSTDIR\uninstall.exe" "" "$INSTDIR\uninstall.exe" 0

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
  SetShellVarContext all

  Delete "$SMPROGRAMS\${APPNAME}\${APPNAME}.lnk"
  Delete "$SMPROGRAMS\${APPNAME}\Uninstall ${APPNAME}.lnk"
  RMDir  "$SMPROGRAMS\${APPNAME}"

  SetShellVarContext current
  Delete "$DESKTOP\${APPNAME}.lnk"

  Delete "$INSTDIR\${APPEXE}"
  Delete "$INSTDIR\icon.ico"
  Delete "$INSTDIR\uninstall.exe"
  RMDir  "$INSTDIR"

  DeleteRegKey HKLM "${REG_UNINSTALL}"
  DeleteRegKey HKLM "Software\${PUBLISHER}\${APPNAME}"

  ; Best-effort cleanup of per-user launcher cache. Leave the webview2
  ; user data (LocalStorage with the user's collections) untouched so
  ; reinstalls are lossless; see docs/README for the manual path.
  SetShellVarContext current
  RMDir /r "$LOCALAPPDATA\SignarmSignal\${APPVERSION}"
SectionEnd
