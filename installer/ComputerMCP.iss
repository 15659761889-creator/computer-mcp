#define ProductName "Computer MCP"
#define ProductVersion "0.4.0"
#define ProductPublisher "zhuangzihan"
#define ProjectURL "https://www.npmjs.com/package/@zhuangzihan/computer-mcp"

[Setup]
AppId={{9D7039D4-58F8-4A65-8312-3CDDF37F5B67}
AppName={#ProductName}
AppVersion={#ProductVersion}
AppPublisher={#ProductPublisher}
AppPublisherURL={#ProjectURL}
AppSupportURL={#ProjectURL}
AppUpdatesURL={#ProjectURL}
DefaultDirName={localappdata}\Programs\ComputerMCP
DefaultGroupName=Computer MCP
UninstallDisplayIcon={app}\ComputerMCP.exe
OutputDir=..\build\windows\dist
OutputBaseFilename=ComputerMCP-Setup-{#ProductVersion}-x64
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
DisableProgramGroupPage=yes
CloseApplications=no
RestartApplications=no
AllowNoIcons=yes
SetupLogging=yes
VersionInfoVersion=0.4.0.0
VersionInfoDescription=Computer MCP standalone Windows installer
VersionInfoCompany={#ProductPublisher}
VersionInfoProductName={#ProductName}
VersionInfoCopyright=MIT; bundled Node.js and cloudflared licenses included
LicenseFile=..\LICENSE

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "快捷方式:"; Flags: unchecked

[Files]
Source: "..\build\windows\stage\ComputerMCP.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\build\windows\stage\app\*"; DestDir: "{app}\app"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\build\windows\stage\runtime\*"; DestDir: "{app}\runtime"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\build\windows\stage\licenses\*"; DestDir: "{app}\licenses"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\Computer MCP"; Filename: "{app}\ComputerMCP.exe"; WorkingDir: "{app}"
Name: "{autodesktop}\Computer MCP"; Filename: "{app}\ComputerMCP.exe"; Tasks: desktopicon; WorkingDir: "{app}"

[Run]
Filename: "{app}\ComputerMCP.exe"; Description: "打开 Computer MCP 管理器"; Flags: nowait postinstall skipifsilent

[Code]
// Do not kill or restart any running MCP tunnel or another application.
// Uninstalling is explicitly user-controlled; secrets/configuration live under AppData.
function InitializeUninstall(): Boolean;
begin
  if UninstallSilent then begin
    Result := True;
    Exit;
  end;
  Result := MsgBox(
    '卸载将移除 Computer MCP 程序文件。' + #13#10 +
    '如果你已经启用了固定域名或临时隧道，请先自行停止相关连接。' + #13#10 +
    '本卸载程序不会清理密钥或杀掉现有服务。' + #13#10#13#10 +
    '继续卸载？',
    mbConfirmation, MB_YESNO) = IDYES;
end;
