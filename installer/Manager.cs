using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Management;
using System.Text;
using System.Text.RegularExpressions;
using System.Windows.Forms;

namespace ComputerMCPWindows {
  // Interface language: follows Windows (Chinese gets Chinese, everything else English) until the
  // person clicks the button in the header; the choice is kept in language.txt next to the manager's state.
  static class UiLang {
    public static bool English;
    private static string savedFile;
    public static void Init(string dir) {
      savedFile = Path.Combine(dir, "language.txt");
      string saved = null;
      try { if (System.IO.File.Exists(savedFile)) saved = System.IO.File.ReadAllText(savedFile).Trim().ToLowerInvariant(); } catch { }
      if (saved == "en") English = true;
      else if (saved == "zh") English = false;
      else English = System.Globalization.CultureInfo.CurrentUICulture.TwoLetterISOLanguageName != "zh";
    }
    public static void Save(bool english) {
      try { System.IO.File.WriteAllText(savedFile, english ? "en" : "zh"); } catch { }
    }
  }

  public class ManagerForm : Form {
    private static string T(string zh, string en) { return UiLang.English ? en : zh; }

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
      UiLang.Init(stateDir);

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
      var subtitle = new Label { Text = T("无需安装 Node.js · 一键连接自己的 Windows 电脑", "No Node.js install needed · connect your own Windows computer in one click"), ForeColor = Color.FromArgb(207, 223, 243), Font = new Font("Microsoft YaHei UI", 9), Location = new Point(28, 60), AutoSize = true };
      header.Controls.Add(title); header.Controls.Add(subtitle);
      var langButton = new Button {
        Text = UiLang.English ? "中文" : "English", Width = 90, Height = 30, FlatStyle = FlatStyle.Flat,
        ForeColor = Color.White, BackColor = Color.FromArgb(52, 80, 120), Location = new Point(560, 14), Cursor = Cursors.Hand
      };
      header.Resize += (s, e) => { langButton.Left = Math.Max(10, header.ClientSize.Width - langButton.Width - 24); };
      langButton.FlatAppearance.BorderColor = Color.FromArgb(120, 150, 190);
      langButton.Click += (s, e) => { UiLang.Save(!UiLang.English); Application.Restart(); };
      header.Controls.Add(langButton);

      var area = new Panel { Dock = DockStyle.Fill, Padding = new Padding(24, 18, 24, 12), AutoScroll = true };
      Controls.Add(area);
      Controls.Add(header);

      AddLabel(area, T("连接状态", "Connection status"), 15, 10, true);
      status = AddLabel(area, T("正在检查...", "Checking..."), 15, 43, false);
      status.ForeColor = Color.FromArgb(43, 114, 83);
      hint = AddLabel(area, T("链接就是电脑控制权限，请勿分享给不信任的人。", "The link is control of this computer. Don’t share it with anyone you don’t trust."), 15, 72, false);
      hint.ForeColor = Color.FromArgb(120, 130, 143);
      hint.Font = new Font("Microsoft YaHei UI", 8.5f);

      AddLabel(area, T("临时连接（无需域名）", "Temporary connection (no domain needed)"), 15, 113, true);
      start = AddButton(area, T("▶ 启动临时连接", "▶ Start temporary connection"), 15, 152, 298, Color.FromArgb(37, 99, 235));
      stop = AddButton(area, T("■ 停止我启动的连接", "■ Stop the connection I started"), 326, 152, 290, Color.FromArgb(94, 109, 127));
      start.Click += (s, e) => StartQuick();
      stop.Click += (s, e) => StopQuick();

      AddLabel(area, T("按需填写代理（可留空）", "Proxy, if needed (can be left empty)"), 15, 202, false);
      proxy = new TextBox { Location = new Point(15, 234), Width = 600, Height = 29, Text = "" };
      proxy.PlaceholderUnsupported();
      area.Controls.Add(proxy);
      AddLabel(area, T("例如：http://127.0.0.1:7890　仅用于你自己的网络环境", "e.g. http://127.0.0.1:7890 — only for your own network setup"), 15, 266, false).Font = new Font("Microsoft YaHei UI", 8);

      AddLabel(area, T("复制连接信息", "Copy connection info"), 15, 306, true);
      modeSelect = new ComboBox { Location = new Point(397, 302), Width = 219, DropDownStyle = ComboBoxStyle.DropDownList, Font = new Font("Microsoft YaHei UI", 9) };
      modeSelect.Items.AddRange(new object[] { T("自动选择", "Automatic"), T("临时隧道", "Temporary tunnel"), T("固定域名", "Fixed domain") });
      modeSelect.SelectedIndex = 0;
      modeSelect.SelectedIndexChanged += (s, e) => RefreshStatus();
      area.Controls.Add(modeSelect);
      full = AddButton(area, T("复制完整链接", "Copy full link"), 15, 343, 193, Color.FromArgb(37, 99, 235));
      address = AddButton(area, T("复制 MCP 地址", "Copy MCP address"), 221, 343, 193, Color.FromArgb(42, 117, 106));
      key = AddButton(area, T("复制密钥", "Copy key"), 427, 343, 189, Color.FromArgb(42, 117, 106));
      full.Click += (s, e) => CopyPart("full");
      address.Click += (s, e) => CopyPart("address");
      key.Click += (s, e) => CopyPart("key");
      AddLabel(area, T("完整链接适合只有 URL 的客户端；分开填写时密钥是 Bearer Token。", "The full link suits clients that take only a URL; when you fill in the fields separately, the key is a Bearer token."), 15, 381, false).Font = new Font("Microsoft YaHei UI", 8.3f);

      AddLabel(area, T("固定域名（可选，需要自己的 Cloudflare 域名）", "Fixed domain (optional; needs your own Cloudflare domain)"), 15, 416, true);
      domain = new TextBox { Location = new Point(15, 450), Width = 305, Height = 29, Text = "example.com" };
      area.Controls.Add(domain);
      var fixedButton = AddButton(area, T("配置固定域名", "Set up fixed domain"), 330, 448, 285, Color.FromArgb(94, 109, 127));
      fixedButton.Click += (s, e) => SetupFixed();
      var desktopButton = AddButton(area, T("安装桌面控制 / OCR（需要额外下载）", "Install desktop control / OCR (extra download)"), 15, 495, 600, Color.FromArgb(94, 109, 127));
      desktopButton.Click += (s, e) => InstallDesktop();
      var psButton = AddButton(area, T("AI 命令行：用 PowerShell", "AI shell: use PowerShell"), 15, 541, 293, Color.FromArgb(94, 109, 127));
      psButton.Click += (s, e) => StartCliTask("shell powershell", T("切换到 PowerShell", "Switch to PowerShell"));
      var bashButton = AddButton(area, T("AI 命令行：下载并用 Bash（约 60 MB）", "AI shell: download Bash (~60 MB)"), 322, 541, 293, Color.FromArgb(94, 109, 127));
      bashButton.Click += (s, e) => UseBash();
      AddLabel(area, T("多台电脑（一个 MCP 地址控制所有电脑）", "Several computers (one MCP address controls them all)"), 15, 598, true);
      var appButton = AddButton(area, T("这台是主电脑：连接手机 App（显示二维码）", "This is the main computer: connect the phone app (show QR code)"), 15, 632, 600, Color.FromArgb(37, 99, 235));
      appButton.Click += (s, e) => ShowAppQr();
      AddLabel(area, T("这台是新电脑：粘贴手机 App 给的配对码", "This is a new computer: paste the pairing code from the phone app"), 15, 678, false);
      pairCode = new TextBox { Location = new Point(15, 710), Width = 430, Height = 29 };
      area.Controls.Add(pairCode);
      var joinButton = AddButton(area, T("加入主电脑", "Join main computer"), 456, 706, 160, Color.FromArgb(37, 99, 235));
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
        var outputTask = p.StandardOutput.ReadToEndAsync();
        var errorTask = p.StandardError.ReadToEndAsync();
        if (!p.WaitForExit(timeout)) { try { p.Kill(); } catch {} throw new Exception(T("命令超时", "Command timed out")); }
        string output = outputTask.GetAwaiter().GetResult();
        string error = errorTask.GetAwaiter().GetResult();
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
        if (mode == "quick") { status.Text = T("● 临时隧道已连接", "● Temporary tunnel connected"); hint.Text = T("可以复制完整链接，也可以分别复制地址和密钥。", "You can copy the full link, or copy the address and key separately."); }
        else if (mode == "fixed") { status.Text = T("● 已配置固定域名（使用复制按钮获取连接信息）", "● Fixed domain configured (use the copy buttons to get the connection info)"); hint.Text = T("固定域名的有效性请另用 status 命令确认。", "To check whether the fixed domain works, use the status command."); }
        else { status.Text = T("○ 尚未启动连接", "○ Not connected yet"); hint.Text = T("点击「启动临时连接」，不需要 Node.js 或 Cloudflare 账号。", "Click “Start temporary connection”; no Node.js or Cloudflare account is needed."); }
        full.Enabled = address.Enabled = key.Enabled = mode != null;
      } catch (Exception ex) { status.Text = T("状态检查失败", "Status check failed"); hint.Text = ex.Message; }
      finally { refreshing = false; }
    }
    private string LinkMode() {
      var mode = CurrentMode();
      if (mode == null) throw new Exception(T("请先启动连接。", "Start the connection first."));
      return mode;
    }
    private void CopyPart(string part) {
      try {
        var mode = LinkMode();
        var option = part == "address" ? " --address" : part == "key" ? " --key" : " --show";
        var value = Run("link --" + mode + option);
        if (string.IsNullOrWhiteSpace(value)) throw new Exception(T("未能取得连接信息。", "Couldn’t get the connection info."));
        Clipboard.SetText(value);
        status.Text = T("✓ 已复制", "✓ Copied\u0020") + (part == "full" ? T("完整链接", "full link") : part == "address" ? T("MCP 地址", "MCP address") : T("密钥", "key"));
      } catch (Exception ex) { MessageBox.Show(ex.Message, T("复制失败", "Copy failed"), MessageBoxButtons.OK, MessageBoxIcon.Warning); }
    }
    private void StartQuick() {
      try {
        if (CurrentMode() == "quick") { status.Text = T("临时连接已经运行", "The temporary connection is already running"); return; }
        var ok = MessageBox.Show(T("连接链接可授予 AI 完整的电脑操作权限，包括读取和修改文件。\n\n只能将链接提供给你信任的客户端。确认启动？", "The connection link gives the AI full control of this computer, including reading and changing files.\n\nOnly give the link to clients you trust. Start it?"), T("远程控制安全提示", "Remote control security notice"), MessageBoxButtons.YesNo, MessageBoxIcon.Warning);
        if (ok != DialogResult.Yes) return;
        string args = Q(cli) + " quick --name windows-pc --cloudflared " + Q(tunnel);
        if (!string.IsNullOrWhiteSpace(proxy.Text)) {
          if (!Uri.IsWellFormedUriString(proxy.Text.Trim(), UriKind.Absolute)) throw new Exception(T("代理地址格式不正确。", "The proxy address is not valid."));
          args += " --proxy " + Q(proxy.Text.Trim());
        }
        var psi = new ProcessStartInfo(node, args) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true, WorkingDirectory = root };
        var process = new Process { StartInfo = psi, EnableRaisingEvents = true };
        if (!process.Start()) throw new Exception(T("无法启动临时连接。", "Couldn’t start the temporary connection."));
        string pidFile = managerPidFile;
        File.WriteAllText(pidFile, process.Id + "|" + process.StartTime.ToUniversalTime().Ticks);
        process.OutputDataReceived += (s, e) => Log(e.Data);
        process.ErrorDataReceived += (s, e) => Log(e.Data);
        process.BeginOutputReadLine(); process.BeginErrorReadLine();
        status.Text = T("连接正在启动...", "Connection is starting...");
        hint.Text = T("通常需要数秒。连接就绪后复制按钮会启用。", "This usually takes a few seconds. The copy buttons are enabled once it is ready.");
      } catch (Exception ex) { MessageBox.Show(ex.Message, T("启动失败", "Couldn’t start"), MessageBoxButtons.OK, MessageBoxIcon.Error); }
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
        if (!File.Exists(managerPidFile)) throw new Exception(T("本管理器没有记录到它启动的临时隧道；不会终止其他进程。", "This manager has no record of a temporary tunnel it started; it won’t stop any other process."));
        var parts = File.ReadAllText(managerPidFile).Split('|');
        var pid = int.Parse(parts[0]);
        var timestamp = long.Parse(parts[1]);
        var p = Process.GetProcessById(pid);
        if (!p.ProcessName.Equals("node", StringComparison.OrdinalIgnoreCase) || p.StartTime.ToUniversalTime().Ticks != timestamp)
          throw new Exception(T("PID 已经被复用，不能安全停止。", "The PID has been reused, so it can’t be stopped safely."));
        using (var query = new ManagementObjectSearcher("SELECT CommandLine FROM Win32_Process WHERE ProcessId=" + pid)) {
          bool ours = false;
          foreach (ManagementObject item in query.Get()) {
            var cmd = Convert.ToString(item["CommandLine"]);
            ours = cmd.IndexOf(Path.Combine(root, "app", "bin", "computer-mcp.mjs"), StringComparison.OrdinalIgnoreCase) >= 0 && cmd.Contains(" quick ");
          }
          if (!ours) throw new Exception(T("进程身份不匹配，拒绝关闭。", "The process identity doesn’t match; refusing to stop it."));
        }
        var psi = new ProcessStartInfo("taskkill.exe", "/PID " + pid + " /T /F") { UseShellExecute = false, CreateNoWindow = true };
        using (var kill = Process.Start(psi)) { kill.WaitForExit(7000); if (kill.ExitCode != 0) throw new Exception(T("停止进程失败", "Couldn’t stop the process")); }
        File.Delete(managerPidFile);
        status.Text = T("已停止本管理器启动的临时连接", "Stopped the temporary connection this manager started");
        hint.Text = T("重新启动会获得新的随机地址和密钥。", "Starting again gives a new random address and key.");
      } catch (ArgumentException) { File.Delete(managerPidFile); status.Text = T("临时连接已经结束", "The temporary connection has already ended"); }
      catch (Exception ex) { MessageBox.Show(ex.Message, T("无法停止", "Couldn’t stop"), MessageBoxButtons.OK, MessageBoxIcon.Warning); }
    }
    private void SetupFixed() {
      var d = domain.Text.Trim();
      if (!Regex.IsMatch(d, @"^(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,63}$") || d == "example.com") {
        MessageBox.Show(T("请输入你自己在 Cloudflare 管理的域名（例如 mydomain.com）。", "Enter a domain you manage in Cloudflare (for example mydomain.com).")); return;
      }
      if (MessageBox.Show(T("需要 Cloudflare 账号并配置域名 DNS，过程可能申请管理员权限。\n继续？", "This needs a Cloudflare account and DNS set up for the domain, and may ask for administrator rights.\nContinue?"), T("配置固定连接", "Set up fixed connection"), MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes) return;
      try {
        var args = "setup windows-pc --domain " + Q(d) + " --cloudflared " + Q(tunnel);
        if (!string.IsNullOrWhiteSpace(proxy.Text)) args += " --proxy " + Q(proxy.Text.Trim());
        StartCliTask(args, T("配置固定连接", "Set up fixed connection"));
      } catch (Exception ex) { MessageBox.Show(ex.Message, T("配置失败", "Setup failed")); }
    }
    private void ShowAppQr() {
      try {
        Cursor = Cursors.WaitCursor;
        var lines = Run("app --rows", 60000).Split('\n');
        if (lines.Length < 22) throw new Exception(T("未能生成二维码。", "Couldn’t generate the QR code."));
        var form = new Form { Text = T("连接手机 App", "Connect phone app"), ClientSize = new Size(440, 500), StartPosition = FormStartPosition.CenterParent, FormBorderStyle = FormBorderStyle.FixedDialog, MaximizeBox = false, BackColor = Color.White };
        int size = lines[1].Trim().Length, scale = 360 / (size + 2);
        var image = new Bitmap((size + 2) * scale, (size + 2) * scale);
        using (var g = Graphics.FromImage(image)) {
          g.Clear(Color.White);
          for (int y = 0; y < size; y++) { var row = lines[y + 1].Trim(); for (int x = 0; x < size; x++) if (row[x] == '1') g.FillRectangle(Brushes.Black, (x + 1) * scale, (y + 1) * scale, scale, scale); }
        }
        form.Controls.Add(new PictureBox { Image = image, SizeMode = PictureBoxSizeMode.CenterImage, Location = new Point(20, 15), Size = new Size(400, 380) });
        form.Controls.Add(new Label { Text = T("打开手机上的 Computer MCP，点“扫码连接”。\n这个二维码等于所有电脑的钥匙，不要给别人看。", "Open Computer MCP on your phone and tap “Scan to connect”.\nThis QR code is the key to all your computers; don’t show it to anyone."), Location = new Point(20, 405), Size = new Size(400, 50), TextAlign = ContentAlignment.MiddleCenter });
        var text = lines[0].Trim();
        var copy = new Button { Text = T("扫不了？复制连接文本", "Can’t scan? Copy the connection text"), Location = new Point(120, 458), Size = new Size(200, 32) };
        copy.Click += (s, e) => { Clipboard.SetText(text); copy.Text = T("已复制", "Copied"); };
        form.Controls.Add(copy);
        form.ShowDialog(this);
      } catch (Exception ex) { MessageBox.Show(ex.Message, T("无法连接手机", "Couldn’t connect the phone"), MessageBoxButtons.OK, MessageBoxIcon.Warning); }
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
        if (!process.Start()) throw new Exception(T("无法启动 Computer MCP。", "Couldn’t start Computer MCP."));
        process.BeginOutputReadLine();
        process.BeginErrorReadLine();
      } catch { process.Dispose(); throw; }
      status.Text = title + T("正在执行...", "\u0020in progress...");
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
            MessageBox.Show(this, string.IsNullOrWhiteSpace(result) ? (exitCode == 0 ? T("操作已完成。", "Done.") : T("操作失败，未提供错误信息。", "Failed, and no error message was given.")) : result,
              title + (exitCode == 0 ? T("成功", "\u0020succeeded") : T("失败", "\u0020failed")), MessageBoxButtons.OK,
              exitCode == 0 ? MessageBoxIcon.Information : MessageBoxIcon.Error);
            RefreshStatus();
          }));
        } catch (InvalidOperationException) { /* The user closed this window. */ }
      });
    }
    private void JoinHub() {
      var code = pairCode.Text.Trim();
      if (!Regex.IsMatch(code, @"^(cmcp://)?[A-Za-z0-9.-]+[ /][0-9A-Za-z-]{8,9}$")) { MessageBox.Show(T("配对码不对，请从手机 App 重新复制。", "That pairing code isn’t right; copy it again from the phone app.")); return; }
      if (MessageBox.Show(T("加入后，主电脑上连接的 AI 可以完全控制这台电脑，包括读取和修改文件。\n只加入你自己的主电脑。继续？", "After joining, the AI connected to the main computer can fully control this computer, including reading and changing files.\nOnly join your own main computer. Continue?"), T("加入主电脑", "Join main computer"), MessageBoxButtons.YesNo, MessageBoxIcon.Warning) != DialogResult.Yes) return;
      try {
        var args = "join " + Q(code.Replace(" ", "/").Replace("cmcp://", ""));
        if (!string.IsNullOrWhiteSpace(proxy.Text)) args += " --proxy " + Q(proxy.Text.Trim());
        StartCliTask(args, T("加入主电脑", "Join main computer"));
      } catch (Exception ex) { MessageBox.Show(ex.Message, T("加入失败", "Couldn’t join")); }
    }
    private void UseBash() {
      var args = "shell bash";
      if (!string.IsNullOrWhiteSpace(proxy.Text)) args += " --proxy " + Q(proxy.Text.Trim());
      StartCliTask(args, T("切换到 Bash", "Switch to Bash"));
    }
    private void InstallDesktop() {
      var answer = MessageBox.Show(T("完整 OCR / 鼠标键盘控制需要 Python 3.10–3.13 及模型（约 500 MB 或更多）。\n\n如果没有 Python，会先尝试使用 winget 安装 Python 3.12。安装过程需要联网。\n继续？", "Full OCR and mouse/keyboard control need Python 3.10–3.13 and models (about 500 MB or more).\n\nIf Python is missing, it first tries to install Python 3.12 with winget. The installation needs internet access.\nContinue?"), T("安装桌面控制", "Install desktop control"), MessageBoxButtons.YesNo, MessageBoxIcon.Question);
      if (answer != DialogResult.Yes) return;
      try {
        var command = "where py >nul 2>&1 || winget install --id Python.Python.3.12 -e --accept-source-agreements --accept-package-agreements && " + Q(node) + " " + Q(cli) + " desktop";
        Process.Start(new ProcessStartInfo("cmd.exe", "/k " + Q(command)) { UseShellExecute = true, WorkingDirectory = root });
      } catch (Exception ex) { MessageBox.Show(ex.Message, T("安装失败", "Install failed")); }
    }
  }
  static class NoPlaceholder { public static void PlaceholderUnsupported(this TextBox box) { } }
  static class Program {
    [STAThread] static void Main() { Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false); Application.Run(new ManagerForm()); }
  }
}
