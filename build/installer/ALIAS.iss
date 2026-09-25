; ============================================================================
; ALIAS Wallet installer (Inno Setup 6.4+)
;
; Packages the electron-builder output in app\ and, optionally, downloads the
; blockchain bootstrap.
;
; Why Inno rather than electron-builder's NSIS target:
;   - NSIS variables are 32-bit. The bootstrap is >4 GB, so every byte counter
;     and percentage overflows and the progress bar sits at 0.0% forever.
;     Inno's download progress uses Int64 and reports correctly.
;   - NSIS's NScurl carries its own libcurl and TLS stack, which security
;     software blocks on some machines (curl error 0x23, connection reset
;     during the TLS handshake) while the same machine downloads fine in a
;     browser. Inno uses the Windows HTTP stack, which those machines allow.
;
; Build:  ISCC.exe /DArch=x64 ALIAS.iss        (or /DArch=x86)
;         expects the app in .\app and this file's assets one level up.
; ============================================================================

#define MyAppName "ALIAS"
#define MyAppExeName "ALIAS.exe"
#define MyAppPublisher "ALIAS Developers"
#define MyAppURL "https://alias.cash"

; Version comes from package.json via /DMyAppVersion; keep a default so the
; script still compiles when run by hand.
#ifndef MyAppVersion
  #define MyAppVersion "5.1.0"
#endif
#ifndef Arch
  #define Arch "x64"
#endif

#define BootstrapURL "https://download.alias.cash/files/bootstrap/BootstrapChain.zip"
; Only an estimate, used for the disk-space check and the initial progress
; display; the real total comes from the server's Content-Length. Refresh it
; when the bootstrap is rebuilt -- a stale value skews the estimate but does
; not break the download.
#define BootstrapSize 5434257988

[Setup]
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
VersionInfoVersion={#MyAppVersion}

; Offer "for all users" vs "for me only" instead of forcing one. {autopf} and
; {autoappdata} then resolve per that choice, so one script covers both.
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
DefaultDirName={autopf}\{#MyAppName}
DisableProgramGroupPage=yes
UninstallDisplayIcon={app}\{#MyAppExeName}
UninstallDisplayName={#MyAppName} {#MyAppVersion}

#if Arch == "x64"
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
#endif

OutputBaseFilename=ALIAS-Setup-{#MyAppVersion}-{#Arch}
OutputDir=..\..\dist
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
LicenseFile=..\license.txt
SetupIconFile=..\icon.ico
; installerHeader.bmp is 150x57 -- an NSIS banner shape. Inno's modern wizard
; small image slot is roughly square, so that got stretched into the distorted
; logo in the corner. These are generated from build/icon.png at the sizes Inno
; expects, with a 2x variant for HiDPI.
WizardSmallImageFile=wizard-small.bmp,wizard-small@2x.bmp
WizardImageFile=..\installerSidebar.bmp

; Required for the `extractarchive` flag below.
ArchiveExtraction=full

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"
Name: "german";  MessagesFile: "compiler:Languages\German.isl"
Name: "spanish"; MessagesFile: "compiler:Languages\Spanish.isl"
Name: "french";  MessagesFile: "compiler:Languages\French.isl"
Name: "italian"; MessagesFile: "compiler:Languages\Italian.isl"
Name: "turkish"; MessagesFile: "compiler:Languages\Turkish.isl"
Name: "russian"; MessagesFile: "compiler:Languages\Russian.isl"

[Components]
Name: "main";      Description: "Install ALIAS Wallet"; Types: full compact custom; Flags: fixed
Name: "bootstrap"; Description: "Bootstrap Blockchain Data"; Types: full

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"

[Files]
Source: "app\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs; Components: main

; Downloaded straight from the server and unpacked, no plugin needed (Inno
; 6.4+). It lands in {autoappdata} rather than the data dir because the
; archive has its own BootstrapChain\ top-level folder -- CurStepChanged
; below moves the contents into place.
Source: "{#BootstrapURL}"; DestName: "BootstrapChain.zip"; DestDir: "{autoappdata}"; \
  ExternalSize: {#BootstrapSize}; \
  Flags: external download extractarchive ignoreversion; \
  Components: bootstrap

[Icons]
Name: "{autoprograms}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{autodesktop}\{#MyAppName}";  Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "{cm:LaunchProgram,{#MyAppName}}"; \
  Flags: nowait postinstall skipifsilent

[Code]
// The data directory follows the install scope: %APPDATA%\ALIAS for a
// per-user install, C:\ProgramData\ALIAS for all users. {autoappdata} already
// resolves that way, so the app and the installer agree without a second rule.
function DataDir(): String;
begin
  Result := ExpandConstant('{autoappdata}\{#MyAppName}');
end;

// Move BootstrapChain\* up into the data dir. The archive nests everything
// under that folder, so extracting straight into the data dir would leave the
// daemon looking at an empty directory and syncing from genesis instead.
procedure MoveBootstrapIntoPlace();
var
  Extracted, Target: String;
  FindRec: TFindRec;
  Failed: Integer;
begin
  Extracted := ExpandConstant('{autoappdata}\BootstrapChain');
  Target := DataDir();

  // Only relevant when the user asked for the bootstrap. If they did and the
  // folder is not here, the download or the extraction went somewhere we did
  // not expect -- say so, because the alternative is a silent success
  // followed by the wallet syncing from genesis with no explanation.
  if not DirExists(Extracted) then
  begin
    if WizardIsComponentSelected('bootstrap') and not FileExists(Target + '\blk0001.dat') then
      MsgBox('The blockchain data was downloaded but could not be found at:' #13#10 +
             Extracted + #13#10#13#10 +
             'ALIAS will still work, but it will sync from the network, which is slow.' #13#10 +
             'You can extract BootstrapChain.zip manually into:' #13#10 + Target,
             mbError, MB_OK);
    exit;
  end;

  Failed := 0;
  if not DirExists(Target) then
    ForceDirectories(Target);

  if FindFirst(Extracted + '\*', FindRec) then
  try
    repeat
      if (FindRec.Name = '.') or (FindRec.Name = '..') then
        Continue;
      // RenameFile moves directories too, and both paths are on one volume.
      if not RenameFile(Extracted + '\' + FindRec.Name, Target + '\' + FindRec.Name) then
      begin
        Log('Could not move ' + FindRec.Name + ' into ' + Target);
        Failed := Failed + 1;
      end;
    until not FindNext(FindRec);
  finally
    FindClose(FindRec);
  end;

  DelTree(Extracted, True, True, True);

  if Failed > 0 then
    MsgBox('Could not move ' + IntToStr(Failed) + ' blockchain file(s) into:' #13#10 +
           Target + #13#10#13#10 +
           'ALIAS will sync from the network instead. The remaining files are in:' #13#10 +
           Extracted, mbError, MB_OK);
end;

// The app reads this to find the data directory, because it depends on
// whether this was an all-users or a per-user install.
procedure WriteDataDirMarker();
begin
  SaveStringToFile(ExpandConstant('{app}\datadir.txt'), DataDir(), False);
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
  begin
    WriteDataDirMarker();
    MoveBootstrapIntoPlace();
  end;
end;

[UninstallDelete]
Type: files; Name: "{app}\datadir.txt"
