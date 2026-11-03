$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$testRoot = Join-Path $env:TEMP ('cmcp-manager-launch-' + [guid]::NewGuid().ToString('N'))
$manager = Join-Path $testRoot 'ComputerMCP.exe'
$runtime = Join-Path $testRoot 'runtime'
$capture = Join-Path $testRoot 'args.txt'
$previousCapture = $env:CMCP_TEST_CAPTURE
try {
  New-Item -ItemType Directory -Path $runtime -Force | Out-Null
  Copy-Item (Join-Path $root 'build\windows\stage\ComputerMCP.exe') $manager
  $mockSource = @'
using System;
using System.IO;
class DummyNode {
  public static int Main(string[] args) {
    File.WriteAllLines(Environment.GetEnvironmentVariable("CMCP_TEST_CAPTURE"), args);
    return 0;
  }
}
'@
  $mockPath = Join-Path $testRoot 'dummy.cs'
  Set-Content -LiteralPath $mockPath -Value $mockSource -Encoding UTF8
  & 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe' /nologo /target:exe "/out:$(Join-Path $runtime 'node.exe')" $mockPath
  if ($LASTEXITCODE -ne 0) { throw 'Mock Node compile failed' }
  $env:CMCP_TEST_CAPTURE = $capture

  $harnessSource = @'
using System;
using System.IO;
using System.Reflection;
using System.Threading;
using System.Windows.Forms;
class VerifyManagerLaunch {
  static int Main() {
    string root = AppDomain.CurrentDomain.BaseDirectory;
    string capture = Environment.GetEnvironmentVariable("CMCP_TEST_CAPTURE");
    var assembly = Assembly.LoadFrom(Path.Combine(root, "ComputerMCP.exe"));
    var type = assembly.GetType("ComputerMCPWindows.ManagerForm", true);
    var form = (Form)Activator.CreateInstance(type);
    try {
      var method = type.GetMethod("StartCliTask", BindingFlags.Instance | BindingFlags.NonPublic);
      if (method == null) throw new Exception("StartCliTask not found");
      string pair = "cmcp://pc-test.mcp.3618.app/TEST1234";
      method.Invoke(form, new object[] { "join \"" + pair + "\"", "Test join" });
      for (int i = 0; i < 100 && !File.Exists(capture); i++) Thread.Sleep(100);
      if (!File.Exists(capture)) throw new Exception("Direct launch produced no argument file");
      var parts = File.ReadAllLines(capture);
      if (parts.Length != 3 || parts[0] != Path.Combine(root, "app", "bin", "computer-mcp.mjs")
          || parts[1] != "join" || parts[2] != pair)
        throw new Exception("Arguments incorrect: " + string.Join(" | ", parts));
      Console.WriteLine("PASS: GUI StartCliTask directly started bundled node.exe");
      Console.WriteLine("PASS: script, verb, pairing code are separate correct arguments");
      Console.WriteLine("PASS: dummy node used; no pairing/network/active service changes");
      return 0;
    } finally { form.Dispose(); }
  }
}
'@
  $harnessPath = Join-Path $testRoot 'harness.cs'
  Set-Content -LiteralPath $harnessPath -Value $harnessSource -Encoding UTF8
  $harness = Join-Path $testRoot 'VerifyManagerLaunch.exe'
  & 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe' /nologo /target:exe "/out:$harness" /reference:System.Windows.Forms.dll $harnessPath
  if ($LASTEXITCODE -ne 0) { throw 'Manager launch harness compilation failed' }
  & $harness
  if ($LASTEXITCODE -ne 0) { throw 'Manager launch argument check failed' }
} finally {
  $env:CMCP_TEST_CAPTURE = $previousCapture
  if (Test-Path $testRoot) { Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue }
}
