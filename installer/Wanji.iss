#define ProductName "万机"
#define ProductVersion "0.4.0"
#define ProductPublisher "zhuangzihan"
#define ProjectURL "https://www.npmjs.com/package/@zhuangzihan/wanji"

[Setup]
AppId={{9D7039D4-58F8-4A65-8312-3CDDF37F5B67}
AppName={#ProductName}
AppVersion={#ProductVersion}
AppPublisher={#ProductPublisher}
AppPublisherURL={#ProjectURL}
AppSupportURL={#ProjectURL}
AppUpdatesURL={#ProjectURL}
DefaultDirName={localappdata}\Programs\万机
DefaultGroupName=万机
UninstallDisplayIcon={app}\Wanji.exe
OutputDir=..\build\windows\dist
OutputBaseFilename=Wanji-Setup-{#ProductVersion}-x64
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
VersionInfoDescription=万机 standalone Windows installer
VersionInfoCompany={#ProductPublisher}
VersionInfoProductName={#ProductName}
VersionInfoCopyright=PolyForm Noncommercial 1.0.0; bundled Node.js and cloudflared licenses included
LicenseFile=..\LICENSE

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "快捷方式:"; Flags: unchecked
Name: "gitbash"; Description: "给 AI 下载 Bash 命令行（约 60 MB，需要联网；不勾选则用 PowerShell，之后可在管理器里切换）"; GroupDescription: "AI 命令行"; Flags: unchecked

[Files]
Source: "..\build\windows\stage\Wanji.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\build\windows\stage\app\*"; DestDir: "{app}\app"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\build\windows\stage\runtime\*"; DestDir: "{app}\runtime"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\build\windows\stage\licenses\*"; DestDir: "{app}\licenses"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\万机"; Filename: "{app}\Wanji.exe"; WorkingDir: "{app}"
Name: "{autodesktop}\万机"; Filename: "{app}\Wanji.exe"; Tasks: desktopicon; WorkingDir: "{app}"

[Run]
Filename: "{app}\runtime\node.exe"; Parameters: """{app}\app\bin\wanji.mjs"" shell bash"; WorkingDir: "{app}"; StatusMsg: "正在下载 Bash 命令行..."; Tasks: gitbash; Flags: runhidden waituntilterminated
Filename: "{app}\Wanji.exe"; Description: "打开 万机 管理器"; Flags: nowait postinstall skipifsilent

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
    '卸载将移除 万机 程序文件。' + #13#10 +
    '如果你已经启用了固定域名或临时隧道，请先自行停止相关连接。' + #13#10 +
    '本卸载程序不会清理密钥或杀掉现有服务。' + #13#10#13#10 +
    '继续卸载？',
    mbConfirmation, MB_YESNO) = IDYES;
end;
