; Paracord Client Installer - Inno Setup Script
; Requires Inno Setup 6+
; Build with: ISCC.exe /DAppVersion=0.6.0 paracord-client.iss

#ifndef AppVersion
  #define AppVersion "0.6.0"
#endif

[Setup]
AppName=Paracord
AppVersion={#AppVersion}
AppVerName=Paracord {#AppVersion}
AppPublisher=Paracord
DefaultDirName={autopf}\Paracord
DefaultGroupName=Paracord
OutputDir=output
OutputBaseFilename=Paracord-Setup-{#AppVersion}
Compression=lzma2/ultra64
SolidCompression=yes
SetupIconFile=..\client\src-tauri\icons\icon.ico
UninstallDisplayIcon={app}\Paracord.exe
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
LicenseFile=
DisableProgramGroupPage=yes
MinVersion=10.0.17763

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[Files]
; Main application binary from Tauri build
Source: "..\client\src-tauri\target\release\paracord-desktop.exe"; DestDir: "{app}"; DestName: "Paracord.exe"; Flags: ignoreversion

; WebView2 bootstrapper (for systems without Edge/WebView2)
Source: "MicrosoftEdgeWebview2Setup.exe"; DestDir: "{tmp}"; Flags: deleteafterinstall dontcopy; Check: NeedsWebView2

[Icons]
Name: "{group}\Paracord"; Filename: "{app}\Paracord.exe"
Name: "{autodesktop}\Paracord"; Filename: "{app}\Paracord.exe"; Tasks: desktopicon
Name: "{group}\Uninstall Paracord"; Filename: "{uninstallexe}"

[Run]
Filename: "{app}\Paracord.exe"; Description: "Launch Paracord"; Flags: nowait postinstall skipifsilent

[Code]
// Check if WebView2 runtime is installed
function NeedsWebView2(): Boolean;
begin
  Result := not RegKeyExists(HKLM, 'SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BEE-13A6279FE8FF}');
  if Result then
    Result := not RegKeyExists(HKCU, 'Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BEE-13A6279FE8FF}');
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  ResultCode: Integer;
begin
  // Install WebView2 if needed, before the main app files are installed
  if (CurStep = ssInstall) and NeedsWebView2() then
  begin
    ExtractTemporaryFile('MicrosoftEdgeWebview2Setup.exe');
    if not Exec(ExpandConstant('{tmp}\MicrosoftEdgeWebview2Setup.exe'),
                '/silent /install', '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then
    begin
      Log('WebView2 bootstrapper failed with code: ' + IntToStr(ResultCode));
    end;
  end;
end;
