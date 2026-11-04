; IcecreamSheets — custom NSIS installer script for electron-builder.
;
; WHY CUSTOM: electron-builder's stock NSIS flow generates its uninstaller by
; RUNNING an intermediate installer under Wine — even when building on Linux.
; This build container cannot run Wine (distro Wine segfaults; the
; electron-builder-bundled Wine 11 fails to initialise with c0000135), so the
; stock flow cannot complete here. This script instead uses NSIS's native
; WriteUninstaller (a compile-time feature — no Wine needed) and is compiled
; by the stock makensis that electron-builder already downloads.
;
; electron-builder prepends its standard header (StdUtils.nsh, NSIS plugin
; dirs, the `addLangs` language macro) and passes -D defines, including:
;   PRODUCT_NAME, PRODUCT_FILENAME, APP_FILENAME, VERSION, PROJECT_DIR,
;   APP_ID, UNINSTALL_APP_KEY, UNINSTALL_DISPLAY_NAME, ESTIMATED_SIZE
; Commands (OutFile, VIProductVersion, VIAddVersionKey, Unicode) arrive via -X.
;
; Result: a per-user (no UAC) installer with Start Menu + desktop shortcuts,
; Add/Remove Programs registration, and a working uninstaller.

!include "MUI2.nsh"

Name "${PRODUCT_NAME}"
; NOTE: SetCompressor /SOLID lzma is intentionally NOT used — makensis
; segfaults (SIGBUS) with solid compression on this app's file tree in
; Linux containers. The default zlib compressor works reliably.
RequestExecutionLevel user

InstallDir "$LOCALAPPDATA\${APP_FILENAME}"
InstallDirRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}" "InstallLocation"

; ---- Pages ----
!define MUI_ABORTWARNING
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_RUN "$INSTDIR\${PRODUCT_FILENAME}.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Run ${PRODUCT_NAME}"
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro addLangs

; ---- Install ----
Section "Install"
  SetOutPath "$INSTDIR"
  File /r "${PROJECT_DIR}/dist/win-unpacked/*"

  WriteUninstaller "$INSTDIR\Uninstall.exe"

  CreateDirectory "$SMPROGRAMS\${PRODUCT_FILENAME}"
  CreateShortcut "$SMPROGRAMS\${PRODUCT_FILENAME}\${PRODUCT_NAME}.lnk" "$INSTDIR\${PRODUCT_FILENAME}.exe"
  CreateShortcut "$DESKTOP\${PRODUCT_NAME}.lnk" "$INSTDIR\${PRODUCT_FILENAME}.exe"

  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}" "DisplayName" "${UNINSTALL_DISPLAY_NAME}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}" "DisplayIcon" "$INSTDIR\${PRODUCT_FILENAME}.exe,0"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}" "EstimatedSize" ${ESTIMATED_SIZE}
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}" "NoRepair" 1
SectionEnd

; ---- Uninstall ----
Section "Uninstall"
  Delete "$SMPROGRAMS\${PRODUCT_FILENAME}\${PRODUCT_NAME}.lnk"
  RMDir "$SMPROGRAMS\${PRODUCT_FILENAME}"
  Delete "$DESKTOP\${PRODUCT_NAME}.lnk"

  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}"

  RMDir /r "$INSTDIR"
SectionEnd
