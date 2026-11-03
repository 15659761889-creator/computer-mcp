#define AppName "Computer MCP"
#define AppVersion "0.4.3"

[Setup]
AppId={{C99AD54F-186F-4F5A-8F49-CC1D9C7FA7B0}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName=Computer MCP 0.4.3 Windows
AppPublisher=zhuangzihan
AppPublisherURL=https://www.npmjs.com/package/@zhuangzihan/computer-mcp
DefaultDirName={localappdata}\Programs\ComputerMCP
DefaultGroupName=Computer MCP
DisableProgramGroupPage=yes
OutputDir=..\dist
OutputBaseFilename=ComputerMCP-Setup-0.4.3-Windows-x64
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayIcon={app}\ComputerMCP.exe
CloseApplications=no
RestartApplications=no
SetupLogging=yes
LicenseFile=..\LICENSE
VersionInfoVersion=0.4.3.0
VersionInfoDescription=Computer MCP Windows Installer
VersionInfoCompany=Computer MCP
VersionInfoProductName=Computer MCP

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "附加选项"; Flags: unchecked

[Files]
Source: "..\build\windows\stage\ComputerMCP.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\build\windows\stage\runtime\node.exe"; DestDir: "{app}\runtime"; Flags: ignoreversion
Source: "..\build\windows\stage\runtime\cloudflared.exe"; DestDir: "{app}\runtime"; Flags: ignoreversion
Source: "..\build\windows\stage\app\*"; DestDir: "{app}\app"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\build\windows\stage\licenses\*"; DestDir: "{app}\licenses"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\installer\WINDOWS_GUIDE.md"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\Computer MCP"; Filename: "{app}\ComputerMCP.exe"
Name: "{userdesktop}\Computer MCP"; Filename: "{app}\ComputerMCP.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\ComputerMCP.exe"; Description: "Launch Computer MCP"; Flags: nowait postinstall skipifsilent
