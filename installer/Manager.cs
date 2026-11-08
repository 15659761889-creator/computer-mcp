using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Management;
using System.Text;
using System.Text.RegularExpressions;
using System.Windows.Forms;

namespace WanjiWindows {
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
    private readonly Button planButton;
    private readonly LinkLabel buyLink;
    // Where Free users go to buy Pro; the site decides what that page offers.
    private const string BuyUrl = "https://wanji.3618.app/assets/buy.html";
    private string plan;            // "free", "pro" or null while unknown
    private string planExpires;
    private bool proConnected;
    private readonly System.Windows.Forms.Timer ticker;
    private bool refreshing;
    private bool settingUpPro;

    public ManagerForm() {
      node = Path.Combine(root, "runtime", "node.exe");
      cli = Path.Combine(root, "app", "bin", "wanji.mjs");
      tunnel = Path.Combine(root, "runtime", "cloudflared.exe");
      stateDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "万机");
      managerPidFile = Path.Combine(stateDir, "managed-quick.pid");
      Directory.CreateDirectory(stateDir);
      UiLang.Init(stateDir);

      Text = T("万机 · Windows", "Wanji · Windows");
      Width = 700;
      Height = 600;
      MinimumSize = new Size(660, 540);
      StartPosition = FormStartPosition.CenterScreen;
      Font = new Font("Microsoft YaHei UI", 10);
      BackColor = Color.FromArgb(247, 249, 252);
      ForeColor = Color.FromArgb(36, 50, 69);

      var header = new Panel { Dock = DockStyle.Top, Height = 92, BackColor = Color.FromArgb(33, 56, 89) };
      var title = new Label { Text = T("万机", "Wanji"), Font = new Font("Segoe UI", 22, FontStyle.Bold), ForeColor = Color.White, Location = new Point(25, 12), AutoSize = true };
      var subtitle = new Label { Text = T("无需安装 Node.js · 一键连接自己的 Windows 电脑", "No Node.js install needed · connect your own Windows computer in one click"), ForeColor = Color.FromArgb(207, 223, 243), Font = new Font("Microsoft YaHei UI", 9), Location = new Point(28, 60), AutoSize = true };
      header.Controls.Add(title); header.Controls.Add(subtitle);
      var langButton = new Button {
        Text = UiLang.English ? "中文" : "English", Width = 90, Height = 30, FlatStyle = FlatStyle.Flat,
        ForeColor = Color.White, BackColor = Color.FromArgb(52, 80, 120), Location = new Point(560, 14), Cursor = Cursors.Hand
      };
      langButton.FlatAppearance.BorderColor = Color.FromArgb(120, 150, 190);
      langButton.Click += (s, e) => { UiLang.Save(!UiLang.English); Application.Restart(); };
      header.Controls.Add(langButton);
      // Which plan this is and what it allows, one click away from the header.
      planButton = new Button {
        Text = T("套餐：检查中...", "Plan: checking..."), Width = 200, Height = 30, FlatStyle = FlatStyle.Flat,
        ForeColor = Color.White, BackColor = Color.FromArgb(52, 80, 120), Location = new Point(350, 14), Cursor = Cursors.Hand
      };
      planButton.FlatAppearance.BorderColor = Color.FromArgb(120, 150, 190);
      planButton.Click += (s, e) => ShowPlan();
      header.Controls.Add(planButton);
      header.Resize += (s, e) => {
        langButton.Left = Math.Max(10, header.ClientSize.Width - langButton.Width - 24);
        planButton.Left = Math.Max(140, langButton.Left - planButton.Width - 10);
      };

      var area = new Panel { Dock = DockStyle.Fill, Padding = new Padding(24, 18, 24, 12), AutoScroll = true };
      Controls.Add(area);
      Controls.Add(header);

      AddLabel(area, T("连接状态", "Connection status"), 15, 10, true);
      status = AddLabel(area, T("正在检查...", "Checking..."), 15, 43, false);
      status.ForeColor = Color.FromArgb(43, 114, 83);
      hint = AddLabel(area, T("链接就是电脑控制权限，请勿分享给不信任的人。", "The link is control of this computer. Don’t share it with anyone you don’t trust."), 15, 72, false);
      hint.ForeColor = Color.FromArgb(120, 130, 143);
      buyLink = new LinkLabel { Text = T("升级 Pro：固定地址 · 更多电脑 →", "Upgrade to Pro: fixed address · more computers →"), AutoSize = true, Location = new Point(360, 12), Visible = false, Font = new Font("Microsoft YaHei UI", 9.5f, FontStyle.Bold), LinkColor = Color.FromArgb(14, 117, 105) };
      buyLink.LinkClicked += (s, e) => { if (plan == "pro") ConnectPro(null); else OpenBuyPage(); };
      area.Controls.Add(buyLink);
      hint.Font = new Font("Microsoft YaHei UI", 8.5f);
      hint.MaximumSize = new Size(600, 0);  // long hints wrap instead of widening the page

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
      modeSelect.Items.AddRange(new object[] { T("自动选择", "Automatic"), T("临时隧道", "Temporary tunnel"), T("固定域名", "Fixed domain"), T("Pro 固定链接", "Pro fixed link") });
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
      var inviteButton = AddButton(area, T("一键生成加入文件（加新电脑不用输配对码）", "Generate join file in one click (add a new computer without a pairing code)"), 15, 678, 600, Color.FromArgb(37, 99, 235));
      inviteButton.Click += (s, e) => StartCliTask("invite --file", T("生成加入文件", "Generate join file"));
      var exeButton = AddButton(area, T("生成一键加入程序（新电脑双击就自动连接）", "Generate one-click joiner (the new computer just runs it)"), 15, 724, 430, Color.FromArgb(37, 99, 235));
      // Unchecked (the default): one use, 7 days. Either way the computer it adds stays
      // controlled until removed in the app; checked, the EXE itself can add more computers.
      var exePermanent = new CheckBox { Text = T("永久可反复用（直到作废）", "Reusable until revoked"), Location = new Point(456, 732), AutoSize = true, Font = new Font("Microsoft YaHei UI", 9.5f) };
      area.Controls.Add(exePermanent);
      exeButton.Click += (s, e) => StartCliTask(exePermanent.Checked ? "invite --exe --permanent" : "invite --exe", T("生成一键加入程序", "Generate one-click joiner"));
      var revokeButton = AddButton(area, T("作废所有加入程序和配对码（已加入的电脑不受影响）", "Revoke all joiners and pairing codes (joined computers stay)"), 15, 770, 600, Color.FromArgb(94, 109, 127));
      revokeButton.Click += (s, e) => {
        if (MessageBox.Show(this, T("确定作废所有还能用的加入程序和配对码吗？", "Revoke every joiner EXE and pairing code that still works?"), T("万机", "Wanji"), MessageBoxButtons.YesNo, MessageBoxIcon.Question) == DialogResult.Yes)
          StartCliTask("invite --cancel", T("作废加入程序", "Revoke joiners"));
      };
      AddLabel(area, T("这台是新电脑：粘贴手机 App 给的配对码", "This is a new computer: paste the pairing code from the phone app"), 15, 816, false);
      pairCode = new TextBox { Location = new Point(15, 848), Width = 430, Height = 29 };
      area.Controls.Add(pairCode);
      var joinButton = AddButton(area, T("加入主电脑", "Join main computer"), 456, 844, 160, Color.FromArgb(37, 99, 235));
      joinButton.Click += (s, e) => JoinHub();
      area.AutoScrollMinSize = new Size(0, 903);

      ticker = new System.Windows.Forms.Timer { Interval = 3500 };
      ticker.Tick += (s, e) => RefreshStatus();
      Shown += (s, e) => { RefreshStatus(); LoadPlan(); ticker.Start(); OfferJoinFile(); };
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
      // Node writes UTF-8 to pipes; without this .NET decodes them as the ANSI code page and Chinese turns to mojibake.
      var psi = new ProcessStartInfo(node, Q(cli) + " " + args) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true, StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8, WorkingDirectory = root };
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
    private bool ProConnected() {
      try { return Run("pro --json").Contains("\"connected\":true"); } catch { return false; }
    }
    private string CurrentMode() {
      if (modeSelect.SelectedIndex == 0 || modeSelect.SelectedIndex == 3) {
        if (ProConnected()) return "pro";
        if (modeSelect.SelectedIndex == 3) return null;
      }
      if (modeSelect.SelectedIndex != 2) {
        try { Run("link --quick --address"); return "quick"; } catch {}
      }
      if (modeSelect.SelectedIndex != 1) {
        try { Run("link --fixed --address"); return "fixed"; } catch {}
      }
      return null;
    }
    private void RefreshStatus() {
      if (refreshing || settingUpPro) return;
      refreshing = true;
      try {
        var mode = CurrentMode();
        if (mode == "pro") { status.Text = T("● Pro 固定链接已就绪（链接不会变）", "● Pro fixed link ready (it doesn't change)"); hint.Text = T("把完整链接给 AI 就能控制电脑；这台电脑开机会自动连上。", "Give the full link to your AI; this computer reconnects by itself after a restart."); }
        else if (mode == "quick") { status.Text = T("● 临时隧道已连接", "● Temporary tunnel connected"); hint.Text = T("可以复制完整链接，也可以分别复制地址和密钥。", "You can copy the full link, or copy the address and key separately."); }
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
        var option = part == "address" ? " --address" : part == "key" ? " --key" : (mode == "pro" ? " --link" : " --show");
        var value = Run((mode == "pro" ? "pro" : "link --" + mode) + option);
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
        var psi = new ProcessStartInfo(node, args) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true, StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8, WorkingDirectory = root };
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
            ours = cmd.IndexOf(Path.Combine(root, "app", "bin", "wanji.mjs"), StringComparison.OrdinalIgnoreCase) >= 0 && cmd.Contains(" quick ");
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
        form.Controls.Add(new Label { Text = T("打开手机上的 万机，点“扫码连接”。\n这个二维码等于所有电脑的钥匙，不要给别人看。", "Open Wanji on your phone and tap “Scan to connect”.\nThis QR code is the key to all your computers; don’t show it to anyone."), Location = new Point(20, 405), Size = new Size(400, 50), TextAlign = ContentAlignment.MiddleCenter });
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
    private void StartCliTask(string args, string title, Action done = null, string successText = null, Action<string> onLine = null) {
      var psi = new ProcessStartInfo(node, Q(cli) + " " + args) {
        UseShellExecute = false, CreateNoWindow = true,
        RedirectStandardOutput = true, RedirectStandardError = true, WorkingDirectory = root,
        StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8
      };
      var process = new Process { StartInfo = psi };
      var output = new StringBuilder();
      var errors = new StringBuilder();
      process.OutputDataReceived += (s, e) => {
        if (e.Data == null) return;
        lock (output) output.AppendLine(e.Data);
        if (onLine != null) try { if (!IsDisposed && IsHandleCreated) BeginInvoke(onLine, e.Data); } catch (InvalidOperationException) { }
      };
      process.ErrorDataReceived += (s, e) => { if (e.Data != null) lock (errors) errors.AppendLine(e.Data); };
      try {
        if (!process.Start()) throw new Exception(T("无法启动 万机。", "Couldn’t start Wanji."));
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
            if (exitCode == 0 && successText != null) result = successText;
            MessageBox.Show(this, string.IsNullOrWhiteSpace(result) ? (exitCode == 0 ? T("操作已完成。", "Done.") : T("操作失败，未提供错误信息。", "Failed, and no error message was given.")) : result,
              title + (exitCode == 0 ? T("成功", "\u0020succeeded") : T("失败", "\u0020failed")), MessageBoxButtons.OK,
              exitCode == 0 ? MessageBoxIcon.Information : MessageBoxIcon.Error);
            RefreshStatus();
            if (done != null) done();
          }));
        } catch (InvalidOperationException) { /* The user closed this window. */ }
      });
    }
    // Reads the plan off the UI thread: with a saved key the CLI may ask the license server.
    private void LoadPlan() {
      System.Threading.ThreadPool.QueueUserWorkItem(_ => {
        string found = null, expires = null;
        bool connected = false;
        try {
          var json = Run("license --json", 15000);
          var m = Regex.Match(json, "\"plan\"\\s*:\\s*\"(free|pro)\"");
          if (m.Success) found = m.Groups[1].Value;
          var e = Regex.Match(json, "\"expiresAt\"\\s*:\\s*\"([^\"]+)\"");
          if (e.Success) { DateTime d; expires = DateTime.TryParse(e.Groups[1].Value, out d) ? d.ToLocalTime().ToString("yyyy-MM-dd") : e.Groups[1].Value; }
          if (found == "pro") connected = ProConnected();
        } catch {}
        try {
          if (!IsDisposed && IsHandleCreated) BeginInvoke((Action)(() => {
            plan = found; planExpires = expires; proConnected = connected;
            planButton.Text = found == "pro" ? T("Pro · 到期 ", "Pro · until ") + expires
              : found == "free" ? T("免费版 · 查看权限", "Free · see what's included")
              : T("套餐：查不到，点此重试", "Plan: unknown, click to retry");
            buyLink.Text = found == "pro" ? T("开通 Pro 固定链接 →", "Set up your Pro fixed link →") : T("升级 Pro：开箱即用 · 更多电脑 →", "Upgrade to Pro: works out of the box · more computers →");
            buyLink.Visible = found == "free" || (found == "pro" && !connected);
            planButton.BackColor = found == "pro" ? Color.FromArgb(14, 117, 105) : Color.FromArgb(52, 80, 120);
          }));
        } catch (InvalidOperationException) { /* The user closed this window. */ }
      });
    }
    private void ShowPlan() {
      if (plan == null) { planButton.Text = T("套餐：检查中...", "Plan: checking..."); LoadPlan(); return; }
      string text = plan == "pro"
        ? T("当前套餐：Wanji Pro（到期 " + planExpires + "）" + (proConnected ? "" : "\n还没开通固定链接：关闭本窗口后点主界面的「开通 Pro 固定链接」。") + "\n\n你可以：\n• 一个密钥最多 5 台电脑：在别的电脑装好万机，输入同一个密钥，就会加到同一个固定链接里\n• 用固定远程地址让 AI 直接控制电脑，不用自己搭隧道\n• 用「启动临时连接」或自己的域名，也都可以\n\n到期不续费会回到免费版，这台电脑本身照常能用。",
            "Current plan: Wanji Pro (until " + planExpires + ")\n\nYou can:\n• Up to 5 computers per key: install Wanji on another computer and enter the same key; it joins the same fixed link\n• Let your AI control your computers directly through a fixed remote address, with no tunnel to set up\n• Still use the temporary connection or your own domain\n\nIf it isn't renewed, Wanji goes back to Free; this computer keeps working.")
        : T("当前套餐：免费版\n\n你可以：\n• 控制这台电脑，再加入 1 台（一共 2 台）\n• 点「启动临时连接」生成临时隧道，让 AI 远程连接\n  （链接每次重启都会变，要重新复制给 AI）\n• 固定域名、自建中继：需要你自己的域名或服务器，自行配置\n\n需要 Pro（¥99/月）才能：\n• 加入第 3 台及更多电脑\n• 开箱即用的固定远程地址，AI 直接控制，不用自己搭隧道",
            "Current plan: Free\n\nYou can:\n• Control this computer and join 1 more (2 in total)\n• Click “Start temporary connection” to get a temporary tunnel for remote AI access\n  (the link changes on every restart; give the AI the new one)\n• Fixed domain or your own relay: needs your own domain or server, set up by you\n\nPro (¥99/month) adds:\n• A 3rd computer and more\n• A fixed remote address out of the box: your AI controls your computers directly, no tunnel to set up");
      var form = new Form { Text = T("套餐与权限", "Plan and what's included"), Width = 520, Height = 420, StartPosition = FormStartPosition.CenterParent, FormBorderStyle = FormBorderStyle.FixedDialog, MaximizeBox = false, MinimizeBox = false, Font = Font };
      form.Controls.Add(new Label { Text = text, Location = new Point(20, 18), Size = new Size(470, 290) });
      var keyButton = new Button { Text = plan == "pro" ? T("换一个 Pro 密钥", "Use another Pro key") : T("输入 Pro 密钥", "Enter Pro key"), Location = new Point(20, 320), Size = new Size(150, 34) };
      bool wantKey = false;
      keyButton.Click += (s, e) => { wantKey = true; form.Close(); };
      var buyButton = new Button { Text = T("购买 Pro", "Buy Pro"), Location = new Point(180, 320), Size = new Size(120, 34), Visible = plan != "pro" };
      buyButton.Click += (s, e) => OpenBuyPage();
      var closeButton = new Button { Text = T("关闭", "Close"), Location = new Point(390, 320), Size = new Size(100, 34), DialogResult = DialogResult.OK };
      form.Controls.Add(keyButton); form.Controls.Add(buyButton); form.Controls.Add(closeButton);
      form.AcceptButton = closeButton;
      form.ShowDialog(this);
      if (wantKey) EnterLicenseKey();
    }
    private void OpenBuyPage() {
      try { Process.Start(BuyUrl); }
      catch { Clipboard.SetText(BuyUrl); MessageBox.Show(T("打不开浏览器，购买地址已复制：\n", "Couldn't open a browser; the address was copied:\n") + BuyUrl); }
    }
    private static string ProStep(string line) {
      if (line.StartsWith("Wanji Pro until")) return T("密钥已激活，正在开通 Pro 账号", "Key activated, opening the Pro account");
      if (line.StartsWith("This computer is already on your Pro account")) return T("这台电脑已在 Pro 账号里，正在检查服务", "Already on the Pro account, checking the service");
      if (line.StartsWith("Setting up automatic start")) return T("设置开机自动启动（如果弹出“是否允许更改”，请点“是”）", "Setting up automatic start (if Windows asks to allow changes, click Yes)");
      if (line.StartsWith("Installing the program files")) return T("安装程序文件", "Installing the program files");
      if (line.StartsWith("Installing desktop control...")) return T("准备桌面控制（看屏幕、点鼠标）", "Preparing desktop control");
      if (line.StartsWith("No Python found")) return T("下载 Python（约 15 MB）", "Downloading Python (about 15 MB)");
      if (line.StartsWith("Creating the desktop control environment")) return T("创建桌面控制的运行环境", "Creating the desktop control environment");
      if (line.StartsWith("Installing desktop control packages")) return T("下载桌面控制组件（约 500 MB，最慢的一步）", "Downloading desktop control packages (about 500 MB, the slowest step)");
      if (line.Contains("retrying from")) return T("下载慢，换国内镜像重试", "Slow download, retrying from a mirror");
      if (line.StartsWith("Downloading OCR models")) return T("下载文字识别模型并检查", "Downloading OCR models and checking them");
      if (line.StartsWith("Desktop control is ready")) return T("桌面控制已就绪，正在启动服务", "Desktop control ready, starting the service");
      return null;
    }
    private void EnterLicenseKey() {
      var form = new Form { Text = T("输入 Pro 密钥", "Enter Pro key"), Width = 460, Height = 190, StartPosition = FormStartPosition.CenterParent, FormBorderStyle = FormBorderStyle.FixedDialog, MaximizeBox = false, MinimizeBox = false, Font = Font };
      form.Controls.Add(new Label { Text = T("粘贴卖家发给你的密钥（形如 WANJI-XXXX-XXXX-XXXX-XXXX）：", "Paste the key the seller sent you (like WANJI-XXXX-XXXX-XXXX-XXXX):"), Location = new Point(18, 16), AutoSize = true });
      var box = new TextBox { Location = new Point(20, 46), Width = 405 };
      var ok = new Button { Text = T("激活", "Activate"), Location = new Point(225, 92), Size = new Size(95, 32), DialogResult = DialogResult.OK };
      var cancel = new Button { Text = T("取消", "Cancel"), Location = new Point(330, 92), Size = new Size(95, 32), DialogResult = DialogResult.Cancel };
      form.Controls.Add(box); form.Controls.Add(ok); form.Controls.Add(cancel);
      form.AcceptButton = ok; form.CancelButton = cancel;
      if (form.ShowDialog(this) != DialogResult.OK) return;
      var licenseKey = Regex.Replace(box.Text, @"\s", "");
      if (!Regex.IsMatch(licenseKey, @"^[A-Za-z0-9-]{16,40}$")) { MessageBox.Show(T("密钥格式不对，请从邮件里重新复制。", "That key doesn't look right; copy it again from the email.")); return; }
      ConnectPro(licenseKey);
    }
    // Activates the key (if given), opens the Pro account on the official relay and joins this
    // computer to it. Joining installs desktop control too, which can take a few minutes.
    private void ConnectPro(string licenseKey) {
      planButton.Text = T("套餐：开通中...", "Plan: setting up...");
      hint.Text = T("正在开通 Pro：第一次要下载桌面控制组件（约 500 MB），可能要几分钟，请不要关闭窗口。如果弹出“是否允许更改”，请点“是”。", "Setting up Pro: the first time downloads desktop control (~500 MB) and can take a few minutes. Keep this window open; if Windows asks to allow changes, click Yes.");
      try {
        var args = "pro" + (licenseKey != null ? " " + Q(licenseKey) : "");
        if (!string.IsNullOrWhiteSpace(proxy.Text)) args += " --proxy " + Q(proxy.Text.Trim());
        settingUpPro = true;
        var started = DateTime.Now;
        string step = T("激活密钥", "Activating the key");
        Action show = () => {
          var t = DateTime.Now - started;
          status.Text = T("开通 Pro 中（已用 ", "Setting up Pro (") + (int)t.TotalMinutes + T(" 分 ", " min ") + t.Seconds + T(" 秒）", " s)");
          hint.Text = T("当前：", "Now: ") + step + T("。第一次开通要下载约 500 MB，通常 2 到 5 分钟，请不要关闭窗口。", ". The first setup downloads about 500 MB and usually takes 2 to 5 minutes; keep this window open.");
        };
        var clock = new System.Windows.Forms.Timer { Interval = 1000 };
        clock.Tick += (s, e) => show();
        clock.Start();
        show();
        StartCliTask(args, T("开通 Pro", "Pro setup"), () => {
          clock.Stop(); clock.Dispose();
          settingUpPro = false;
          if (modeSelect.SelectedIndex != 0) modeSelect.SelectedIndex = 0;
          RefreshStatus(); LoadPlan();
        }, T("Pro 已开通。\n\n点主界面的「复制完整链接」，把链接给你的 AI（Claude、ChatGPT 等支持 MCP 的都行），AI 就能控制这台电脑。\n链接不会变；这台电脑开机会自动连上。\n\n链接等于电脑的控制权，不要分享给别人。",
          "Pro is set up.\n\nClick “Copy full link” and give it to your AI (Claude, ChatGPT or any MCP client); it can then control this computer.\nThe link doesn't change, and this computer reconnects by itself after a restart.\n\nThe link is control of your computer; don't share it."),
          line => { var next = ProStep(line); if (next != null) { step = next; show(); } });
      } catch (Exception ex) { settingUpPro = false; MessageBox.Show(ex.Message, T("开通失败", "Pro setup failed")); LoadPlan(); }
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
    // A join file from the main computer (wanji invite --file) waits in the config folder;
    // the service never uses it on its own, so the person confirms here, seeing where it points.
    private void OfferJoinFile() {
      var file = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "computer-mcp", "join.json");
      if (!System.IO.File.Exists(file)) return;
      string origin;
      try {
        var match = Regex.Match(System.IO.File.ReadAllText(file), "\"origin\"\\s*:\\s*\"([^\"]+)\"");
        origin = match.Success ? match.Groups[1].Value : T("（文件里没有主电脑地址）", "(no main computer address in the file)");
      } catch (Exception ex) { origin = ex.Message; }
      if (MessageBox.Show(this, T("发现加入文件：\n" + file + "\n\n主电脑地址：" + origin + "\n\n加入后，主电脑上连接的 AI 可以完全控制这台电脑，包括读取和修改文件。\n只加入你自己的主电脑。现在加入？", "Found a join file:\n" + file + "\n\nMain computer: " + origin + "\n\nAfter joining, the AI connected to the main computer can fully control this computer, including reading and changing files.\nOnly join your own main computer. Join now?"), T("从文件加入主电脑", "Join from file"), MessageBoxButtons.YesNo, MessageBoxIcon.Warning) != DialogResult.Yes) return;
      try {
        var args = "join --file " + Q(file);
        if (!string.IsNullOrWhiteSpace(proxy.Text)) args += " --proxy " + Q(proxy.Text.Trim());
        StartCliTask(args, T("从文件加入主电脑", "Join from file"));
      } catch (Exception ex) { MessageBox.Show(ex.Message, T("加入失败", "Couldn’t join")); }
    }
    private void UseBash() {
      var args = "shell bash";
      if (!string.IsNullOrWhiteSpace(proxy.Text)) args += " --proxy " + Q(proxy.Text.Trim());
      StartCliTask(args, T("切换到 Bash", "Switch to Bash"));
    }
    private void InstallDesktop() {
      var answer = MessageBox.Show(T("完整 OCR / 鼠标键盘控制需要下载约 500 MB，可能要几分钟。\n\n这台电脑没有 Python 3.10–3.13 的话，会自动下载一份只给万机用的 Python，不用你装。需要联网。\n继续？", "Full OCR and mouse/keyboard control download about 500 MB and may take a few minutes.\n\nWithout Python 3.10–3.13 on this computer, a private Python for Wanji is downloaded automatically. It needs internet access.\nContinue?"), T("安装桌面控制", "Install desktop control"), MessageBoxButtons.YesNo, MessageBoxIcon.Question);
      if (answer != DialogResult.Yes) return;
      try {
        var args = "desktop";
        if (!string.IsNullOrWhiteSpace(proxy.Text)) args += " --proxy " + Q(proxy.Text.Trim());
        StartCliTask(args, T("安装桌面控制", "Install desktop control"));
      } catch (Exception ex) { MessageBox.Show(ex.Message, T("安装失败", "Install failed")); }
    }
  }
  static class NoPlaceholder { public static void PlaceholderUnsupported(this TextBox box) { } }
  static class Program {
    [STAThread] static void Main() { Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false); Application.Run(new ManagerForm()); }
  }
}
