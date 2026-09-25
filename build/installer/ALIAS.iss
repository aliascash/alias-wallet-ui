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

; The bootstrap is deliberately not listed here. A declarative external
; download can only draw a bare progress bar; it is scripted further down so
; the transferred and total bytes can be shown.

[Icons]
Name: "{autoprograms}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{autodesktop}\{#MyAppName}";  Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "{cm:LaunchProgram,{#MyAppName}}"; \
  Flags: nowait postinstall skipifsilent

[Code]
var
  DownloadPage: TDownloadWizardPage;

// The data directory follows the install scope: %APPDATA%\ALIAS for a
// per-user install, C:\ProgramData\ALIAS for all users. {autoappdata} already
// resolves that way, so the app and the installer agree without a second rule.
function DataDir(): String;
begin
  Result := ExpandConstant('{autoappdata}\{#MyAppName}');
end;

function GB(const Bytes: Int64): String;
begin
  Result := Format('%.2f GB', [Bytes / 1073741824.0]);
end;

// Reporting the byte counts is the whole reason the download is scripted.
function OnDownloadProgress(const Url, FileName: String; const Progress, ProgressMax: Int64): Boolean;
begin
  if ProgressMax > 0 then
    DownloadPage.SetText('Blockchain data: ' + GB(Progress) + ' of ' + GB(ProgressMax), '')
  else
    DownloadPage.SetText('Blockchain data: ' + GB(Progress) + ' downloaded', '');
  Result := True;
end;

procedure InitializeWizard();
begin
  DownloadPage := CreateDownloadPage('Downloading blockchain data',
    'Setup is downloading the blockchain so your wallet does not have to sync from the network.',
    @OnDownloadProgress);
end;

function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  if (CurPageID = wpReady) and WizardIsComponentSelected('bootstrap') then
  begin
    DownloadPage.Clear;
    DownloadPage.Add('{#BootstrapURL}', 'BootstrapChain.zip', '');
    DownloadPage.Show;
    try
      try
        DownloadPage.Download;
      except
        // Cancelled or failed: still install the application, the wallet can
        // sync from the network instead.
        MsgBox('The blockchain data could not be downloaded:' #13#10#13#10 +
               AddPeriod(GetExceptionMessage) + #13#10#13#10 +
               'ALIAS will still install and will sync from the network.',
               mbInformation, MB_OK);
      end;
    finally
      DownloadPage.Hide;
    end;
  end;
end;

// Move one entry into place, REPLACING whatever is there. RenameFile fails if
// the destination exists, and after any previous run the data dir already
// holds a small blk0001.dat and a txleveldb folder -- exactly the entries the
// bootstrap has to overwrite.
function MoveReplacing(const Src, Dst: String): Boolean;
begin
  if DirExists(Dst) then
    DelTree(Dst, True, True, True)
  else if FileExists(Dst) then
    DeleteFile(Dst);
  Result := RenameFile(Src, Dst);
end;

procedure InstallBootstrap();
var
  Zip, Stage, Src, Target: String;
  FindRec: TFindRec;
  Moved, Failed: Integer;
begin
  Zip := ExpandConstant('{tmp}\BootstrapChain.zip');
  if not FileExists(Zip) then
    exit;  // component not selected, or the download did not complete

  Target := DataDir();
  Stage := ExpandConstant('{tmp}\BootstrapExtract');
  ForceDirectories(Stage);
  ForceDirectories(Target);

  WizardForm.StatusLabel.Caption := 'Extracting blockchain data...';
  try
    ExtractArchive(Zip, Stage, '', True);
  except
    MsgBox('The blockchain data could not be extracted:' #13#10#13#10 +
           AddPeriod(GetExceptionMessage) + #13#10#13#10 +
           'ALIAS will sync from the network instead.', mbError, MB_OK);
    exit;
  end;

  // The archive wraps everything in BootstrapChain\; tolerate both layouts.
  Src := Stage + '\BootstrapChain';
  if not DirExists(Src) then
    Src := Stage;

  Moved := 0;
  Failed := 0;
  WizardForm.StatusLabel.Caption := 'Installing blockchain data...';
  if FindFirst(Src + '\*', FindRec) then
  try
    repeat
      if (FindRec.Name = '.') or (FindRec.Name = '..') then
        Continue;
      if MoveReplacing(Src + '\' + FindRec.Name, Target + '\' + FindRec.Name) then
        Moved := Moved + 1
      else
      begin
        Failed := Failed + 1;
        Log('Could not move ' + FindRec.Name + ' into ' + Target);
      end;
    until not FindNext(FindRec);
  finally
    FindClose(FindRec);
  end;

  DelTree(Stage, True, True, True);
  DeleteFile(Zip);

  if (Moved = 0) or (Failed > 0) then
    MsgBox('Blockchain data: ' + IntToStr(Moved) + ' item(s) installed, ' +
           IntToStr(Failed) + ' failed.' #13#10#13#10 +
           'If the wallet starts syncing from the beginning, extract ' +
           'BootstrapChain.zip manually into:' #13#10 + Target, mbError, MB_OK);
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
    InstallBootstrap();
  end;
end;

[UninstallDelete]
Type: files; Name: "{app}\datadir.txt"
