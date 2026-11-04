# Computer MCP

Give any computer its own MCP link, so a model can control it. Requires Node.js >=20. On Windows, Python 3.10-3.13 is needed for desktop control. Bash is optional: without Git for Windows the AI uses PowerShell, and `computer-mcp shell bash` downloads Portable Git (about 60 MB, no administrator rights).

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
| `browser` | The AI's own browser: headless Chromium with its own profile (logins kept), read as numbered elements and text like `ui_look`. Works on computers without a screen. Install with `computer-mcp browser` (about 300 MB; on Linux it also installs the libraries and Chinese fonts when sudo needs no password). |
| `transfer` | With several computers: copy a file or folder between them, any size, over the LAN when possible. Resumes after interruptions and checks SHA-256 before putting it in place. |

## Shared memory

AI sessions that use this server can leave notes for each other and for you: `memory_read`, `memory_write` and `memory_forget`. The notes live in `memory.jsonl` next to the settings (an append-only log, one event per line), and the server is the only thing the AIs write through.

- **Where an AI learns about it.** The server instructions carry a digest of the notes, and `list_computers` reports the memory too (a server with one computer answers `list_computers` with that one computer). The tool descriptions tell the AI to call it at the start of every task, because not every client hands server instructions to the model.
- **Two kinds of note.** A *fact* has a key and stays true (paths, how a machine is set up, your preferences); writing the same key again replaces it, and only with the `if_rev` of the version the AI read, so two AIs cannot overwrite each other unseen. A *handoff* is what a session leaves when it stops: what was done, what is left. Handoffs older than 60 days are dropped when the file is compacted.
- **Notes are data, not instructions.** Everything an AI is shown is wrapped in a line saying so, one note per line, with its author and date, and invisible or direction-changing characters are stripped. Notes never change what an AI is allowed to do: nothing in the server reads the memory to decide a permission.
- **Your notes are locked.** `computer-mcp memory add "text" --key name` saves a note no AI can change or delete. No AI tool has a lock argument and the author name `owner` is reserved; the name an AI gives is only what it says about itself (the server also records the client's user agent and address).
- **Limits.** 1500 characters per note, 60000 in all, 400 notes, 30 writes per minute per author. Past 20000 characters the digest asks the AI to merge and delete notes; merging and deleting always work when memory is full. Text that looks like an MCP link, a password or a key (including this server's own) is refused; this is a best-effort filter, not a guarantee.
- **Undoing.** `computer-mcp memory authors` shows who has written; `computer-mcp memory revoke <author>` undoes everything that AI wrote and wipes it from the file. `forget` and `purge` rewrite the file so deleted text does not stay on disk. An AI's own delete only hides the note until the next rewrite.
- **Memory off.** If the notes file cannot be opened, the server starts without memory.

Not built yet: a view of the notes in the phone app, and an approval queue for notes before other AIs can see them.

## Desktop control

`ui_look` merges UI Automation with OCR (PP-OCRv5 on the GPU through DirectML), so custom-drawn apps such as Blender, Godot and Flutter apps are readable too. It keeps a warm helper process and uses about 500 MB of disk. `computer-mcp setup` installs it; `computer-mcp desktop` installs or repairs it.

Safety built into `ui_act`: nothing happens when a target is ambiguous, gone, disabled or covered, and the reply explains why. Keys and typing go only to the window from the last look. After acting it waits for the screen to change instead of sleeping, and says so if nothing changed. Typing is read back where the control allows it.

Limits: a locked screen, UAC prompt or the time before logon cannot be seen or controlled. Games with anti-cheat may reject simulated input. DRM video may capture as black. Some models cannot view returned images, so the text list works without them.

## Computers on the same network (0.5.0+)

Every computer opens a LAN port (TCP 8766, plus UDP 8767 for finding the main computer after its address changes), encrypted and authenticated with TLS-PSK from the key it got when it joined: nothing extra to set up, and other devices on the same Wi-Fi cannot connect. The service adds a Windows Firewall rule for it. Only a computer's own polling and file copies are served there, never the MCP link or the phone API.

Each joined computer has a route, set in the phone app or with `computer-mcp route <name> auto|lan|public` on the main computer (`computer-mcp route auto|lan|public` on the joined one):

- `auto` (default): talk to the main computer and copy files over the LAN when it answers, otherwise over the internet, and keep checking for the LAN.
- `lan`: never send work or files over the internet. When the LAN does not work the computer shows as offline with the reason, and transfers fail with it. It still asks over the internet whether its route changed, so it can be switched back.
- `public`: never use the LAN.

`transfer` copies between any two computers. Over the LAN the receiver pulls straight from the sender; over the internet the data passes through the main computer in 8 MB pieces. A chosen route that cannot work is an error, never a silent switch; `auto` says when it fell back. The copy is written to `<to_path>.cmcp-part` and resumes from there after a restart or a dropped connection, and replaces nothing until every file matches the source's SHA-256. Links are skipped. `config.json` `"lan": false` keeps the LAN port closed, `"lanPort"` moves it.

## Linux

The same package runs on Linux as a joined computer or a relay: shell (bash), files, jobs, `browser` and `transfer`; `ui_look` and `ui_act` are Windows-only. `computer-mcp join` (or `computer-mcp autostart`) installs a systemd user service with lingering, so it starts at boot. Inside WSL it also puts a small hidden script in the Windows Startup folder that keeps the distro running from logon, because WSL stops a distro when no Windows program uses it. `computer-mcp autostart off` removes both.

The phone app's browser takeover works on the AI's own browser too: on a computer without a desktop it shows that browser straight away, and on Windows its tabs are listed as "AI 浏览器" next to the desktop's browser windows. When the AI asks for a takeover while it is using its own browser, that is the one the owner gets. While the owner is on it, `ui_act` and `browser` on that computer wait.

## Administrator rights

`setup` asks Windows for elevation once and registers a logon task that runs at the highest level with no further prompts, so windows running as administrator can be controlled too. Anything the model starts is then elevated as well; use `as_user` for programs that misbehave that way. To run without administrator rights, use `computer-mcp setup <name> --limited`.

## Temporary tunnel (no Cloudflare account or domain)

On the computer **to be controlled**, install the package and start a one-time session:

```powershell
npm install -g @zhuangzihan/computer-mcp
computer-mcp quick --name pc2 --copy
```

For a local source checkout, run `node .\bin\computer-mcp.mjs quick --name pc2`, or install a local archive built by `npm pack` using `npm install -g .\zhuangzihan-computer-mcp-<version>.tgz`.

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

For non-developers on **64-bit Windows 10/11**, install `ComputerMCP-Setup-<version>-Windows-x64.exe`, then open **Computer MCP** from the Start menu.

- The EXE installer bundles **Node.js**, **cloudflared** and the MCP server. The user does not need to install Node.js or npm.
- Click **启动临时连接** (Start temporary connection). After the connection appears, use **复制完整链接** (copy full URL), **复制 MCP 地址** (copy endpoint URL) or **复制密钥** (copy Bearer token).
- A permanent tunnel requires the user's **own Cloudflare-managed domain**; the manager offers an optional fixed-domain setup.
- The installer is **per-user**; it does not intentionally stop, restart, or overwrite existing MCP tunnels. On the first connection, the user must approve remote-control access.
- For `ui_look` and `ui_act`, click **安装桌面控制 / OCR** (Install desktop controls/OCR). This optional step downloads Python 3.12 via `winget` if necessary, plus Python packages and OCR models. A working Internet connection, available Windows package manager, and several hundred MB of disk space may be needed. Until installed, file and shell tools still work.
- The AI's default shell is a choice: the installer has an optional "download Bash" box, and the manager has two buttons, PowerShell or download-and-use Bash. The command line equivalent is `computer-mcp shell powershell|bash|auto`. Without Bash, the `bash` tool runs Windows PowerShell.
- This build depends on Windows .NET Framework 4.x, which is included/enabled on typical Windows 10/11 systems.
- This EXE is currently **unsigned**. Windows SmartScreen may warn when it is first used; for public distribution, a proper publisher code-signing certificate is recommended.
- Be careful with the MCP URL and secret. They authorize access to the computer; never share them publicly.

### Build the EXE installer

On a Windows development machine with .NET Framework C# compiler, Inno Setup 6, a trusted Node.js runtime and a trusted cloudflared executable:

```powershell
powershell -ExecutionPolicy Bypass -File installer\build-windows.ps1 -CloudflaredExe 'C:\path\to\cloudflared.exe'
```

`-NodeExe` and `-InnoCompiler` are optional; the script looks for `node.exe` and `ISCC.exe` itself. The script only builds the version named inside it, and stops if that does not match `package.json`.

The result is written to `dist\ComputerMCP-Setup-<version>-Windows-x64.exe`, and the script prints its size and SHA-256 hash. License notices for bundled Node.js and cloudflared are in `installer\` and packed under `licenses\`.

## Temporary browser takeover (phone browser, no account)

When AI hits CAPTCHA, QR login, or a verification page in an already-running Chrome / Edge / Firefox browser, the human can temporarily operate that same PC browser window from any phone browser.

### One-click launcher (Windows source checkout)

Double-click the Desktop shortcut ComputerMCP-手机接管浏览器.cmd, or run this from the checkout folder:

    node .\bin\human-takeover.mjs

A private URL is printed. Open it on your phone; no App, VPS, Cloudflare account, login, or separate MCP client is needed. You can tap, swipe-scroll, drag CAPTCHA sliders, and type into the existing browser. Tap **验证完成 · 交还给 AI** when done, then tell ChatGPT to continue. The temporary link is valid for up to 15 minutes, expires after 5 minutes of inactivity, and the launcher automatically stops its own tunnel after completion/expiry. Ctrl+C stops it earlier. Keep it private.

An AI already connected to the old Computer MCP can launch this helper with its bash tool without restarting the existing tunnel. **Important:** because it is a separate temporary instance, the old MCP's UI lock is not shared; the AI should refrain from any ui_act while the human is controlling the browser. Running the updated MCP service natively instead exposes request_human_takeover, check_human_takeover, and cancel_human_takeover tools and enforces its own UI lock.

In the updated MCP service, the AI can call request_human_takeover directly; it returns a short-lived phone link (the URL fragment holds a separate handoff key, not the full MCP key). When the human finishes, call check_human_takeover to verify complete, then refresh the screen with ui_look before resuming.

**Security and limits:** The link allows remote browser mouse/keyboard input and reveals that browser's visible contents. Share it only with the intended person. Only browser windows are selectable, and clicks are constrained to the selected browser's visible area. Locked screens / UAC prompts cannot be controlled. Phone images update roughly once per second rather than streaming video. Quick Tunnels are best-effort and may disconnect. Current browser-session control is not a fully isolated remote desktop, is not suitable for production multi-user deployments, and cannot lock other independently running MCP server instances.

Local validation: run node live-tests/handoff-smoke.mjs to test an isolated MCP server, a real browser JPEG frame, authorization, and end-of-session revocation. This does not click the user's browser.


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
