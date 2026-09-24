; installer.nsh — injected by electron-builder via `nsis.include`.
;
; Adds an OPTIONAL "Bootstrap Blockchain Data" component that downloads
; BootstrapChain.zip from download.alias.cash and extracts it into
; %APPDATA%\Aliaswallet. Mirrors the original Alias 4.4.0 Inno Setup
; installer's [Components] section.
;
; The archive is rebuilt periodically and its size changes (it was 3.95 GB,
; it is now 5.43 GB), so the size is read from the server at run time and
; never compiled in.
;
; Flow:
;   Language selector (electron-builder MUI_LANGDLL)  →
;   License Agreement (electron-builder licensePage)  →
;   Destination Folder (electron-builder MUI_PAGE_DIRECTORY) →
;   Select Components (this file: MUI_PAGE_COMPONENTS)  →
;   Installing (electron-builder MUI_PAGE_INSTFILES, runs both sections) →
;   Finish

; Header bitmap (top-right) and finish-page sidebar bitmap are configured
; via electron-builder's `nsis.installerHeader` / `nsis.installerSidebar`
; in package.json. They can't be set with !define here because
; customHeader runs AFTER electron-builder's MUI page macros have already
; been expanded.

; Components page support — electron-builder doesn't insert this page
; by default. The `customPageAfterChangeDir` macro hook is invoked
; AFTER MUI_PAGE_DIRECTORY and BEFORE MUI_PAGE_INSTFILES — the right
; place for a Components page.
!define MUI_COMPONENTSPAGE_NODESC
!macro customPageAfterChangeDir
  !insertmacro MUI_PAGE_COMPONENTS
!macroend

; electron-builder names its main install section "install" via
;   Section "install" INSTALL_SECTION_ID
; which shows up verbatim on the Components page. Rename it at runtime
; using SectionSetText with the section's literal index (1) — `Bootstrap`
; below is section 0, electron-builder's install is section 1.
; (${INSTALL_SECTION_ID} can't be used here because the symbol isn't
; defined yet when the NSIS compiler expands this macro.)
!macro customInit
  SectionSetText 1 "Install ALIAS Wallet"

  ; Ask the server how big the archive is, so the component label never
  ; carries a stale number. Fails safe: no size shown if the HEAD does not
  ; come back, and the installer carries on either way.
  StrCpy $R0 ""
  NScurl::http HEAD "${BOOTSTRAP_URL}" "" /CONNECTTIMEOUT 10000 /TIMEOUT 20000 /SILENT /END
  Pop $R1
  StrCmp $R1 "OK" 0 bootstrap_size_unknown
    NScurl::query "@FILESIZE@"
    Pop $R0
  bootstrap_size_unknown:
  StrCmp $R0 "" 0 bootstrap_size_known
    SectionSetText 0 "Bootstrap Blockchain Data"
    Goto bootstrap_size_done
  bootstrap_size_known:
    SectionSetText 0 "Bootstrap Blockchain Data ($R0)"
  bootstrap_size_done:
!macroend

; Point NSIS at the INetC plugin we bundled under build/nsis-plugins/.
; BUILD_RESOURCES_DIR is electron-builder's macro for the project's
; build/ folder.
!define BOOTSTRAP_URL "https://download.alias.cash/files/bootstrap/BootstrapChain.zip"
; A single reset used to abort the whole multi-GB transfer. /RESUME continues
; from the bytes already on disk, so retrying costs only what was lost.
!define BOOTSTRAP_TRIES 5

!addplugindir /x86-unicode "${BUILD_RESOURCES_DIR}\nsis-plugins\x86-unicode"
!addplugindir /x86-ansi    "${BUILD_RESOURCES_DIR}\nsis-plugins\x86-ansi"
!addplugindir /amd64-unicode "${BUILD_RESOURCES_DIR}\nsis-plugins\amd64-unicode"

; OPTIONAL section — checked by default but user can uncheck.
Section "Bootstrap Blockchain Data" SecBootstrap
  ; Destination is the daemon's hardcoded data dir
  ; (util.cpp GetDefaultDataDir() = %APPDATA%\Aliaswallet on Windows).
  StrCpy $0 "$APPDATA\Aliaswallet"
  CreateDirectory $0

  StrCpy $1 "$TEMP\AliasBootstrap.zip"
  IfFileExists $1 0 +2
    Delete $1

  ; NScurl /PAGE mode drives the standard installer-page progress bar
  ; directly. No popup, no URL / file path / byte counts on display, and
  ; the bar updates smoothly with bytes-received.
  ;
  ; NScurl has no retry option of its own, so loop here. A dropped
  ; connection part-way through a multi-GB download is common; without this
  ; the first drop aborted the whole thing and the user saw only an error.
  StrCpy $4 0
  bootstrap_try:
  IntOp $4 $4 + 1
  DetailPrint "Downloading BootstrapChain.zip from download.alias.cash (attempt $4 of ${BOOTSTRAP_TRIES}) ..."
  NScurl::http GET "${BOOTSTRAP_URL}" "$1" /CANCEL /RESUME /END
  Pop $2
  DetailPrint "NScurl returned: $2"
  StrCmp $2 "OK" download_ok
  StrCmp $2 "Cancelled" bootstrap_done
  StrCmp $2 "Canceled" bootstrap_done
  IntCmp $4 ${BOOTSTRAP_TRIES} bootstrap_failed bootstrap_wait bootstrap_failed

  bootstrap_wait:
  DetailPrint "Attempt $4 failed ($2). Resuming in 10 seconds ..."
  Sleep 10000
  Goto bootstrap_try

  bootstrap_failed:
  MessageBox MB_OK|MB_ICONEXCLAMATION \
    "Bootstrap download failed after ${BOOTSTRAP_TRIES} attempts: $2$\n$\n\
     ALIAS will still install, but the wallet will need to sync from peers on first run (slow)."
  Goto bootstrap_done

  download_ok:
  DetailPrint "Extracting blockchain data into $0 ..."
  ; Windows-bundled tar.exe (Win10+) handles zip via libarchive.
  nsExec::ExecToLog 'tar.exe -xf "$1" -C "$0"'
  Pop $3
  IntCmp $3 0 extract_ok
    MessageBox MB_OK|MB_ICONEXCLAMATION \
      "Extracting BootstrapChain.zip failed (tar exit code $3).$\n$\n\
       The downloaded zip is at $1 — you can extract it manually into $0."
    Goto bootstrap_done

  extract_ok:
  DetailPrint "Cleaning up temporary download ..."
  Delete $1

  bootstrap_done:
SectionEnd

; (per-section descriptions intentionally omitted — language IDs aren't
; loaded yet at customHeader time, so LangString here trips warning 7025
; which electron-builder treats as a build-fail. MUI_COMPONENTSPAGE_NODESC
; above hides the description pane entirely.)
