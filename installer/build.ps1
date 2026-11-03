param(
  [string]$NodePath = "$env:ProgramFiles\nodejs\node.exe",
  [string]$CloudflaredPath = "",
  [string]$IsccPath = "",
  [switch]$SkipTests
)
$ErrorActionPreference = "Stop"
$project = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$stage = Join-Path $project "build\windows\stage"
$dist = Join-Path $project "build\windows\dist"
if (-not $CloudflaredPath) {
  $found = Get-Command cloudflared.exe -ErrorAction SilentlyContinue
  if ($found) { $CloudflaredPath = $found.Source }
}
if (-not $CloudflaredPath) { throw "Pass -CloudflaredPath to an official cloudflared.exe (or add it to PATH)." }
if (-not $IsccPath) {
  $candidates = @(
    "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe",
    "$env:ProgramFiles\Inno Setup 6\ISCC.exe",
    "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe"
  )
  $IsccPath = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
}
if (-not (Test-Path -LiteralPath $NodePath)) { throw "Node runtime not found: $NodePath" }
if (-not (Test-Path -LiteralPath $CloudflaredPath)) { throw "cloudflared runtime not found: $CloudflaredPath" }
if (-not $IsccPath) { throw "Inno Setup compiler (ISCC.exe) was not found." }
$csc = "$env:windir\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (-not (Test-Path $csc)) { throw "Windows .NET Framework 4 C# compiler was not found." }

$pkg = Get-Content (Join-Path $project 'package.json') -Raw | ConvertFrom-Json
if ($pkg.version -ne "0.4.0") { throw "The installer version is 0.4.0, but the package version is $($pkg.version)." }

if (-not $SkipTests) {
  Write-Host "Running Node tests..."
  Push-Location $project
  try { & $NodePath --test; if ($LASTEXITCODE -ne 0) { throw "Unit tests failed: $LASTEXITCODE" } }
  finally { Pop-Location }
}
foreach ($folder in @($stage, $dist, (Join-Path $stage 'runtime'), (Join-Path $stage 'app'), (Join-Path $stage 'licenses'))) {
  New-Item -ItemType Directory -Force -Path $folder | Out-Null
}
Write-Host "Copying application files..."
foreach ($folder in @('bin','src','desktop','web')) {
  $destination = Join-Path (Join-Path $stage 'app') $folder
  New-Item -ItemType Directory -Force -Path $destination | Out-Null
  Copy-Item (Join-Path (Join-Path $project $folder) '*') $destination -Recurse -Force
}
foreach ($name in @('package.json','README.md','LICENSE')) {
  Copy-Item (Join-Path $project $name) (Join-Path $stage 'app') -Force
}
Copy-Item $NodePath (Join-Path $stage 'runtime\node.exe') -Force
Copy-Item $CloudflaredPath (Join-Path $stage 'runtime\cloudflared.exe') -Force
Copy-Item (Join-Path $project 'LICENSE') (Join-Path $stage 'licenses\COMPUTERMCP_LICENSE.txt') -Force
foreach ($name in @('NODE_LICENSE.txt','CLOUDFLARED_LICENSE.txt')) {
  $license = Join-Path $PSScriptRoot $name
  if (-not (Test-Path $license)) { throw "Dependency license missing: $license" }
  Copy-Item $license (Join-Path $stage 'licenses') -Force
}

Write-Host "Compiling native Windows UI..."
& $csc /nologo /target:winexe "/out:$(Join-Path $stage 'ComputerMCP.exe')" /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Management.dll (Join-Path $PSScriptRoot 'Manager.cs')
if ($LASTEXITCODE -ne 0) { throw "C# compilation failed: $LASTEXITCODE" }
Write-Host "Building signed-independent Inno Setup executable (unsigned publisher build)..."
& $IsccPath (Join-Path $PSScriptRoot 'ComputerMCP.iss')
if ($LASTEXITCODE -ne 0) { throw "Inno Setup failed: $LASTEXITCODE" }

$output = Join-Path $dist "ComputerMCP-Setup-0.4.0-x64.exe"
if (-not (Test-Path -LiteralPath $output)) { throw "Expected setup executable was not created." }
$item = Get-Item $output
$hash = Get-FileHash $output -Algorithm SHA256
Write-Host ""
Write-Host "SUCCESS: $output"
Write-Host "Size: $([math]::Round($item.Length/1MB,2)) MiB"
Write-Host "SHA256: $($hash.Hash)"
Write-Host "EXE does not require global Node.js. OCR/Python is a separate optional download from the GUI."
