$ErrorActionPreference = 'Stop'
$dir = Join-Path $env:TEMP ('cmcp-timeout-test-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory $dir | Out-Null
try {
  $dll = Join-Path $dir 'manager.dll'
  $source = Join-Path $PSScriptRoot 'Manager.cs'
  & "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /nologo /target:library "/out:$dll" /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.Management.dll $source
  if ($LASTEXITCODE -ne 0) { throw 'compile failed' }
  $type = [Reflection.Assembly]::LoadFrom($dll).GetType('ComputerMCPWindows.ManagerForm')
  $assembly = $type.Assembly
  $assembly.GetType('ComputerMCPWindows.UiLang').GetField('English').SetValue($null, $true)
  $obj = [Runtime.Serialization.FormatterServices]::GetUninitializedObject($type)
  $flags = [Reflection.BindingFlags]'Instance,NonPublic'
  $cli = Join-Path $dir 'slow.cjs'
  [IO.File]::WriteAllText($cli, 'setTimeout(() => process.exit(0), 2000);')
  $type.GetField('node',$flags).SetValue($obj, (Get-Command node.exe).Source)
  $type.GetField('cli',$flags).SetValue($obj, $cli)
  $type.GetField('root',$flags).SetValue($obj, $dir)
  $timedOut = $false
  $watch = [Diagnostics.Stopwatch]::StartNew()
  try { $null = $type.GetMethod('Run',$flags).Invoke($obj, @('', [int]150)) } catch { if ($_.Exception.InnerException.Message -match 'timed out') { $timedOut = $true } else { throw } }
  $watch.Stop()
  if (!$timedOut -or $watch.ElapsedMilliseconds -gt 1500) { throw "timeout failed: timedOut=$timedOut elapsed=$($watch.ElapsedMilliseconds)ms" }
  Write-Output "Manager timeout passed in $($watch.ElapsedMilliseconds)ms"
} finally { Remove-Item $dir -Recurse -Force -ErrorAction SilentlyContinue }
