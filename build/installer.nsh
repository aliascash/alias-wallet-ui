; installer.nsh — injected by electron-builder via `nsis.include`.
;
; Adds an OPTIONAL "Bootstrap Blockchain Data" component that downloads
; BootstrapChain.zip from download.alias.cash and extracts it into
; the wallet data directory. Mirrors the original Alias 4.4.0 Inno Setup
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
!include Sections.nsh
!include LogicLib.nsh

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
  NScurl::http HEAD "${BOOTSTRAP_URL}" "" /CASTORE true /HTTP1.1 /USERAGENT "${BOOTSTRAP_UA}" /CONNECTTIMEOUT 10000 /TIMEOUT 20000 /SILENT /END
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

; TLS options, in one place so the HEAD and the GET stay identical.
;
; /CASTORE true is the important one. NScurl ships its own cacert.pem and
; trusts only that by default, so when antivirus or a corporate proxy
; intercepts TLS -- presenting a certificate signed by a root CA installed
; locally in Windows -- the handshake fails with 0x23 CURLE_SSL_CONNECT_ERROR
; before a single byte arrives. Browsers succeed on the same machine because
; they use the Windows certificate store, which has that root. This makes
; NScurl do the same.
;
; /HTTP1.1 avoids HTTP/2 through middleboxes that mishandle it, and a normal
; User-Agent stops naive filters rejecting the request outright.
!define BOOTSTRAP_UA "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

!addplugindir /x86-unicode "${BUILD_RESOURCES_DIR}\nsis-plugins\x86-unicode"
!addplugindir /x86-ansi    "${BUILD_RESOURCES_DIR}\nsis-plugins\x86-ansi"
!addplugindir /amd64-unicode "${BUILD_RESOURCES_DIR}\nsis-plugins\amd64-unicode"

; OPTIONAL section — checked by default but user can uncheck.
; OPTIONAL component — the checkbox only. The work happens in
; customInstall below, NOT here.
;
; NSIS runs sections in the order they are defined, and this file is
; included before electron-builder's own install section. With the download
; in here it ran FIRST, so a user who cancelled or gave up during the
; multi-GB download ended up with no application installed at all, at the
; path the wizard had just shown them. customInstall is expanded inside
; electron-builder's section, after the app files are in place.
Section "Bootstrap Blockchain Data" SecBootstrap
SectionEnd

!macro customInstall
  ${Unless} ${SectionIsSelected} ${SecBootstrap}
    Goto bootstrap_skipped
  ${EndUnless}
  ; Data directory, chosen by install scope:
  ;   all users     -> C:\ProgramData\ALIAS   (shared, every account uses it)
  ;   current user  -> %APPDATA%\ALIAS         (that account only)
  ; SetShellVarContext decides which $APPDATA expands to, so one expression
  ; covers both. It is NOT put inside $INSTDIR: for an all-users install that
  ; is Program Files, which standard users cannot write to, and the daemon has
  ; to write the chain and wallet.dat there every session.
  ;
  ; $INSTDIR under Program Files means this was an elevated all-users install.
  StrCpy $6 "user"
  StrLen $7 "$PROGRAMFILES64"
  StrCpy $8 "$INSTDIR" $7
  StrCmp $8 "$PROGRAMFILES64" 0 +2
    StrCpy $6 "machine"
  StrLen $7 "$PROGRAMFILES"
  StrCpy $8 "$INSTDIR" $7
  StrCmp $8 "$PROGRAMFILES" 0 +2
    StrCpy $6 "machine"

  StrCmp $6 "machine" 0 datadir_user
    SetShellVarContext all
    StrCpy $0 "$APPDATA\ALIAS"
    CreateDirectory $0
    ; ProgramData subfolders are not writable by ordinary users by default,
    ; and the daemon runs unelevated. S-1-5-32-545 is the built-in Users
    ; group by SID, so this works on non-English Windows too.
    nsExec::ExecToLog 'icacls "$0" /grant *S-1-5-32-545:(OI)(CI)M /T /C'
    Pop $9
    DetailPrint "Granting users write access to $0 returned $9"
    SetShellVarContext current
    Goto datadir_done
  datadir_user:
    StrCpy $0 "$APPDATA\ALIAS"
    CreateDirectory $0
  datadir_done:

  ; The app reads this to find the same directory. Without it the app would
  ; default to the per-user path and an all-users install would look empty.
  FileOpen $9 "$INSTDIR\datadir.txt" w
  FileWrite $9 "$0"
  FileClose $9
  DetailPrint "Data directory ($6 install): $0"

  ; Same name as on the server, so the progress line shows something the
  ; user recognises. Left in place on failure: /RESUME continues from these
  ; bytes, so re-running the installer picks up where it stopped instead of
  ; starting the multi-GB download again. It is deleted after extraction.
  StrCpy $1 "$TEMP\BootstrapChain.zip"

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
  NScurl::http GET "${BOOTSTRAP_URL}" "$1" /CASTORE true /HTTP1.1 /USERAGENT "${BOOTSTRAP_UA}" /CANCEL /RESUME /END
  Pop $2
  DetailPrint "NScurl returned: $2"
  StrCmp $2 "OK" download_ok
  StrCmp $2 "Cancelled" bootstrap_done
  StrCmp $2 "Canceled" bootstrap_done
  IntCmp $4 ${BOOTSTRAP_TRIES} bootstrap_failed bootstrap_wait bootstrap_failed

  bootstrap_wait:
  ; back off a little further each time rather than hammering at a fixed rate
  IntOp $5 $4 * 5000
  DetailPrint "Attempt $4 failed ($2). Resuming in $4 x 5 seconds ..."
  Sleep $5
  Goto bootstrap_try

  bootstrap_failed:
  ; Security software that intercepts TLS can block this download while the
  ; browser on the same machine works, so always offer the manual route.
  MessageBox MB_OK|MB_ICONEXCLAMATION \
    "Bootstrap download failed after ${BOOTSTRAP_TRIES} attempts: $2$\n$\n\
     ALIAS will still install and can sync from peers on first run, but that is slow.$\n$\n\
     To use the bootstrap instead, download this in your browser:$\n\
     ${BOOTSTRAP_URL}$\n$\n\
     then extract the contents into:$\n$0"
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
  bootstrap_skipped:
!macroend

; (per-section descriptions intentionally omitted — language IDs aren't
; loaded yet at customHeader time, so LangString here trips warning 7025
; which electron-builder treats as a build-fail. MUI_COMPONENTSPAGE_NODESC
; above hides the description pane entirely.)
