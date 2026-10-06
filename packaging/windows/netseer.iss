; Inno Setup script for NetSeer-Setup-<version>.exe
;   iscc /DAppVersion=0.6.0 packaging\windows\netseer.iss
; Expects the PyInstaller output in dist\NetSeer (see netseer.spec).

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif

[Setup]
AppId={{6B0E4C1D-2E57-4F0B-9C55-3A1F7D8B42E6}
AppName=NetSeer
AppVersion={#AppVersion}
AppVerName=NetSeer {#AppVersion}
AppPublisher=Ardyn Systems
AppPublisherURL=https://github.com/ardyn-systems/NetSeer
AppSupportURL=https://github.com/ardyn-systems/NetSeer/issues
AppComments=Turn traffic into terrain.
; Per-user install by default (no admin prompt); the dialog offers all users.
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
DefaultDirName={autopf}\NetSeer
DefaultGroupName=NetSeer
DisableProgramGroupPage=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
; Same name as the app's mutex, so setup asks you to close NetSeer first.
AppMutex=NetSeerDesktop
CloseApplications=yes
OutputDir=..\..\dist
OutputBaseFilename=NetSeer-Setup-{#AppVersion}
SetupIconFile=netseer.ico
UninstallDisplayIcon={app}\NetSeer.exe
UninstallDisplayName=NetSeer
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
Source: "..\..\dist\NetSeer\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\NetSeer"; Filename: "{app}\NetSeer.exe"; Comment: "Turn traffic into terrain."
Name: "{autodesktop}\NetSeer"; Filename: "{app}\NetSeer.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\NetSeer.exe"; Description: "{cm:LaunchProgram,NetSeer}"; Flags: nowait postinstall skipifsilent
; In-app updates run setup silently with /RELAUNCH=1: reopen NetSeer when it's done.
Filename: "{app}\NetSeer.exe"; Flags: nowait runasoriginaluser; Check: RelaunchRequested

[Code]
function RelaunchRequested(): Boolean;
begin
  Result := ExpandConstant('{param:RELAUNCH|0}') = '1';
end;

function WebView2Installed(): Boolean;
var
  Version: String;
begin
  Result :=
    (RegQueryStringValue(HKLM, 'SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', Version) and (Version <> '') and (Version <> '0.0.0.0')) or
    (RegQueryStringValue(HKCU, 'Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', Version) and (Version <> '') and (Version <> '0.0.0.0'));
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if (CurStep = ssPostInstall) and (not WizardSilent()) and (not WebView2Installed()) then
    MsgBox('NetSeer opens in its own window using Microsoft Edge WebView2, which isn''t installed on this PC.' + #13#10#13#10 +
      'Until you install it, NetSeer opens in your web browser instead. Get WebView2 from:' + #13#10 +
      'https://go.microsoft.com/fwlink/p/?LinkId=2124703', mbInformation, MB_OK);
end;
