# 万机 for Windows — no Node.js installation required

## Install

1. Download the latest `Wanji-Setup-*-Windows-x64.exe` (e.g. `Wanji-Setup-0.6.4-Windows-x64.exe`) from a trusted source and verify its SHA-256 checksum.
2. Double-click the installer, accept the license, and finish the standard Windows installation.
3. Launch **万机** from the Start menu.
4. Click **启动临时连接 / Start Temporary Connection**. The first connection requires internet access to reach Cloudflare's public Quick Tunnel service.
5. When the status says the temporary tunnel is connected, choose **复制完整链接 / Copy complete link**. Paste the entire URL into an AI client's remote MCP server URL field.
6. Alternatively click **复制 MCP 地址** and **复制密钥** to use separate MCP endpoint + **Bearer Token** fields if the client supports those.
7. This app runs its own bundled Node.js and cloudflared binaries. You do **not** need to install npm, Node.js, Git or cloudflared system-wide for basic connectivity. Without Git for Windows the AI's commands run in PowerShell. To give it Bash, tick the optional box during installation or click the manager's download-and-use Bash button (Portable Git, about 60 MB, from the npmmirror China mirror with GitHub as fallback, checked against its published SHA-256).

## Optional desktop control

The remote MCP server advertises `ui_look` and `ui_act` but full desktop OCR, mouse and keyboard automation require Python 3.10–3.13 and OCR libraries/models. The manager offers an **安装桌面控制 / OCR** button that attempts to install Python 3.12 using Windows Package Manager (winget) if necessary, then runs `wanji desktop`. This is an **online setup** and can download 500 MB or more. If winget is unavailable, install Python 3.12 separately and retry.

## Optional fixed hostname

Users with their **own** Cloudflare-managed domain can enter the domain and click **配置固定域名**. A console will prompt for Cloudflare login and possibly Windows administrator approval. Never enter a domain that belongs to someone else. Fixed mode is optional; Quick Tunnel needs no Cloudflare account.

## Security, updates and limitations

- The URL ending in `/t/<secret>/mcp` is a password giving extensive control over **your computer**. Do not publish it, paste it into public chat, or give it to someone you do not trust.
- The separate connection style uses `https://host/mcp` with `Authorization: Bearer <secret>`. Do not paste the secret into a public screenshot.
- Quick Tunnel addresses and keys change after restart; it is a **test/dev tunnel** without uptime guarantees or SSE. Use a fixed domain for reliable long-running service.
- Closing the manager window does **not** necessarily stop a running temporary tunnel. Use **停止我启动的连接** before closing if you want to end that connection. The stop function checks both PID identity and creation time, then only stops its own process tree.
- Security software and Windows SmartScreen might warn about an unsigned independently built app. Inspect its origin and checksums; this installer has **not** been code-signed with a publisher certificate.
- The installer uses per-user installation under `%LOCALAPPDATA%\Programs\万机`; no system-wide Node.js installation is needed.
- The computer must be logged into an interactive Windows desktop for screen-control features to work. Secure desktop/UAC cannot be controlled by OCR.
- Uninstall from Windows Settings > Installed Apps. Temporary connection processes launched from the manager should be stopped first. If fixed mode was configured, run the bundled CLI `uninstall` command before uninstalling to remove the fixed scheduled task; this does not purge secrets.
- `Wanji.exe` can be launched any time; the bundled console command is `<install folder>\runtime\node.exe <install folder>\app\bin\wanji.mjs`.
- Installer components: Node.js under the terms in `licenses/NODE_LICENSE.txt`, cloudflared under `licenses/CLOUDFLARED_LICENSE.txt`, and 万机 under `licenses/WANJI_LICENSE.txt`.

## Building from source

`installer/build-windows.ps1` compiles the native WinForms manager with the Windows .NET Framework C# compiler, stages the Node runtime and Cloudflare tunnel and invokes Inno Setup 6. This generates `dist/Wanji-Setup-0.6.8-Windows-x64.exe`. It does not publish the installer or npm package.
