# Computer MCP

Give any computer its own MCP link, so a model can control it. Requires Node.js >=20. On Windows, also install Git for Windows for Bash, and Python 3.10-3.13 for desktop control.

## Tools

| Tool | What it does |
|---|---|
| `bash` | Run a command (Git Bash or PowerShell). Output and exit code are saved, so a dropped connection loses nothing. `as_user` runs without administrator rights. |
| `job` | List jobs, fetch a result, or kill a job and its child processes. |
| `read_file` | Read text with line numbers (UTF-8, UTF-16, GBK), or view an image. |
| `write_file` | Create or overwrite a file, atomically. |
| `edit_file` | Replace exact text, keeping encoding and line endings. Refuses if the match is not unique. |
| `ui_look` | Windows only. Windows, controls and on-screen text as a numbered list with coordinates, plus a screenshot when needed. |
| `ui_act` | Windows only. Click, type, press keys, scroll, drag and manage windows by id, text or coordinates, then return the new state. |

## Desktop control

`ui_look` merges UI Automation with OCR (PP-OCRv5 on the GPU through DirectML), so custom-drawn apps such as Blender, Godot and Flutter apps are readable too. It keeps a warm helper process and uses about 500 MB of disk. `computer-mcp setup` installs it; `computer-mcp desktop` installs or repairs it.

Safety built into `ui_act`: nothing happens when a target is ambiguous, gone, disabled or covered, and the reply explains why. Keys and typing go only to the window from the last look. After acting it waits for the screen to change instead of sleeping, and says so if nothing changed. Typing is read back where the control allows it.

Limits: a locked screen, UAC prompt or the time before logon cannot be seen or controlled. Games with anti-cheat may reject simulated input. DRM video may capture as black. Some models cannot view returned images, so the text list works without them.

## Administrator rights

`setup` asks Windows for elevation once and registers a logon task that runs at the highest level with no further prompts, so windows running as administrator can be controlled too. Anything the model starts is then elevated as well; use `as_user` for programs that misbehave that way. To run without administrator rights, use `computer-mcp setup <name> --limited`.

## Temporary tunnel (no Cloudflare account or domain)

On the computer **to be controlled**, install the package and start a one-time session:

```powershell
npm install -g @zhuangzihan/computer-mcp
computer-mcp quick --name pc2 --copy
```

For a local source checkout, run `node .\bin\computer-mcp.mjs quick --name pc2`, or install a local archive using `npm install -g .\zhuangzihan-computer-mcp-0.3.0.tgz`.

The first run locates or downloads the `cloudflared` binary, starts an MCP HTTP server on loopback (default port 8765), and opens a Cloudflare Quick Tunnel. With `--copy`, it copies the full connection URL (like `https://random-words.trycloudflare.com/t/<secret>/mcp`) directly to the clipboard. Without `--copy`, it prints the hostname and lets you retrieve the full URL later via `computer-mcp link --quick`, keeping the secret out of ordinary service logs. **The entire URL is a password**: keep it private. Paste it into your MCP client's remote server URL configuration. The client must support remote HTTP MCP connections.

- No Cloudflare login, account, DNS or domain is needed.
- Keep the terminal open while connected; Ctrl+C closes the session.
- Every new session has a new random hostname **and** secret. Update your MCP client with the new URL.
- The URL is publicly reachable to anyone who knows it; the random secret is checked on every request.
- Cloudflare Quick Tunnels are for development/testing, have no uptime guarantee and **do not support SSE**. This mode uses JSON replies instead; for long tasks use `bash` with `background: true` and check its logs. Client/edge timeouts may still affect long calls.
- For proxies, add `--proxy http://127.0.0.1:7890`. For a preinstalled binary, use `--cloudflared C:\path\cloudflared.exe`.
- The temporary command does not install a Windows startup task, register DNS, or change fixed-tunnel configuration.

## Fixed named tunnel (existing mode)

For a persistent hostname you control, use `computer-mcp setup <name> --domain example.com`. **You must supply your own Cloudflare-managed domain on first setup; there is no shared or default domain.** This requires Cloudflare credentials with control of the zone. Re-running `setup` can reuse an existing local configuration and its domain. The fixed tunnel has its own persistent token, service manager and CLI commands (`status`, `link`, `rotate`, `update`, `start`, `stop`, `uninstall`).

## Copy the MCP link or secret (both modes)

Open another terminal while the temporary tunnel is running, or after fixed setup:

```powershell
computer-mcp link                     # interactive numbered copy menu
computer-mcp link --copy              # complete MCP link (URL + secret)
computer-mcp link --address --copy    # MCP endpoint URL only
computer-mcp link --key --copy        # secret key only
computer-mcp link --quick             # temporary tunnel if both exist
computer-mcp link --fixed             # fixed-domain tunnel
```

Menu options: **1. Copy full link; 2. Copy address; 3. Copy key; 4. Show details; 0. Exit.** For scripts/non-interactive use, `computer-mcp link --show` prints the full link. `computer-mcp quick --copy` copies the combined temporary link as soon as that tunnel is ready.

Two connection styles are supported:

- **Combined, simplest:** use `https://your-host/t/<secret>/mcp` as the complete server URL and choose no separate authentication.
- **Separate, for clients with HTTP Bearer support:** use `https://your-host/mcp` as the MCP server URL and enter `<secret>` as the **Bearer token**.

For temporary tunnels, both hostname and secret change on restart. Fixed-domain setup requires the user's **own** Cloudflare-managed domain, and its connection remains the same until rotated. Both complete links and secret keys are passwords; do not publish them.

## Windows EXE installer (no Node.js prerequisite)

For non-developers on **64-bit Windows 10/11**, install `ComputerMCP-Setup-0.3.0-x64.exe`, then open **Computer MCP** from the Start menu.

- The EXE installer bundles **Node.js**, **cloudflared** and the MCP server. The user does not need to install Node.js or npm.
- Click **启动临时连接** (Start temporary connection). After the connection appears, use **复制完整链接** (copy full URL), **复制 MCP 地址** (copy endpoint URL) or **复制密钥** (copy Bearer token).
- A permanent tunnel requires the user's **own Cloudflare-managed domain**; the manager offers an optional fixed-domain setup.
- The installer is **per-user**; it does not intentionally stop, restart, or overwrite existing MCP tunnels. On the first connection, the user must approve remote-control access.
- For `ui_look` and `ui_act`, click **安装桌面控制 / OCR** (Install desktop controls/OCR). This optional step downloads Python 3.12 via `winget` if necessary, plus Python packages and OCR models. A working Internet connection, available Windows package manager, and several hundred MB of disk space may be needed. Until installed, file and shell tools still work.
- If Git for Windows is not installed, the `bash` tool automatically uses Windows PowerShell for commands without an explicitly selected shell.
- This build depends on Windows .NET Framework 4.x, which is included/enabled on typical Windows 10/11 systems.
- This EXE is currently **unsigned**. Windows SmartScreen may warn when it is first used; for public distribution, a proper publisher code-signing certificate is recommended.
- Be careful with the MCP URL and secret. They authorize access to the computer; never share them publicly.

### Build the EXE installer

On a Windows development machine with .NET Framework C# compiler, Inno Setup 6, a trusted Node.js runtime and a trusted cloudflared executable:

```powershell
powershell -ExecutionPolicy Bypass -File installer\build.ps1 -CloudflaredPath 'C:\path\to\cloudflared.exe'
```

The result is written to `build\windows\dist\ComputerMCP-Setup-0.3.0-x64.exe` with a SHA-256 hash. License notices for bundled Node.js and cloudflared are in `installer\` and packed under `licenses\`.

## Temporary browser takeover (phone browser, no account)

When AI hits CAPTCHA, QR login, or a verification page in an already-running Chrome / Edge / Firefox browser, the human can temporarily operate that same PC browser window from any phone browser.

### One-click launcher (Windows source checkout)

Double-click the Desktop shortcut ComputerMCP-手机接管浏览器.cmd, or run:

    node C:\Users\30323\ComputerMCP\bin\human-takeover.mjs

A private URL is printed. Open it on your phone; no App, VPS, Cloudflare account, login, or separate MCP client is needed. You can tap, swipe-scroll, drag CAPTCHA sliders, and type into the existing browser. Tap **验证完成 · 交还给 AI** when done, then tell ChatGPT to continue. The temporary link is valid for up to 15 minutes, expires after 5 minutes of inactivity, and the launcher automatically stops its own tunnel after completion/expiry. Ctrl+C stops it earlier. Keep it private.

An AI already connected to the old Computer MCP can launch this helper with its bash tool without restarting the existing tunnel. **Important:** because it is a separate temporary instance, the old MCP's UI lock is not shared; the AI should refrain from any ui_act while the human is controlling the browser. Running the updated MCP service natively instead exposes request_human_takeover, check_human_takeover, and cancel_human_takeover tools and enforces its own UI lock.

In the updated MCP service, the AI can call request_human_takeover directly; it returns a short-lived phone link (the URL fragment holds a separate handoff key, not the full MCP key). When the human finishes, call check_human_takeover to verify complete, then refresh the screen with ui_look before resuming.

**Security and limits:** The link allows remote browser mouse/keyboard input and reveals that browser's visible contents. Share it only with the intended person. Only browser windows are selectable, and clicks are constrained to the selected browser's visible area. Locked screens / UAC prompts cannot be controlled. Phone images update roughly once per second rather than streaming video. Quick Tunnels are best-effort and may disconnect. Current browser-session control is not a fully isolated remote desktop, is not suitable for production multi-user deployments, and cannot lock other independently running MCP server instances.

Local validation: run node live-tests/handoff-smoke.mjs to test an isolated MCP server, a real browser JPEG frame, authorization, and end-of-session revocation. This does not click the user's browser.


## Public AI message pool (0.4.3)

A primary Computer MCP hub now hosts one durable public message pool for AI sessions across computers. Models can join, read new messages, publish requests mentioning a specific session, and publicly acknowledge or decline with a reason. Acknowledging a message does not imply accepting work. The Android app has a read-only **AI 公共聊天池** page that updates while open. See [the pool protocol](docs/PUBLIC_POOL_V01.md) for tool names, storage, identity caveats and the VPS migration path.

## Development

```powershell
npm test
npm pack
```

`npm test` does not touch the desktop. These do, on the real screen, so run them only when you can leave the computer alone:

```powershell
node live-tests\controls.mjs        # every ui_act behaviour against a test window, scored by its own event log
node live-tests\accept.mjs local    # real programs through the running service; or "public" for the public link
node live-tests\real-model.mjs      # a real model completes a task using only the link (uses Claude quota)
```

Tests use a local MCP server and simulated tunnel output. No external Cloudflare resource is provisioned unless you actually run `computer-mcp quick` or `setup`.
