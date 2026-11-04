using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Management;
using System.Text;
using System.Text.RegularExpressions;
using System.Windows.Forms;

namespace ComputerMCPWindows {
  public class ManagerForm : Form {
    private readonly string root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
    private readonly string node;
    private readonly string cli;
    private readonly string tunnel;
    private readonly string stateDir;
    private readonly string managerPidFile;
    private readonly Label status;
    private readonly Label hint;
    private readonly TextBox domain;
    private readonly TextBox proxy;
    private readonly ComboBox modeSelect;
    private readonly Button start;
    private readonly Button stop;
    private readonly Button full;
    private readonly Button address;
    private readonly Button key;
    private readonly TextBox pairCode;
    private readonly System.Windows.Forms.Timer ticker;
    private bool refreshing;

    public ManagerForm() {
      node = Path.Combine(root, "runtime", "node.exe");
      cli = Path.Combine(root, "app", "bin", "computer-mcp.mjs");
      tunnel = Path.Combine(root, "runtime", "cloudflared.exe");
      stateDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ComputerMCP");
      managerPidFile = Path.Combine(stateDir, "managed-quick.pid");
      Directory.CreateDirectory(stateDir);

      Text = "Computer MCP · Windows";
      Width = 700;
      Height = 600;
      MinimumSize = new Size(660, 540);
      StartPosition = FormStartPosition.CenterScreen;
      Font = new Font("Microsoft YaHei UI", 10);
      BackColor = Color.FromArgb(247, 249, 252);
      ForeColor = Color.FromArgb(36, 50, 69);

      var header = new Panel { Dock = DockStyle.Top, Height = 92, BackColor = Color.FromArgb(33, 56, 89) };
      var title = new Label { Text = "Computer MCP", Font = new Font("Segoe UI", 22, FontStyle.Bold), ForeColor = Color.White, Location = new Point(25, 12), AutoSize = true };
      var subtitle = new Label { Text = "无需安装 Node.js · 一键连接自己的 Windows 电脑", ForeColor = Color.FromArgb(207, 223, 243), Font = new Font("Microsoft YaHei UI", 9), Location = new Point(28, 60), AutoSize = true };
      header.Controls.Add(title); header.Controls.Add(subtitle);

      var area = new Panel { Dock = DockStyle.Fill, Padding = new Padding(24, 18, 24, 12), AutoScroll = true };
      Controls.Add(area);
      Controls.Add(header);

      AddLabel(area, "连接状态", 15, 10, true);
      status = AddLabel(area, "正在检查...", 15, 43, false);
      status.ForeColor = Color.FromArgb(43, 114, 83);
      hint = AddLabel(area, "链接就是电脑控制权限，请勿分享给不信任的人。", 15, 72, false);
      hint.ForeColor = Color.FromArgb(120, 130, 143);
      hint.Font = new Font("Microsoft YaHei UI", 8.5f);

      AddLabel(area, "临时连接（无需域名）", 15, 113, true);
      start = AddButton(area, "▶ 启动临时连接", 15, 152, 298, Color.FromArgb(37, 99, 235));
      stop = AddButton(area, "■ 停止我启动的连接", 326, 152, 290, Color.FromArgb(94, 109, 127));
      start.Click += (s, e) => StartQuick();
      stop.Click += (s, e) => StopQuick();

      AddLabel(area, "按需填写代理（可留空）", 15, 202, false);
      proxy = new TextBox { Location = new Point(15, 234), Width = 600, Height = 29, Text = "" };
      proxy.PlaceholderUnsupported();
      area.Controls.Add(proxy);
      AddLabel(area, "例如：http://127.0.0.1:7890　仅用于你自己的网络环境", 15, 266, false).Font = new Font("Microsoft YaHei UI", 8);

      AddLabel(area, "复制连接信息", 15, 306, true);
      modeSelect = new ComboBox { Location = new Point(397, 302), Width = 219, DropDownStyle = ComboBoxStyle.DropDownList, Font = new Font("Microsoft YaHei UI", 9) };
      modeSelect.Items.AddRange(new object[] { "自动选择", "临时隧道", "固定域名" });
      modeSelect.SelectedIndex = 0;
      modeSelect.SelectedIndexChanged += (s, e) => RefreshStatus();
      area.Controls.Add(modeSelect);
      full = AddButton(area, "复制完整链接", 15, 343, 193, Color.FromArgb(37, 99, 235));
      address = AddButton(area, "复制 MCP 地址", 221, 343, 193, Color.FromArgb(42, 117, 106));
      key = AddButton(area, "复制密钥", 427, 343, 189, Color.FromArgb(42, 117, 106));
      full.Click += (s, e) => CopyPart("full");
      address.Click += (s, e) => CopyPart("address");
      key.Click += (s, e) => CopyPart("key");
      AddLabel(area, "完整链接适合只有 URL 的客户端；分开填写时密钥是 Bearer Token。", 15, 381, false).Font = new Font("Microsoft YaHei UI", 8.3f);

      AddLabel(area, "固定域名（可选，需要自己的 Cloudflare 域名）", 15, 416, true);
      domain = new TextBox { Location = new Point(15, 450), Width = 305, Height = 29, Text = "example.com" };
      area.Controls.Add(domain);
      var fixedButton = AddButton(area, "配置固定域名", 330, 448, 285, Color.FromArgb(94, 109, 127));
      fixedButton.Click += (s, e) => SetupFixed();
      var desktopButton = AddButton(area, "安装桌面控制 / OCR（需要额外下载）", 15, 495, 600, Color.FromArgb(94, 109, 127));
      desktopButton.Click += (s, e) => InstallDesktop();
      var psButton = AddButton(area, "AI 命令行：用 PowerShell", 15, 541, 293, Color.FromArgb(94, 109, 127));
      psButton.Click += (s, e) => StartCliTask("shell powershell", "切换到 PowerShell");
      var bashButton = AddButton(area, "AI 命令行：下载并用 Bash（约 60 MB）", 322, 541, 293, Color.FromArgb(94, 109, 127));
      bashButton.Click += (s, e) => UseBash();
      AddLabel(area, "多台电脑（一个 MCP 地址控制所有电脑）", 15, 598, true);
      var appButton = AddButton(area, "这台是主电脑：连接手机 App（显示二维码）", 15, 632, 600, Color.FromArgb(37, 99, 235));
      appButton.Click += (s, e) => ShowAppQr();
      AddLabel(area, "这台是新电脑：粘贴手机 App 给的配对码", 15, 678, false);
      pairCode = new TextBox { Location = new Point(15, 710), Width = 430, Height = 29 };
      area.Controls.Add(pairCode);
      var joinButton = AddButton(area, "加入主电脑", 456, 706, 160, Color.FromArgb(37, 99, 235));
      joinButton.Click += (s, e) => JoinHub();
      area.AutoScrollMinSize = new Size(0, 765);

      ticker = new System.Windows.Forms.Timer { Interval = 3500 };
      ticker.Tick += (s, e) => RefreshStatus();
      Shown += (s, e) => { RefreshStatus(); ticker.Start(); };
      FormClosed += (s, e) => ticker.Stop();
    }

    private static Label AddLabel(Control parent, string text, int x, int y, bool title) {
      var l = new Label { Text = text, Location = new Point(x, y), AutoSize = true, Font = new Font("Microsoft YaHei UI", title ? 11f : 9.5f, title ? FontStyle.Bold : FontStyle.Regular) };
      parent.Controls.Add(l); return l;
    }
    private static Button AddButton(Control parent, string text, int x, int y, int width, Color color) {
      var b = new Button { Text = text, Location = new Point(x, y), Size = new Size(width, 37), BackColor = color, ForeColor = Color.White, FlatStyle = FlatStyle.Flat, Cursor = Cursors.Hand };
      b.FlatAppearance.BorderSize = 0; parent.Controls.Add(b); return b;
    }
    private static string Q(string s) { return "\"" + s.Replace("\"", "\\\"") + "\""; }
    private string Run(string args, int timeout = 4500) {
      var psi = new ProcessStartInfo(node, Q(cli) + " " + args) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true, WorkingDirectory = root };
      using (var p = Process.Start(psi)) {
        string output = p.StandardOutput.ReadToEnd();
        string error = p.StandardError.ReadToEnd();
        if (!p.WaitForExit(timeout)) { try { p.Kill(); } catch {} throw new Exception("命令超时"); }
        if (p.ExitCode != 0) throw new Exception(error.Trim().Length > 0 ? error.Trim() : output.Trim());
        return output.Trim();
      }
    }
    private string CurrentMode() {
      if (modeSelect.SelectedIndex != 2) {
        try { Run("link --quick --address"); return "quick"; } catch {}
      }
      if (modeSelect.SelectedIndex != 1) {
        try { Run("link --fixed --address"); return "fixed"; } catch {}
      }
      return null;
    }
    private void RefreshStatus() {
      if (refreshing) return;
      refreshing = true;
      try {
        var mode = CurrentMode();
        if (mode == "quick") { status.Text = "● 临时隧道已连接"; hint.Text = "可以复制完整链接，也可以分别复制地址和密钥。"; }
        else if (mode == "fixed") { status.Text = "● 已配置固定域名（使用复制按钮获取连接信息）"; hint.Text = "固定域名的有效性请另用 status 命令确认。"; }
        else { status.Text = "○ 尚未启动连接"; hint.Text = "点击「启动临时连接」，不需要 Node.js 或 Cloudflare 账号。"; }
        full.Enabled = address.Enabled = key.Enabled = mode != null;
      } catch (Exception ex) { status.Text = "状态检查失败"; hint.Text = ex.Message; }
      finally { refreshing = false; }
    }
    private string LinkMode() {
      var mode = CurrentMode();
      if (mode == null) throw new Exception("请先启动连接。");
      return mode;
    }
    private void CopyPart(string part) {
      try {
        var mode = LinkMode();
        var option = part == "address" ? " --address" : part == "key" ? " --key" : " --show";
        var value = Run("link --" + mode + option);
        if (string.IsNullOrWhiteSpace(value)) throw new Exception("未能取得连接信息。");
        Clipboard.SetText(value);
        status.Text = "✓ 已复制" + (part == "full" ? "完整链接" : part == "address" ? "MCP 地址" : "密钥");
      } catch (Exception ex) { MessageBox.Show(ex.Message, "复制失败", MessageBoxButtons.OK, MessageBoxIcon.Warning); }
    }
    private void StartQuick() {
      try {
        if (CurrentMode() == "quick") { status.Text = "临时连接已经运行"; return; }
        var ok = MessageBox.Show("连接链接可授予 AI 完整的电脑操作权限，包括读取和修改文件。\n\n只能将链接提供给你信任的客户端。确认启动？", "远程控制安全提示", MessageBoxButtons.YesNo, MessageBoxIcon.Warning);
        if (ok != DialogResult.Yes) return;
        string args = Q(cli) + " quick --name windows-pc --cloudflared " + Q(tunnel);
        if (!string.IsNullOrWhiteSpace(proxy.Text)) {
          if (!Uri.IsWellFormedUriString(proxy.Text.Trim(), UriKind.Absolute)) throw new Exception("代理地址格式不正确。");
          args += " --proxy " + Q(proxy.Text.Trim());
        }
        var psi = new ProcessStartInfo(node, args) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true, WorkingDirectory = root };
        var process = new Process { StartInfo = psi, EnableRaisingEvents = true };
        if (!process.Start()) throw new Exception("无法启动临时连接。");
        string pidFile = managerPidFile;
        File.WriteAllText(pidFile, process.Id + "|" + process.StartTime.ToUniversalTime().Ticks);
        process.OutputDataReceived += (s, e) => Log(e.Data);
        process.ErrorDataReceived += (s, e) => Log(e.Data);
        process.BeginOutputReadLine(); process.BeginErrorReadLine();
        status.Text = "连接正在启动...";
        hint.Text = "通常需要数秒。连接就绪后复制按钮会启用。";
      } catch (Exception ex) { MessageBox.Show(ex.Message, "启动失败", MessageBoxButtons.OK, MessageBoxIcon.Error); }
    }
    private void Log(string value) {
      if (value == null) return;
      try {
        // Never store a secret-bearing full URL in the manager log.
        value = Regex.Replace(value, @"/t/[A-Za-z0-9_-]{16,}/mcp", "/t/[REDACTED]/mcp");
        lock (typeof(ManagerForm)) File.AppendAllText(Path.Combine(stateDir, "manager.log"), DateTime.Now.ToString("s") + " " + value + Environment.NewLine);
      } catch {}
    }
    private void StopQuick() {
      try {
        if (!File.Exists(managerPidFile)) throw new Exception("本管理器没有记录到它启动的临时隧道；不会终止其他进程。");
        var parts = File.ReadAllText(managerPidFile).Split('|');
        var pid = int.Parse(parts[0]);
        var timestamp = long.Parse(parts[1]);
        var p = Process.GetProcessById(pid);
        if (!p.ProcessName.Equals("node", StringComparison.OrdinalIgnoreCase) || p.StartTime.ToUniversalTime().Ticks != timestamp)
          throw new Exception("PID 已经被复用，不能安全停止。");
        using (var query = new ManagementObjectSearcher("SELECT CommandLine FROM Win32_Process WHERE ProcessId=" + pid)) {
          bool ours = false;
          foreach (ManagementObject item in query.Get()) {
            var cmd = Convert.ToString(item["CommandLine"]);
            ours = cmd.IndexOf(Path.Combine(root, "app", "bin", "computer-mcp.mjs"), StringComparison.OrdinalIgnoreCase) >= 0 && cmd.Contains(" quick ");
          }
          if (!ours) throw new Exception("进程身份不匹配，拒绝关闭。");
        }
        var psi = new ProcessStartInfo("taskkill.exe", "/PID " + pid + " /T /F") { UseShellExecute = false, CreateNoWindow = true };
        using (var kill = Process.Start(psi)) { kill.WaitForExit(7000); if (kill.ExitCode != 0) throw new Exception("停止进程失败"); }
        File.Delete(managerPidFile);
        status.Text = "已停止本管理器启动的临时连接";
        hint.Text = "重新启动会获得新的随机地址和密钥。";
      } catch (ArgumentException) { File.Delete(managerPidFile); status.Text = "临时连接已经结束"; }
      catch (Exception ex) { MessageBox.Show(ex.Message, "无法停止", MessageBoxButtons.OK, MessageBoxIcon.Warning); }
    }
    private void SetupFixed() {
      var d = domain.Text.Trim();
      if (!Regex.IsMatch(d, @"^(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,63}$") || d == "example.com") {
        MessageBox.Show("请输入你自己在 Cloudflare 管理的域名（例如 mydomain.com）。"); return;
      }
      if (MessageBox.Show("需要 Cloudflare 账号并配置域名 DNS，过程可能申请管理员权限。\n继续？", "配置固定连接", MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes) return;
      try {
        var args = "setup windows-pc --domain " + Q(d) + " --cloudflared " + Q(tunnel);
        if (!string.IsNullOrWhiteSpace(proxy.Text)) args += " --proxy " + Q(proxy.Text.Trim());
        StartCliTask(args, "配置固定连接");
      } catch (Exception ex) { MessageBox.Show(ex.Message, "配置失败"); }
    }
    private void ShowAppQr() {
      try {
        Cursor = Cursors.WaitCursor;
        var lines = Run("app --rows", 60000).Split('\n');
        if (lines.Length < 22) throw new Exception("未能生成二维码。");
        var form = new Form { Text = "连接手机 App", ClientSize = new Size(440, 500), StartPosition = FormStartPosition.CenterParent, FormBorderStyle = FormBorderStyle.FixedDialog, MaximizeBox = false, BackColor = Color.White };
        int size = lines[1].Trim().Length, scale = 360 / (size + 2);
        var image = new Bitmap((size + 2) * scale, (size + 2) * scale);
        using (var g = Graphics.FromImage(image)) {
          g.Clear(Color.White);
          for (int y = 0; y < size; y++) { var row = lines[y + 1].Trim(); for (int x = 0; x < size; x++) if (row[x] == '1') g.FillRectangle(Brushes.Black, (x + 1) * scale, (y + 1) * scale, scale, scale); }
        }
        form.Controls.Add(new PictureBox { Image = image, SizeMode = PictureBoxSizeMode.CenterImage, Location = new Point(20, 15), Size = new Size(400, 380) });
        form.Controls.Add(new Label { Text = "打开手机上的 Computer MCP，点“扫码连接”。\n这个二维码等于所有电脑的钥匙，不要给别人看。", Location = new Point(20, 405), Size = new Size(400, 50), TextAlign = ContentAlignment.MiddleCenter });
        var text = lines[0].Trim();
        var copy = new Button { Text = "扫不了？复制连接文本", Location = new Point(120, 458), Size = new Size(200, 32) };
        copy.Click += (s, e) => { Clipboard.SetText(text); copy.Text = "已复制"; };
        form.Controls.Add(copy);
        form.ShowDialog(this);
      } catch (Exception ex) { MessageBox.Show(ex.Message, "无法连接手机", MessageBoxButtons.OK, MessageBoxIcon.Warning); }
      finally { Cursor = Cursors.Default; }
    }
    // Launch the bundled Node executable directly: cmd.exe /k nested quotes break on some Windows PCs.
    // Consume both streams asynchronously and report the final result in the GUI.
    private void StartCliTask(string args, string title) {
      var psi = new ProcessStartInfo(node, Q(cli) + " " + args) {
        UseShellExecute = false, CreateNoWindow = true,
        RedirectStandardOutput = true, RedirectStandardError = true, WorkingDirectory = root
      };
      var process = new Process { StartInfo = psi };
      var output = new StringBuilder();
      var errors = new StringBuilder();
      process.OutputDataReceived += (s, e) => { if (e.Data != null) lock (output) output.AppendLine(e.Data); };
      process.ErrorDataReceived += (s, e) => { if (e.Data != null) lock (errors) errors.AppendLine(e.Data); };
      try {
        if (!process.Start()) throw new Exception("无法启动 Computer MCP。");
        process.BeginOutputReadLine();
        process.BeginErrorReadLine();
      } catch { process.Dispose(); throw; }
      status.Text = title + "正在执行...";
      System.Threading.ThreadPool.QueueUserWorkItem(_ => {
        int exitCode = -1;
        string result;
        try {
          process.WaitForExit();
          exitCode = process.ExitCode;
          lock (output) lock (errors) result = (exitCode == 0 ? output.ToString() : errors.ToString() + "\n" + output.ToString()).Trim();
        } catch (Exception ex) { result = ex.Message; }
        finally { process.Dispose(); }
        if (result.Length > 2000) result = result.Substring(result.Length - 2000);
        try {
          if (!IsDisposed && IsHandleCreated) BeginInvoke((Action)(() => {
            MessageBox.Show(this, string.IsNullOrWhiteSpace(result) ? (exitCode == 0 ? "操作已完成。" : "操作失败，未提供错误信息。") : result,
              title + (exitCode == 0 ? "成功" : "失败"), MessageBoxButtons.OK,
              exitCode == 0 ? MessageBoxIcon.Information : MessageBoxIcon.Error);
            RefreshStatus();
          }));
        } catch (InvalidOperationException) { /* The user closed this window. */ }
      });
    }
    private void JoinHub() {
      var code = pairCode.Text.Trim();
      if (!Regex.IsMatch(code, @"^(cmcp://)?[A-Za-z0-9.-]+[ /][0-9A-Za-z-]{8,9}$")) { MessageBox.Show("配对码不对，请从手机 App 重新复制。"); return; }
      if (MessageBox.Show("加入后，主电脑上连接的 AI 可以完全控制这台电脑，包括读取和修改文件。\n只加入你自己的主电脑。继续？", "加入主电脑", MessageBoxButtons.YesNo, MessageBoxIcon.Warning) != DialogResult.Yes) return;
      try {
        var args = "join " + Q(code.Replace(" ", "/").Replace("cmcp://", ""));
        if (!string.IsNullOrWhiteSpace(proxy.Text)) args += " --proxy " + Q(proxy.Text.Trim());
        StartCliTask(args, "加入主电脑");
      } catch (Exception ex) { MessageBox.Show(ex.Message, "加入失败"); }
    }
    private void UseBash() {
      var args = "shell bash";
      if (!string.IsNullOrWhiteSpace(proxy.Text)) args += " --proxy " + Q(proxy.Text.Trim());
      StartCliTask(args, "切换到 Bash");
    }
    private void InstallDesktop() {
      var answer = MessageBox.Show("完整 OCR / 鼠标键盘控制需要 Python 3.10–3.13 及模型（约 500 MB 或更多）。\n\n如果没有 Python，会先尝试使用 winget 安装 Python 3.12。安装过程需要联网。\n继续？", "安装桌面控制", MessageBoxButtons.YesNo, MessageBoxIcon.Question);
      if (answer != DialogResult.Yes) return;
      try {
        var command = "where py >nul 2>&1 || winget install --id Python.Python.3.12 -e --accept-source-agreements --accept-package-agreements && " + Q(node) + " " + Q(cli) + " desktop";
        Process.Start(new ProcessStartInfo("cmd.exe", "/k " + Q(command)) { UseShellExecute = true, WorkingDirectory = root });
      } catch (Exception ex) { MessageBox.Show(ex.Message, "安装失败"); }
    }
  }
  static class NoPlaceholder { public static void PlaceholderUnsupported(this TextBox box) { } }
  static class Program {
    [STAThread] static void Main() { Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false); Application.Run(new ManagerForm()); }
  }
}
