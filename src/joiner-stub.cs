using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Text;

// Shown in the file's Properties; an EXE with no version details looks more suspicious.
[assembly: AssemblyTitle("Wanji joiner")]
[assembly: AssemblyDescription("Connects this computer to a Wanji main computer")]
[assembly: AssemblyProduct("Wanji")]
[assembly: AssemblyCompany("Wanji")]
[assembly: AssemblyVersion("1.0.0.0")]
[assembly: AssemblyFileVersion("1.0.0.0")]

// Wanji one-click joiner stub.
// The built joiner EXE is this stub plus an appended ZIP (node.exe, app/, join.json,
// bootstrap.cmd) and a 16-byte footer: 8-byte magic "WANJISFX" + 8-byte little-endian
// offset where the ZIP starts. The stub extracts the ZIP to a temp folder and runs
// bootstrap.cmd there, then cleans the temp folder up.
class JoinerStub {
  // A run whose window was closed early never reaches the finally below; its folder
  // is cleared on the next run. Recent ones are left alone, and so is any folder whose
  // node.exe is still open: another run may still be installing from it.
  static void ClearOldRuns() {
    try {
      foreach (var dir in Directory.GetDirectories(Path.GetTempPath(), "wanji-join-*")) {
        try {
          if (DateTime.UtcNow - Directory.GetCreationTimeUtc(dir) < TimeSpan.FromHours(1)) continue;
          string node = Path.Combine(dir, "node.exe");
          if (File.Exists(node)) {
            using (new FileStream(node, FileMode.Open, FileAccess.ReadWrite, FileShare.None)) { }
          }
          Directory.Delete(dir, true);
        } catch { }
      }
    } catch { }
  }

  // Two runs at once would both join and overwrite each other's files, so a second one waits out.
  static int Main() {
    bool first;
    using (var gate = new System.Threading.Mutex(true, "Local\\WanjiJoiner", out first)) {
      if (!first) {
        // Chinese for: "A joiner is already running; wait for it to finish. Press any key to close."
        Console.WriteLine("\u5df2\u7ecf\u6709\u4e00\u4e2a\u52a0\u5165\u7a0b\u5e8f\u5728\u8fd0\u884c\uff0c\u8bf7\u7b49\u5b83\u5b8c\u6210\u3002\u6309\u4efb\u610f\u952e\u5173\u95ed\u3002");
        try { Console.ReadKey(true); } catch { }
        return 1;
      }
      try { return Run(); } finally { gate.ReleaseMutex(); }
    }
  }

  static int Run() {
    ClearOldRuns();
    string exe = Process.GetCurrentProcess().MainModule.FileName;
    string tempDir = null;
    try {
      using (var fs = new FileStream(exe, FileMode.Open, FileAccess.Read, FileShare.Read)) {
        if (fs.Length < 16) throw new Exception("joiner file is too small");
        var footer = new byte[16];
        fs.Seek(-16, SeekOrigin.End);
        if (fs.Read(footer, 0, 16) != 16) throw new Exception("cannot read joiner footer");
        if (Encoding.ASCII.GetString(footer, 0, 8) != "WANJISFX")
          throw new Exception("this file is not a Wanji joiner (bad footer)");
        long zipOffset = BitConverter.ToInt64(footer, 8);
        if (zipOffset <= 0 || zipOffset >= fs.Length - 16) throw new Exception("bad ZIP offset in joiner footer");
        tempDir = Path.Combine(Path.GetTempPath(), "wanji-join-" + Guid.NewGuid().ToString("N").Substring(0, 8));
        Directory.CreateDirectory(tempDir);
        fs.Seek(zipOffset, SeekOrigin.Begin);
        long zipLength = fs.Length - 16 - zipOffset;
        using (var zipStream = new MemoryStream()) {
          var buffer = new byte[81920];
          long remaining = zipLength;
          while (remaining > 0) {
            int read = fs.Read(buffer, 0, (int)Math.Min(buffer.Length, remaining));
            if (read <= 0) break;
            zipStream.Write(buffer, 0, read);
            remaining -= read;
          }
          zipStream.Seek(0, SeekOrigin.Begin);
          using (var archive = new ZipArchive(zipStream, ZipArchiveMode.Read)) {
            archive.ExtractToDirectory(tempDir);
          }
        }
      }
      string bootstrap = Path.Combine(tempDir, "bootstrap.cmd");
      if (!File.Exists(bootstrap)) throw new Exception("bootstrap.cmd is missing from the joiner");
      // Doubled outer quotes: cmd /c strips one pair, so a path with ( ) or & still works.
      var psi = new ProcessStartInfo("cmd.exe", "/d /c \"\"" + bootstrap + "\"\"") {
        WorkingDirectory = tempDir,
        UseShellExecute = false,
      };
      using (var p = Process.Start(psi)) {
        p.WaitForExit();
        return p.ExitCode;
      }
    } catch (Exception ex) {
      Console.Error.WriteLine("Joiner failed: " + ex.Message);
      // Chinese for: "Joiner failed; send a screenshot of this window to whoever gave you this program. Press any key to close." Escaped, so the file stays ASCII.
      Console.WriteLine("\u52a0\u5165\u7a0b\u5e8f\u51fa\u9519\uff0c\u8bf7\u628a\u8fd9\u4e2a\u7a97\u53e3\u622a\u56fe\u53d1\u7ed9\u7ed9\u4f60\u8fd9\u4e2a\u7a0b\u5e8f\u7684\u4eba\u3002\u6309\u4efb\u610f\u952e\u5173\u95ed\u3002");
      Console.WriteLine("Press any key to close.");
      try { Console.ReadKey(true); } catch { }
      return 1;
    } finally {
      if (tempDir != null) {
        try { Directory.Delete(tempDir, true); } catch { }
      }
    }
  }
}
