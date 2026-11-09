#define AppName "万机"
#ifndef AppVersion
  #define AppVersion "0.6.16"
#endif
; build-windows.ps1 passes the SHA-256 of the bundled runtime files: identical files already
; installed are left alone, so an update never has to touch a running service or tunnel.
#ifndef NodeSha
  #define NodeSha ""
#endif
#ifndef CloudflaredSha
  #define CloudflaredSha ""
#endif
; -TestBuild: its own AppId and folder, and no service steps, for testing updates safely.
#ifdef TestBuild
  #define AppIdValue "{{6E0B7F5A-2C1D-4E8B-9A57-0D6B1C2E3F41}"
  #define DirName "万机-updatetest"
  #define OutputName "Wanji-UpdateTest-" + AppVersion + "-Windows-x64"
#else
  #define AppIdValue "{{C99AD54F-186F-4F5A-8F49-CC1D9C7FA7B0}"
  #define DirName "万机"
  #define OutputName "Wanji-Setup-" + AppVersion + "-Windows-x64"
#endif

[Setup]
; Chinese Windows gets the Chinese wizard, anything else English, without asking.
ShowLanguageDialog=auto
AppId={#AppIdValue}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName=万机 {#AppVersion} Windows
AppPublisher=Zihan Zhuang
AppPublisherURL=https://wanji.3618.app
AppSupportURL=https://wanji.3618.app
DefaultDirName={localappdata}\Programs\{#DirName}
DefaultGroupName={#DirName}
DisableProgramGroupPage=yes
OutputDir=..\dist
OutputBaseFilename={#OutputName}
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
Source: "..\build\windows\stage\runtime\node.exe"; DestDir: "{app}\runtime"; Flags: ignoreversion; Check: NeedsFile('runtime\node.exe', '{#NodeSha}')
Source: "..\build\windows\stage\runtime\cloudflared.exe"; DestDir: "{app}\runtime"; Flags: ignoreversion; Check: NeedsFile('runtime\cloudflared.exe', '{#CloudflaredSha}')
Source: "..\build\windows\stage\app\*"; DestDir: "{app}\app"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\build\windows\stage\licenses\*"; DestDir: "{app}\licenses"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\installer\WINDOWS_GUIDE.md"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\万机"; Filename: "{app}\Wanji.exe"
#ifndef TestBuild
Name: "{userdesktop}\万机"; Filename: "{app}\Wanji.exe"; Tasks: desktopicon
#endif

[Run]
Filename: "{app}\runtime\node.exe"; Parameters: """{app}\app\bin\wanji.mjs"" shell bash"; WorkingDir: "{app}"; StatusMsg: "正在下载 Bash 命令行..."; Tasks: gitbash; Flags: runhidden waituntilterminated
#ifndef TestBuild
; A reinstall over a Pro computer (pro.json kept by the uninstaller) brings its service back.
Filename: "{app}\runtime\node.exe"; Parameters: """{app}\app\bin\wanji.mjs"" pro"; WorkingDir: "{app}"; StatusMsg: "正在恢复 Pro 连接..."; Flags: runhidden waituntilterminated; Check: FileExists(ExpandConstant('{userappdata}\computer-mcp\pro.json')) and not IsUpdate
; A one-click update (/UPDATE=1): the running service switches to the new code in place.
Filename: "{app}\runtime\node.exe"; Parameters: """{app}\app\bin\wanji.mjs"" update"; WorkingDir: "{app}"; Flags: runhidden waituntilterminated; Check: IsUpdate and FileExists(ExpandConstant('{userappdata}\computer-mcp\config.json'))
#endif
Filename: "{app}\Wanji.exe"; Flags: nowait; Check: IsUpdate
Filename: "{app}\Wanji.exe"; Description: "启动万机"; Flags: nowait postinstall skipifsilent

[UninstallRun]
; Stop the background service and remove its startup task; its node.exe lives in {app} and is
; about to be deleted. License and Pro account files stay, so a reinstall keeps Pro.
; A test build must never touch the real service.
#ifndef TestBuild
Filename: "{app}\runtime\node.exe"; Parameters: """{app}\app\bin\wanji.mjs"" uninstall --from-settings"; WorkingDir: "{app}"; Flags: runhidden waituntilterminated; RunOnceId: "WanjiStopService"
#endif

[Code]
function IsUpdate(): Boolean;
begin
  Result := ExpandConstant('{param:UPDATE|0}') = '1';
end;

// Only replace a runtime file that differs, so an identical running node.exe or
// cloudflared.exe is never touched.
function NeedsFile(Name, Sha: String): Boolean;
var
  Path: String;
begin
  Path := ExpandConstant('{app}\') + Name;
  Result := (Sha = '') or (not FileExists(Path)) or (CompareText(GetSHA256OfFile(Path), Sha) <> 0);
end;

// The manager may still be closing when the installer starts: wait up to 5 s, then end it,
// matched by its full path in this install folder only.
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Script, Exe: String;
  Code: Integer;
begin
  Result := '';
  Exe := ExpandConstant('{app}\Wanji.exe');
  if not FileExists(Exe) then Exit;
  Script := ExpandConstant('{tmp}\close-manager.ps1');
  SaveStringToFile(Script,
    'param([string]$Exe)' + #13#10 +
    'for ($i = 0; $i -lt 20; $i++) {' + #13#10 +
    '  $p = @(Get-CimInstance Win32_Process -Filter "Name=''Wanji.exe''" | Where-Object { $_.ExecutablePath -eq $Exe })' + #13#10 +
    '  if ($p.Count -eq 0) { exit 0 }' + #13#10 +
    '  if ($i -ge 10) { $p | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } }' + #13#10 +
    '  Start-Sleep -Milliseconds 500' + #13#10 +
    '}' + #13#10, False);
  Exec('powershell.exe', '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + Script + '" -Exe "' + Exe + '"', '', SW_HIDE, ewWaitUntilTerminated, Code);
end;

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
