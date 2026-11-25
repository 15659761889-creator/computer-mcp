import Cocoa
import ApplicationServices

class WanjiAppDelegate: NSObject, NSApplicationDelegate {
    var statusItem: NSStatusItem!
    var statusMenuItem: NSMenuItem!
    var window: NSWindow?
    var logView: NSTextView?

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
        let ax = AXIsProcessTrusted() ? "辅助功能: 已授权" : "辅助功能: 未授权"
        let sc = CGPreflightScreenCaptureAccess() ? "屏幕录制: 已授权" : "屏幕录制: 未授权"
        runWanji(["status"]) { [weak self] code, out in
            let line = code == 0 ? (out.components(separatedBy: "\n").first ?? "运行中") : "未运行"
            self?.statusMenuItem.title = "\(line) | \(ax) | \(sc)"
        }
    }

    @objc func openWindow() {
        if window == nil {
            let w = NSWindow(
                contentRect: NSRect(x: 0, y: 0, width: 560, height: 400),
                styleMask: [.titled, .closable, .miniaturizable],
                backing: .buffered,
                defer: false
            )
            w.center()
            w.title = "万机 Wanji (macOS 主电脑)"

            let content = NSView(frame: w.contentView!.bounds)
            let scroll = NSScrollView(frame: NSRect(x: 16, y: 60, width: 528, height: 320))
            scroll.hasVerticalScroller = true
            let tv = NSTextView(frame: scroll.bounds)
            tv.isEditable = false
            tv.font = NSFont.monospacedSystemFont(ofSize: 12, weight: .regular)
            tv.string = "欢迎使用 万机 Wanji macOS 版\n1. 在终端运行 `wanji setup <名称> --domain <域名>` 设为主电脑\n2. 授权「辅助功能」和「屏幕录制」以开启桌面控制\n"
            scroll.documentView = tv
            content.addSubview(scroll)
            logView = tv

            let btnStart = NSButton(title: "启动服务", target: self, action: #selector(startService))
            btnStart.frame = NSRect(x: 16, y: 16, width: 96, height: 32)
            content.addSubview(btnStart)

            let btnStop = NSButton(title: "停止服务", target: self, action: #selector(stopService))
            btnStop.frame = NSRect(x: 120, y: 16, width: 96, height: 32)
            content.addSubview(btnStop)

            let btnDesktop = NSButton(title: "桌面控制", target: self, action: #selector(installDesktop))
            btnDesktop.frame = NSRect(x: 224, y: 16, width: 96, height: 32)
            content.addSubview(btnDesktop)

            let btnPerm = NSButton(title: "权限设置", target: self, action: #selector(openAccessibility))
            btnPerm.frame = NSRect(x: 328, y: 16, width: 96, height: 32)
            content.addSubview(btnPerm)

            let btnCopy = NSButton(title: "复制连接", target: self, action: #selector(copyLink))
            btnCopy.frame = NSRect(x: 432, y: 16, width: 112, height: 32)
            content.addSubview(btnCopy)

            w.contentView = content
            window = w
        }
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
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
