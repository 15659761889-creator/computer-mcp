param(
  [string]$NodeExe = "",
  [string]$CloudflaredExe = "",
  [string]$InnoCompiler = ""
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$stage = Join-Path $root "build\windows\stage"
$app = Join-Path $stage "app"
$runtime = Join-Path $stage "runtime"
$licenses = Join-Path $stage "licenses"

function Resolve-Binary($candidate, $commands, $fallbackPaths) {
  if($candidate -and (Test-Path -LiteralPath $candidate)) { return (Resolve-Path -LiteralPath $candidate).Path }
  foreach ($name in $commands) { $cmd = Get-Command $name -ErrorAction SilentlyContinue; if($cmd -and $cmd.Source -and (Test-Path $cmd.Source)) { return $cmd.Source } }
  foreach ($path in $fallbackPaths) { if($path -and (Test-Path -LiteralPath $path)) { return $path } }
  throw "Missing build dependency. Provide an explicit path argument or install it locally."
}

$node = Resolve-Binary $NodeExe @("node.exe") @("C:\Program Files\nodejs\node.exe")
$cloud = Resolve-Binary $CloudflaredExe @("cloudflared.exe") @(
  (Join-Path $env:APPDATA "computer-mcp\bin\cloudflared.exe"),
  (Join-Path $root "installer\cloudflared.exe")
)
$iscc = Resolve-Binary $InnoCompiler @("ISCC.exe") @(
  (Join-Path $env:LOCALAPPDATA "Programs\Inno Setup 6\ISCC.exe"),
  "C:\Program Files (x86)\Inno Setup 6\ISCC.exe"
)
if([IntPtr]::Size -ne 8) { throw "Use a 64-bit PowerShell process." }
foreach($f in @("NODE_LICENSE.txt","CLOUDFLARED_LICENSE.txt")) {
  if(-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot $f))) {throw "Missing license: $f"}
}
$package = Get-Content -Raw -LiteralPath (Join-Path $root "package.json") | ConvertFrom-Json
if($package.version -ne "0.6.7") {throw "Installer metadata expects Computer MCP package version 0.6.7."}
if(Test-Path -LiteralPath $app) { Remove-Item -LiteralPath $app -Recurse -Force }
New-Item -ItemType Directory -Force -Path $stage,$app,$runtime,$licenses | Out-Null
$compiler = "C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if(-not (Test-Path $compiler)) {throw "Missing Windows .NET Framework 4 C# compiler"}
& $compiler "/nologo" "/target:winexe" "/optimize+" "/out:$stage\ComputerMCP.exe" "/r:System.Windows.Forms.dll" "/r:System.Drawing.dll" "/r:System.Management.dll" (Join-Path $PSScriptRoot "Manager.cs")
if($LASTEXITCODE -ne 0) {throw "C# manager compilation failed"}
Copy-Item -LiteralPath $node -Destination (Join-Path $runtime "node.exe") -Force
Copy-Item -LiteralPath $cloud -Destination (Join-Path $runtime "cloudflared.exe") -Force
foreach($dir in @("bin","src","desktop","web")) {
  Copy-Item -Path (Join-Path $root $dir) -Destination (Join-Path $app $dir) -Recurse -Force
}
Copy-Item -LiteralPath (Join-Path $root "package.json") -Destination $app -Force
Copy-Item -LiteralPath (Join-Path $root "README.md") -Destination $app -Force
Copy-Item -LiteralPath (Join-Path $root "LICENSE") -Destination (Join-Path $licenses "COMPUTERMCP_LICENSE.txt") -Force
# A standalone Windows installer must contain the HTML used by browser handoff.
$handoffHtml = Join-Path $app "web\handoff.html"
if(-not (Test-Path -LiteralPath $handoffHtml)) {throw "Missing browser takeover page in staged app: $handoffHtml"}
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "NODE_LICENSE.txt") -Destination $licenses -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "CLOUDFLARED_LICENSE.txt") -Destination $licenses -Force

& (Join-Path $runtime "node.exe") (Join-Path $app "bin\computer-mcp.mjs") help | Out-Null
if($LASTEXITCODE -ne 0) {throw "Bundled Node smoke test failed."}
& (Join-Path $runtime "cloudflared.exe") --version | Out-Null
if($LASTEXITCODE -ne 0) {throw "Bundled Cloudflare binary smoke test failed."}
Write-Output "Building the installer..."
& $iscc "/Q" (Join-Path $PSScriptRoot "ComputerMCP-Verified.iss")
if($LASTEXITCODE -ne 0) {throw "Inno Setup compilation failed."}
$target = Join-Path $root "dist\ComputerMCP-Setup-0.6.7-Windows-x64.exe"
if(-not (Test-Path -LiteralPath $target)) {throw "Installer was not produced."}
$sha = Get-FileHash -Algorithm SHA256 -LiteralPath $target
Write-Output "INSTALLER=$target"
Write-Output "SIZE_BYTES=$((Get-Item -LiteralPath $target).Length)"
Write-Output "SHA256=$($sha.Hash)"
