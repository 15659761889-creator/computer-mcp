#define AppName "万机"
#define AppVersion "0.6.14"

[Setup]
; Chinese Windows gets the Chinese wizard, anything else English, without asking.
ShowLanguageDialog=auto
AppId={{C99AD54F-186F-4F5A-8F49-CC1D9C7FA7B0}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName=万机 {#AppVersion} Windows
AppPublisher=Zihan Zhuang
AppPublisherURL=https://wanji.3618.app
AppSupportURL=https://wanji.3618.app
DefaultDirName={localappdata}\Programs\万机
DefaultGroupName=万机
DisableProgramGroupPage=yes
OutputDir=..\dist
OutputBaseFilename=Wanji-Setup-{#AppVersion}-Windows-x64
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayIcon={app}\Wanji.exe
CloseApplications=no
RestartApplications=no
SetupLogging=yes
LicenseFile=EULA.txt
VersionInfoVersion={#AppVersion}.0
VersionInfoDescription=万机 Windows Installer
VersionInfoCompany=万机
VersionInfoProductName=万机

[Languages]
Name: "chinesesimp"; MessagesFile: "ChineseSimplified.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "附加选项"
Name: "gitbash"; Description: "给 AI 下载 Bash 命令行（约 60 MB，需要联网；不勾选则用 PowerShell，之后可在管理器里切换）"; GroupDescription: "AI 命令行"; Flags: unchecked

[Files]
Source: "..\build\windows\stage\Wanji.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\build\windows\stage\runtime\node.exe"; DestDir: "{app}\runtime"; Flags: ignoreversion
Source: "..\build\windows\stage\runtime\cloudflared.exe"; DestDir: "{app}\runtime"; Flags: ignoreversion
Source: "..\build\windows\stage\app\*"; DestDir: "{app}\app"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\build\windows\stage\licenses\*"; DestDir: "{app}\licenses"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\installer\WINDOWS_GUIDE.md"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\万机"; Filename: "{app}\Wanji.exe"
Name: "{userdesktop}\万机"; Filename: "{app}\Wanji.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\runtime\node.exe"; Parameters: """{app}\app\bin\wanji.mjs"" shell bash"; WorkingDir: "{app}"; StatusMsg: "正在下载 Bash 命令行..."; Tasks: gitbash; Flags: runhidden waituntilterminated
; A reinstall over a Pro computer (pro.json kept by the uninstaller) brings its service back.
Filename: "{app}\runtime\node.exe"; Parameters: """{app}\app\bin\wanji.mjs"" pro"; WorkingDir: "{app}"; StatusMsg: "正在恢复 Pro 连接..."; Flags: runhidden waituntilterminated; Check: FileExists(ExpandConstant('{userappdata}\computer-mcp\pro.json'))
Filename: "{app}\Wanji.exe"; Description: "启动万机"; Flags: nowait postinstall skipifsilent

[UninstallRun]
; Stop the background service and remove its startup task; its node.exe lives in {app} and is
; about to be deleted. License and Pro account files stay, so a reinstall keeps Pro.
Filename: "{app}\runtime\node.exe"; Parameters: """{app}\app\bin\wanji.mjs"" uninstall --from-settings"; WorkingDir: "{app}"; Flags: runhidden waituntilterminated; RunOnceId: "WanjiStopService"

[Code]
// Same places the app looks (src/shell.mjs locateBash), plus Git for Windows' registry key.
// System32\bash.exe is WSL and does not count.
function GitBashPath(): String;
var
  Candidates: array of String;
  Dirs, Dir, InstallPath: String;
  I: Integer;
begin
  Result := '';
  SetArrayLength(Candidates, 4);
  Candidates[0] := ExpandConstant('{commonpf64}\Git\bin\bash.exe');
  Candidates[1] := ExpandConstant('{commonpf32}\Git\bin\bash.exe');
  Candidates[2] := ExpandConstant('{localappdata}\Programs\Git\bin\bash.exe');
  Candidates[3] := ExpandConstant('{userappdata}\computer-mcp\git\bin\bash.exe');
  for I := 0 to GetArrayLength(Candidates) - 1 do
    if FileExists(Candidates[I]) then begin
      Result := Candidates[I];
      Exit;
    end;
  if (RegQueryStringValue(HKLM64, 'SOFTWARE\GitForWindows', 'InstallPath', InstallPath)
      or RegQueryStringValue(HKCU, 'SOFTWARE\GitForWindows', 'InstallPath', InstallPath))
     and FileExists(AddBackslash(InstallPath) + 'bin\bash.exe') then begin
    Result := AddBackslash(InstallPath) + 'bin\bash.exe';
    Exit;
  end;
  // git.exe on PATH (usually ...\Git\cmd): its Git folder holds bin\bash.exe.
  Dirs := GetEnv('PATH') + ';';
  while Length(Dirs) > 0 do begin
    I := Pos(';', Dirs);
    Dir := RemoveQuotes(Trim(Copy(Dirs, 1, I - 1)));
    Delete(Dirs, 1, I);
    if (Dir <> '') and FileExists(AddBackslash(Dir) + 'git.exe')
       and FileExists(ExtractFileDir(RemoveBackslash(Dir)) + '\bin\bash.exe') then begin
      Result := ExtractFileDir(RemoveBackslash(Dir)) + '\bin\bash.exe';
      Exit;
    end;
  end;
end;

// Bash already here: the download choice turns into a greyed "installed" line,
// since the app uses that Bash on its own.
procedure CurPageChanged(CurPageID: Integer);
var
  I: Integer;
begin
  if (CurPageID <> wpSelectTasks) or (GitBashPath() = '') then Exit;
  for I := 0 to WizardForm.TasksList.Items.Count - 1 do
    if Pos('Bash', WizardForm.TasksList.ItemCaption[I]) > 0 then begin
      WizardForm.TasksList.Checked[I] := False;
      WizardForm.TasksList.ItemEnabled[I] := False;
      if ActiveLanguage = 'chinesesimp' then
        WizardForm.TasksList.ItemCaption[I] := '已检测到 Bash（已安装），AI 会直接使用，不需要再下载'
      else
        WizardForm.TasksList.ItemCaption[I] := 'Bash found (already installed); the AI uses it, nothing to download';
    end;
end;
