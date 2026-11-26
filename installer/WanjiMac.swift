import Cocoa

class WanjiAppDelegate: NSObject, NSApplicationDelegate {
    var statusItem: NSStatusItem!
    var statusMenuItem: NSMenuItem!
    var window: NSWindow?
    var logView: NSTextView?
    var nameField: NSTextField!
    var domainField: NSTextField!
    var pairCodeField: NSTextField!

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.title = "万机"

        let menu = NSMenu()
        statusMenuItem = NSMenuItem(title: "状态: 检查中...", action: nil, keyEquivalent: "")
        statusMenuItem.isEnabled = false
        menu.addItem(statusMenuItem)
        menu.addItem(NSMenuItem.separator())

        menu.addItem(NSMenuItem(title: "打开控制面板", action: #selector(openWindow), keyEquivalent: "o"))
        menu.addItem(NSMenuItem(title: "启动服务", action: #selector(startService), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "停止服务", action: #selector(stopService), keyEquivalent: ""))
        menu.addItem(NSMenuItem.separator())
        menu.addItem(NSMenuItem(title: "复制 MCP 连接地址", action: #selector(copyLink), keyEquivalent: "c"))
        menu.addItem(NSMenuItem(title: "手机扫码连接 (wanji app)", action: #selector(showAppQR), keyEquivalent: ""))
        menu.addItem(NSMenuItem.separator())
        menu.addItem(NSMenuItem(title: "初始化/检查桌面控制", action: #selector(installDesktop), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "授权辅助功能权限", action: #selector(openAccessibility), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "授权屏幕录制权限", action: #selector(openScreenRecording), keyEquivalent: ""))
        menu.addItem(NSMenuItem.separator())
        menu.addItem(NSMenuItem(title: "退出", action: #selector(quitApp), keyEquivalent: "q"))

        statusItem.menu = menu
        refreshStatus()
        openWindow()
    }

    func resourcePath(_ rel: String) -> String {
        let base = Bundle.main.resourcePath ?? "/Applications/Wanji.app/Contents/Resources"
        return (base as NSString).appendingPathComponent(rel)
    }

    func runWanji(_ args: [String], completion: ((Int32, String) -> Void)? = nil) {
        let node = resourcePath("runtime/node")
        let cli = resourcePath("app/bin/wanji.mjs")
        let useBundled = FileManager.default.isExecutableFile(atPath: node) && FileManager.default.fileExists(atPath: cli)

        DispatchQueue.global(qos: .userInitiated).async {
            let proc = Process()
            if useBundled {
                proc.executableURL = URL(fileURLWithPath: node)
                proc.arguments = [cli] + args
            } else {
                proc.executableURL = URL(fileURLWithPath: "/usr/bin/env")
                proc.arguments = ["wanji"] + args
            }
            var env = ProcessInfo.processInfo.environment
            let extra = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
            env["PATH"] = extra + ":" + (env["PATH"] ?? "")
            proc.environment = env

            let pipe = Pipe()
            proc.standardOutput = pipe
            proc.standardError = pipe
            do {
                try proc.run()
                proc.waitUntilExit()
                let data = pipe.fileHandleForReading.readDataToEndOfFile()
                let out = String(data: data, encoding: .utf8) ?? ""
                DispatchQueue.main.async { completion?(proc.terminationStatus, out) }
            } catch {
                DispatchQueue.main.async { completion?(-1, error.localizedDescription) }
            }
        }
    }

    func appendLog(_ text: String) {
        guard let tv = logView else { return }
        tv.string += text + "\n"
        tv.scrollToEndOfDocument(nil)
    }

    @objc func refreshStatus() {
        // Query the native helper: macOS TCC status is per helper identity, not this app.
        runWanji(["desktop", "--permissions"]) { [weak self] _, output in
            let data = Data(output.utf8)
            let permissions = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            let installed = permissions?["installed"] as? Bool ?? false
            let ax = installed
                ? ((permissions?["accessibility"] as? Bool ?? false) ? "辅助功能: 已授权" : "辅助功能: 未授权")
                : "桌面控制: 未初始化"
            let sc = installed
                ? ((permissions?["screenRecording"] as? Bool ?? false) ? "屏幕录制: 已授权" : "屏幕录制: 未授权")
                : "屏幕录制: 未检查"
            let events = installed
                ? ((permissions?["eventControl"] as? Bool ?? false) ? "输入控制: 已授权" : "输入控制: 未授权")
                : "输入控制: 未检查"
            self?.runWanji(["status"]) { [weak self] code, out in
                let line = code == 0 ? (out.components(separatedBy: "\n").first ?? "运行中") : "未运行"
                self?.statusMenuItem.title = "\(line) | \(ax) | \(sc) | \(events)"
            }
        }
    }

    @objc func openWindow() {
        if window == nil {
            let w = NSWindow(
                contentRect: NSRect(x: 0, y: 0, width: 640, height: 640),
                styleMask: [.titled, .closable, .miniaturizable],
                backing: .buffered,
                defer: false
            )
            w.center()
            w.title = "万机 Wanji (macOS 主电脑)"

            let content = NSView(frame: w.contentView!.bounds)

            let heading = NSTextField(labelWithString: "首次配置向导")
            heading.font = NSFont.boldSystemFont(ofSize: 16)
            heading.frame = NSRect(x: 18, y: 600, width: 580, height: 24)
            content.addSubview(heading)

            let nameLabel = NSTextField(labelWithString: "电脑名称")
            nameLabel.frame = NSRect(x: 18, y: 566, width: 124, height: 24)
            content.addSubview(nameLabel)
            nameField = NSTextField(string: ProcessInfo.processInfo.hostName.lowercased()
                .replacingOccurrences(of: "[^a-z0-9-]+", with: "-", options: .regularExpression)
                .trimmingCharacters(in: CharacterSet(charactersIn: "-")))
            nameField.placeholderString = "例如 macbook-pro"
            nameField.frame = NSRect(x: 150, y: 562, width: 472, height: 28)
            content.addSubview(nameField)

            let domainLabel = NSTextField(labelWithString: "Cloudflare 域名")
            domainLabel.frame = NSRect(x: 18, y: 528, width: 124, height: 24)
            content.addSubview(domainLabel)
            domainField = NSTextField(string: "")
            domainField.placeholderString = "你自己管理的域名，例如 example.com"
            domainField.frame = NSRect(x: 150, y: 524, width: 472, height: 28)
            content.addSubview(domainField)

            let btnSetup = NSButton(title: "设置为主电脑", target: self, action: #selector(setupMainComputer))
            btnSetup.frame = NSRect(x: 150, y: 486, width: 150, height: 30)
            content.addSubview(btnSetup)

            let setupHint = NSTextField(wrappingLabelWithString: "需要你自己的 Cloudflare 域名。首次授权会打开浏览器，请登录并批准域名访问。")
            setupHint.frame = NSRect(x: 18, y: 454, width: 604, height: 28)
            content.addSubview(setupHint)

            let pairLabel = NSTextField(labelWithString: "配对码")
            pairLabel.frame = NSRect(x: 18, y: 420, width: 124, height: 24)
            content.addSubview(pairLabel)
            pairCodeField = NSTextField(string: "")
            pairCodeField.placeholderString = "粘贴主电脑生成的 wanji invite 配对码或邀请链接"
            pairCodeField.frame = NSRect(x: 150, y: 416, width: 472, height: 28)
            content.addSubview(pairCodeField)

            let btnJoin = NSButton(title: "加入已有主电脑", target: self, action: #selector(joinExistingComputer))
            btnJoin.frame = NSRect(x: 150, y: 378, width: 150, height: 30)
            content.addSubview(btnJoin)

            let btnInvite = NSButton(title: "生成加入码并复制", target: self, action: #selector(createPairingCode))
            btnInvite.frame = NSRect(x: 310, y: 378, width: 170, height: 30)
            content.addSubview(btnInvite)

            let logLabel = NSTextField(labelWithString: "运行日志")
            logLabel.frame = NSRect(x: 18, y: 350, width: 580, height: 20)
            content.addSubview(logLabel)

            let scroll = NSScrollView(frame: NSRect(x: 16, y: 60, width: 608, height: 280))
            scroll.hasVerticalScroller = true
            let tv = NSTextView(frame: scroll.bounds)
            tv.isEditable = false
            tv.font = NSFont.monospacedSystemFont(ofSize: 12, weight: .regular)
            tv.string = "欢迎使用 万机 Wanji macOS 版\n选择上面的主电脑设置或加入现有电脑，不需要手动打开终端。\n"
            scroll.documentView = tv
            content.addSubview(scroll)
            logView = tv

            let btnStart = NSButton(title: "启动服务", target: self, action: #selector(startService))
            btnStart.frame = NSRect(x: 16, y: 16, width: 104, height: 32)
            content.addSubview(btnStart)

            let btnStop = NSButton(title: "停止服务", target: self, action: #selector(stopService))
            btnStop.frame = NSRect(x: 126, y: 16, width: 104, height: 32)
            content.addSubview(btnStop)

            let btnDesktop = NSButton(title: "桌面控制", target: self, action: #selector(installDesktop))
            btnDesktop.frame = NSRect(x: 236, y: 16, width: 104, height: 32)
            content.addSubview(btnDesktop)

            let btnPerm = NSButton(title: "权限设置", target: self, action: #selector(openAccessibility))
            btnPerm.frame = NSRect(x: 346, y: 16, width: 104, height: 32)
            content.addSubview(btnPerm)

            let btnCopy = NSButton(title: "复制连接", target: self, action: #selector(copyLink))
            btnCopy.frame = NSRect(x: 456, y: 16, width: 112, height: 32)
            content.addSubview(btnCopy)

            w.contentView = content
            window = w
        }
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    @objc func setupMainComputer() {
        let name = nameField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let domain = domainField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !name.isEmpty, !domain.isEmpty else {
            appendLog("请填写电脑名称和 Cloudflare 域名。")
            return
        }
        appendLog("正在设置主电脑：\(name).\(domain)")
        appendLog("如果这是首次 Cloudflare 授权，浏览器会打开；请完成登录和域名授权。")
        runWanji(["setup", name, "--domain", domain]) { [weak self] code, out in
            self?.appendLog(out.isEmpty ? (code == 0 ? "主电脑设置完成。" : "主电脑设置失败。") : out)
            self?.refreshStatus()
        }
    }

    @objc func joinExistingComputer() {
        let code = pairCodeField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        let name = nameField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !code.isEmpty else {
            appendLog("请粘贴主电脑生成的配对码或邀请链接。")
            return
        }
        var args = ["join", code]
        if !name.isEmpty { args += ["--name", name] }
        appendLog("正在加入现有主电脑...")
        runWanji(args) { [weak self] code, out in
            self?.appendLog(out.isEmpty ? (code == 0 ? "加入完成。" : "加入失败。") : out)
            self?.refreshStatus()
        }
    }

    @objc func createPairingCode() {
        appendLog("正在向主电脑申请一次性加入码...")
        runWanji(["invite", "--json"]) { [weak self] code, out in
            guard code == 0,
                  let data = out.data(using: .utf8),
                  let result = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                  let pair = result["pair"] as? String,
                  !pair.isEmpty else {
                self?.appendLog(out.isEmpty ? "加入码生成失败，请确认主电脑服务已启动。" : out)
                return
            }
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(pair, forType: .string)
            self?.appendLog("加入码已复制到剪贴板（10 分钟有效，仅可使用一次）：")
            self?.appendLog(pair)
            self?.appendLog("在另一台 Mac 的首次配置窗口粘贴此码，然后点击「加入已有主电脑」。")
        }
    }

    @objc func startService() {
        appendLog("正在启动服务...")
        runWanji(["start"]) { [weak self] _, out in
            self?.appendLog(out.isEmpty ? "已启动" : out)
            self?.refreshStatus()
        }
    }

    @objc func stopService() {
        appendLog("正在停止服务...")
        runWanji(["stop"]) { [weak self] _, out in
            self?.appendLog(out.isEmpty ? "已停止" : out)
            self?.refreshStatus()
        }
    }

    @objc func copyLink() {
        runWanji(["link", "--copy"]) { [weak self] _, out in
            self?.appendLog(out.isEmpty ? "已复制 MCP 连接地址" : out)
        }
    }

    @objc func showAppQR() {
        openWindow()
        runWanji(["app"]) { [weak self] _, out in
            self?.appendLog(out)
        }
    }

    @objc func installDesktop() {
        openWindow()
        appendLog("正在检查/编译 macOS 原生桌面控制助手...")
        runWanji(["desktop"]) { [weak self] _, out in
            self?.appendLog(out)
            self?.refreshStatus()
        }
    }

    @objc func openAccessibility() {
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility") {
            NSWorkspace.shared.open(url)
        }
    }

    @objc func openScreenRecording() {
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture") {
            NSWorkspace.shared.open(url)
        }
    }

    @objc func quitApp() {
        NSApp.terminate(nil)
    }
}

let app = NSApplication.shared
let delegate = WanjiAppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
