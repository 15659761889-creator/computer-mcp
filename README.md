# 万机

Give any computer its own MCP link, so a model can control it. Requires Node.js >=20. On Windows, Python 3.10-3.13 is needed for desktop control. Bash is optional: without Git for Windows the AI uses PowerShell, and `wanji shell bash` downloads Portable Git (about 60 MB, no administrator rights).

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
| `browser` | The AI's own browser: headless Chromium with its own profile (logins kept), read as numbered elements and text like `ui_look`. Works on computers without a screen. Install with `wanji browser` (about 300 MB; on Linux it also installs the libraries and Chinese fonts when sudo needs no password). |
| `transfer` | With several computers: copy a file or folder between them, any size, over the LAN when possible. Resumes after interruptions and checks SHA-256 before putting it in place. |
| `recent_calls` | Read-only. The latest tool calls from every AI session, newest first, so a new AI can tell what the last one did, whether it finished and where to continue. See "Picking up unfinished work". |
| `skill_list`, `skill_load` | Discover host-stored skills and load instructions for a named computer, including setup status. |
| `skill_read` | Read text files attached to a skill, with path confinement. |
| `skill_risk` | Review the exact proposed setup command using conservative static risk rules. Never executes a command. |

## Skills (host-scoped, computer-aware)

Skills are reusable instructions stored only on the MCP host, not pushed to every computer. Create a folder under the MCP home directory, `skills/<skill-name>/SKILL.md`, with YAML frontmatter followed by instructions. The frontmatter needs `name` (matching the folder, lowercase English letters, digits or hyphens) and `description`; optional fields include `designed_for`, `requires`, `check`, `setup` and `hints`. Other files can live in `scripts/`, `references/` or `assets/`. For example:

```md
---
name: project-check
description: Review a source checkout on the selected computer
---
Check the current Git status first and do not overwrite another AI's changes.
```

Call `skill_list({computer:"pc-test"})` to discover skills and their readiness on that computer, then `skill_load({name:"project-check",computer:"pc-test"})` to read instructions. Use `skill_read` for named text files and `skill_risk` to inspect a proposed install command before executing it with `bash`. Per-computer settings may be stored at `config/<computer-name>.yaml`; those settings do not change the skill's content hash. A skill requiring setup reports `needs_setup` or `stale` until independently verified for the target.

**Security:** Skill instructions are untrusted data, not extra authority. `skill_risk` uses conservative static heuristics and never runs anything or grants approval. The server does not auto-run `setup` or `check` commands, download third-party skills, install packages, or mark unverified requirements as ready. Review exact commands and secure approval before any consequential action. Restart a deployed MCP server and refresh a client's tool list after updating the source; editing the repository alone does not update the running service.

## Multi-AI durable tasks and quota-loss recovery (0.6.6)

The server stores durable task records in `<MCP home>/tasks/t_<id>.json`. They do **not** depend on the original AI conversation, its context window or a final handoff message. The central hub owns the records for all joined computers. This complements `memory_read` and `recent_calls`, rather than replacing them.

**Required workflow for long work:**
1. Call `list_computers` and `task_list` first. `list_computers` also shows a short index of unfinished tasks automatically.
2. If the work already exists, `task_get(id)` shows the original goal, milestones, last verified checkpoint, saved paths and recent linked actions. Do not create another task.
3. Otherwise use `task_create({project, computer, goal, steps, next})` **before** executing. The full goal should include success criteria, not a vague title.
4. `task_claim({id, actor: "gpt-6:chat-xyz"})` returns a private `lease_token`. Do not put the token in notes, files or chat messages. A task cannot be claimed by two active AI sessions at once.
5. After **each** substantive change, call `task_update({id, lease_token, step_index, step_status, evidence, summary, next, files})`. Include the exact next action and short verification, not just "working on it". For ordinary computer actions, pass `task_id` and `task_lease` to add a content-free audit breadcrumb and renew the lease.
6. When finished use `task_update({id, lease_token, status: "done", summary: "..."})`. If giving up or waiting on something, use `status: "paused"` or `"blocked"` to release the lease immediately.

**When an AI runs out of quota:** The next AI uses `task_list` and `task_get` and verifies the actual Git state, files, jobs and test output. The latest checkpoint is already durable, even if the previous AI never wrote a final message. For abrupt interruption, the exclusive lease expires **15 minutes after the last linked action or update**; it is then reclaimable. An unexpired lease is deliberately not bypassable by another AI because the first AI may still be executing. If an action was not linked with `task_id`, it may still be visible in `recent_calls`, but cannot be automatically attributed to a task.

**Boundaries:** This does not record prompts, assistant thoughts, typed passwords, raw command output or conversation transcripts; it stores the user goal and explicit checkpoints. Each record includes revision, recent action names/statuses/timestamps and a hashed lease token. It is a cooperative protocol, not a per-AI identity/security boundary: all MCP clients sharing the same credential can read task records, and the model must voluntarily register/checkpoint work. Task file writes are atomic and guarded by per-task process locks. Back up the MCP home before restoring or moving a hub. Phone task dashboards, notifications and named-agent chat are future additions.

## Shared memory

AI sessions that use this server can leave notes for each other and for you: `memory_read`, `memory_write` and `memory_forget`. The notes live in `memory.jsonl` next to the settings (an append-only log, one event per line), and the server is the only thing the AIs write through.

- **Where an AI learns about it.** The server instructions carry only *your* notes; notes other AIs wrote are shown only by `memory_read`, because many clients treat server instructions almost like a system prompt, and an AI's note may have been planted by a web page that AI read. `list_computers` reports the memory too (a server with one computer answers `list_computers` with that one computer). The tool descriptions tell the AI to call it at the start of every task, because not every client hands server instructions to the model. On a hub, every memory write and delete shows in the phone app's activity feed (without the text).
- **Two kinds of note.** A *fact* has a key and stays true (paths, how a machine is set up, your preferences); writing the same key again replaces it, and only with the `if_rev` of the version the AI read, so two AIs cannot overwrite each other unseen. A *handoff* is what a session leaves when it stops: what was done, what is left. Handoffs older than 60 days are dropped when the file is compacted.
- **Notes are data, not instructions.** Everything an AI is shown is wrapped in a line saying so, one note per line, with its author and date, and invisible or direction-changing characters are stripped. Notes never change what an AI is allowed to do: nothing in the server reads the memory to decide a permission.
- **Your notes are locked.** `wanji memory add "text" --key name` saves a note no AI can change or delete. No AI tool has a lock argument, and author names that pose as the owner or the system (`owner`, `admin`, `system`, `主人`…) are refused. Every client holds the same link, so the name an AI gives is only what it says about itself; the server also records the client's user agent and address.
- **Limits.** 1500 characters per note, 60000 in all, 400 notes, 30 writes per minute per author name and 60 per minute for all AIs together (so changing names does not help). Past 20000 characters the digest asks the AI to merge and delete notes; merging and deleting always work when memory is full. Keys, computer names and tags may be in any language (`电脑2`). Text that looks like an MCP link, a password or a key (including this server's own, and Chinese forms such as `密码：…`) is refused; this is a best-effort filter, not a guarantee.
- **Undoing.** `wanji memory authors` shows who has written and from where. `wanji memory revoke <author>` undoes everything that AI wrote, including its replacements and deletes of other notes, and wipes its text from the file; `revoke --all --since <date>` does that for every AI write since then, whatever names they gave, which is the reliable clean-up. Undoing one author never touches anyone else's history. The file keeps a week of history when it is compacted, so writes from the last week can still be undone (under very heavy use, a day, then less); older writes are folded into one line per note. `forget` wipes every version of one note; `purge` keeps only the live notes and ends the history.
- **Shared file.** The owner's CLI and the running service use the same file; changes take a lock file (`memory.jsonl.lock`, taken over after 15 s if a process crashed), and a process notices when another rewrote the file.
- **Memory off.** If the notes file cannot be opened, the server starts without memory.

The phone app can list and manage notes. Per-note push notifications and an approval queue for AI notes are not implemented.

## Project context and state (0.6.4)

`list_computers` now includes `memory.context`: up to eight owner notes, three project status cards, and two recent handoffs, within 6000 serialized characters. `omitted` counts live notes not included; read the rest with `memory_read`. The summary labels notes as background data and never claims the client actually read them. AI-authored notes still do not enter the server's initialization instructions.

Add an optional lowercase `project` id (1–40 letters, digits, dots, underscores or dashes) to facts and handoffs. `memory_read({project: "wanji"})` returns that project's notes plus global owner notes; combine with `computer`, `kind` or `query` to narrow further. Old untagged AI notes are not silently assigned to a project: find them with `query` or read by id. This does not register active sessions or lock files.

Keep one current state card per project as a fact under `project.<project>.status`. If one repository has independent deployments, use distinct project ids. Read the card first, then use its `if_rev` for updates. Historical handoffs stay separate and remain searchable. Example (replace timestamps, revisions and evidence with the actual observed values):

```json
{
  "kind": "fact",
  "key": "project.wanji.status",
  "project": "wanji",
  "author": "codex",
  "text": "Memory context implemented; deployment remains pending.",
  "state": {
    "source": {"status": "changed", "revision": "working-tree-fingerprint", "checked_at": "2026-11-04T15:00:00Z"},
    "tests": {"status": "passed", "revision": "working-tree-fingerprint", "checked_at": "2026-11-04T15:00:00Z", "evidence": "npm test: all selected tests passed"},
    "build": {"status": "not_built"},
    "deployment": {"status": "not_deployed"},
    "next_step": "Build, verify artifacts and arrange the service update."
  }
}
```

- Stages are independent. Source: `unknown`, `clean`, `changed`; tests: `unknown`, `not_run`, `passed`, `failed`; build: `unknown`, `not_built`, `built`, `failed`; deployment: `unknown`, `not_deployed`, `deployed`, `failed`.
- Every missing stage starts at `unknown`. An update that omits a stage retains its old evidence. Supplying a stage replaces that stage completely. Legacy clients that update only the text retain the structured state.
- `passed`, `built` and `deployed` require a source revision, UTC `checked_at` and short evidence. Use a fingerprint covering uncommitted changes when the tree is dirty; a Git commit alone would not identify the tested source.
- Reports are not verified by the memory service. A different current source revision or evidence older than 24 hours causes a recheck warning. Missing revisions or check times also show as unverified. No command runs automatically, and a successful build never implies deployment.
- Text keeps its 1500-character limit. State has an additional 1800-character serialized limit (revision 80, evidence 200 and next step 200); project/state metadata count toward the existing 60000-character global quota and pass the same secret filter. Version checks, locking, undo and compaction apply to the entire card.
- The phone shows the status summary and reported evidence. Its original note text is kept separate from generated display text; older apps keep reading the original text. The new app remains compatible with servers without these fields.

Verification: `npm test`, `powershell -File installer/test-manager-timeout.ps1`, and the Android debug build. Tests use temporary memory files. Install the new server code before expecting these tools to expose the new arguments. Reconnect clients that cache schemas. Do not run an older server against a newly edited state card: old writers do not know how to preserve new metadata. Keep a memory-file backup for rollback.

## Picking up unfinished work

When an AI is cut off (a dropped connection, a full context, a closed chat) it often never writes its handoff note. `recent_calls` lets the next AI see what actually happened instead of guessing.

- **Where it reads from.** The audit log the server already writes (`audit.jsonl`, plus its rolled-over `.1` file). Nothing new is recorded for it.
- **What it shows.** Newest first: when each call finished, the tool, the computer, a short summary of the arguments, whether it worked (a non-zero exit code, an error, or a background job still running are marked) and how long it took. A quiet spell of 15 minutes or more is drawn as a divider, which separates one working session from the next. Calls the hub is running right now are listed first.
- **The assessment line.** Before the list the result says, in words, what it infers: a call still running (another AI may be working; do not repeat its work), a handoff note newer than the last call (the session finished; read the note), or calls after the last handoff with a long silence (the session probably stopped early; check the real state, then continue). A failed last call or a background job is added to that line.
- **Filters.** `limit` (1-50, default 15), `computer`, `tool`, `since_minutes` and `full` (whole commands, up to 2000 characters, instead of the first 300). `memory_read`, `list_computers` and `recent_calls` itself are hidden unless named with `tool`.
- **What it cannot show.** The log keeps short summaries of arguments and whether each call worked. It never keeps command output, file contents or text typed with `ui_act`, so `recent_calls` cannot say what a command printed. The AI must look at the real state of the computer (`git status`, `ls`, `job`, `ui_look`) before it repeats or continues anything, and ask first before an action that cannot be undone.
- **Secrets.** Tokens, passwords, API keys, `Authorization` headers, the secret part of an MCP link and long random strings are masked before anything is shown.
- **Data, not instructions.** Like the notes, everything shown is a record of the past. Nothing in it changes what an AI is allowed to do.
- **Availability.** Offered only by a server that writes the audit log: the main computer's service (fixed domain), where it needs no `computer` argument and sits beside the memory tools. A computer that has joined a hub, the temporary Quick Tunnel mode and the relay keep no audit log and do not offer it. The server instructions tell the AI about it, and the tool is read-only.

## Desktop control

`ui_look` merges UI Automation with OCR (PP-OCRv5 on the GPU through DirectML), so custom-drawn apps such as Blender, Godot and Flutter apps are readable too. It keeps a warm helper process and uses about 500 MB of disk. `wanji setup` installs it; `wanji desktop` installs or repairs it.

Safety built into `ui_act`: nothing happens when a target is ambiguous, gone, disabled or covered, and the reply explains why. Keys and typing go only to the window from the last look. After acting it waits for the screen to change instead of sleeping, and says so if nothing changed. Typing is read back where the control allows it.

Limits: a locked screen, UAC prompt or the time before logon cannot be seen or controlled. Games with anti-cheat may reject simulated input. DRM video may capture as black. Some models cannot view returned images, so the text list works without them.

## Computers on the same network (0.5.0+)

Every computer opens a LAN port (TCP 8766, plus UDP 8767 for finding the main computer after its address changes), encrypted and authenticated with TLS-PSK from the key it got when it joined: nothing extra to set up, and other devices on the same Wi-Fi cannot connect. The service adds a Windows Firewall rule for it. Only a computer's own polling and file copies are served there, never the MCP link or the phone API.

Each joined computer has a route, set in the phone app or with `wanji route <name> auto|lan|public` on the main computer (`wanji route auto|lan|public` on the joined one):

- `auto` (default): talk to the main computer and copy files over the LAN when it answers, otherwise over the internet, and keep checking for the LAN.
- `lan`: never send work or files over the internet. When the LAN does not work the computer shows as offline with the reason, and transfers fail with it. It still asks over the internet whether its route changed, so it can be switched back.
- `public`: never use the LAN.

`transfer` copies between any two computers. Over the LAN the receiver pulls straight from the sender; over the internet the data passes through the main computer in 8 MB pieces. A chosen route that cannot work is an error, never a silent switch; `auto` says when it fell back. The copy is written to `<to_path>.cmcp-part` and resumes from there after a restart or a dropped connection, and replaces nothing until every file matches the source's SHA-256. Links are skipped. `config.json` `"lan": false` keeps the LAN port closed, `"lanPort"` moves it.

## Linux

The same package runs on Linux as a joined computer or a relay: shell (bash), files, jobs, `browser` and `transfer`; `ui_look` and `ui_act` are Windows-only. `wanji join` (or `wanji autostart`) installs a systemd user service with lingering, so it starts at boot. Inside WSL it also puts a small hidden script in the Windows Startup folder that keeps the distro running from logon, because WSL stops a distro when no Windows program uses it. `wanji autostart off` removes both.

The phone app's browser takeover works on the AI's own browser too: on a computer without a desktop it shows that browser straight away, and on Windows its tabs are listed as "AI 浏览器" next to the desktop's browser windows. When the AI asks for a takeover while it is using its own browser, that is the one the owner gets. While the owner is on it, `ui_act` and `browser` on that computer wait.

## Administrator rights

`setup` asks Windows for elevation once and registers a logon task that runs at the highest level with no further prompts, so windows running as administrator can be controlled too. Anything the model starts is then elevated as well; use `as_user` for programs that misbehave that way. To run without administrator rights, use `wanji setup <name> --limited`.

## Temporary tunnel (no Cloudflare account or domain)

On the computer **to be controlled**, install the package and start a one-time session:

```powershell
npm install -g @zhuangzihan/wanji
wanji quick --name pc2 --copy
```

For a local source checkout, run `node .\bin\wanji.mjs quick --name pc2`, or install a local archive built by `npm pack` using `npm install -g .\zhuangzihan-wanji-<version>.tgz`.

The first run locates or downloads the `cloudflared` binary, starts an MCP HTTP server on loopback (default port 8765), and opens a Cloudflare Quick Tunnel. With `--copy`, it copies the full connection URL (like `https://random-words.trycloudflare.com/t/<secret>/mcp`) directly to the clipboard. Without `--copy`, it prints the hostname and lets you retrieve the full URL later via `wanji link --quick`, keeping the secret out of ordinary service logs. **The entire URL is a password**: keep it private. Paste it into your MCP client's remote server URL configuration. The client must support remote HTTP MCP connections.

- No Cloudflare login, account, DNS or domain is needed.
- Keep the terminal open while connected; Ctrl+C closes the session.
- Every new session has a new random hostname **and** secret. Update your MCP client with the new URL.
- The URL is publicly reachable to anyone who knows it; the random secret is checked on every request.
- Cloudflare Quick Tunnels are for development/testing, have no uptime guarantee and **do not support SSE**. This mode uses JSON replies instead; for long tasks use `bash` with `background: true` and check its logs. Client/edge timeouts may still affect long calls.
- For proxies, add `--proxy http://127.0.0.1:7890`. For a preinstalled binary, use `--cloudflared C:\path\cloudflared.exe`.
- The temporary command does not install a Windows startup task, register DNS, or change fixed-tunnel configuration.

## Fixed named tunnel (existing mode)

For a persistent hostname you control, use `wanji setup <name> --domain example.com`. **You must supply your own Cloudflare-managed domain on first setup; there is no shared or default domain.** This requires Cloudflare credentials with control of the zone. Re-running `setup` can reuse an existing local configuration and its domain. The fixed tunnel has its own persistent token, service manager and CLI commands (`status`, `link`, `rotate`, `update`, `start`, `stop`, `uninstall`).

## Copy the MCP link or secret (both modes)

Open another terminal while the temporary tunnel is running, or after fixed setup:

```powershell
wanji link                     # interactive numbered copy menu
wanji link --copy              # complete MCP link (URL + secret)
wanji link --address --copy    # MCP endpoint URL only
wanji link --key --copy        # secret key only
wanji link --quick             # temporary tunnel if both exist
wanji link --fixed             # fixed-domain tunnel
```

Menu options: **1. Copy full link; 2. Copy address; 3. Copy key; 4. Show details; 0. Exit.** For scripts/non-interactive use, `wanji link --show` prints the full link. `wanji quick --copy` copies the combined temporary link as soon as that tunnel is ready.

Two connection styles are supported:

- **Combined, simplest:** use `https://your-host/t/<secret>/mcp` as the complete server URL and choose no separate authentication.
- **Separate, for clients with HTTP Bearer support:** use `https://your-host/mcp` as the MCP server URL and enter `<secret>` as the **Bearer token**.

For temporary tunnels, both hostname and secret change on restart. Fixed-domain setup requires the user's **own** Cloudflare-managed domain, and its connection remains the same until rotated. Both complete links and secret keys are passwords; do not publish them.

## Windows EXE installer (no Node.js prerequisite)

For non-developers on **64-bit Windows 10/11**, install `Wanji-Setup-<version>-Windows-x64.exe`, then open **万机** from the Start menu.

- The EXE installer bundles **Node.js**, **cloudflared** and the MCP server. The user does not need to install Node.js or npm.
- Click **启动临时连接** (Start temporary connection). After the connection appears, use **复制完整链接** (copy full URL), **复制 MCP 地址** (copy endpoint URL) or **复制密钥** (copy Bearer token).
- A permanent tunnel requires the user's **own Cloudflare-managed domain**; the manager offers an optional fixed-domain setup.
- The installer is **per-user**; it does not intentionally stop, restart, or overwrite existing MCP tunnels. On the first connection, the user must approve remote-control access.
- For `ui_look` and `ui_act`, click **安装桌面控制 / OCR** (Install desktop controls/OCR). This optional step downloads Python 3.12 via `winget` if necessary, plus Python packages and OCR models. A working Internet connection, available Windows package manager, and several hundred MB of disk space may be needed. Until installed, file and shell tools still work.
- The AI's default shell is a choice: the installer has an optional "download Bash" box, and the manager has two buttons, PowerShell or download-and-use Bash. The command line equivalent is `wanji shell powershell|bash|auto`. Without Bash, the `bash` tool runs Windows PowerShell.
- This build depends on Windows .NET Framework 4.x, which is included/enabled on typical Windows 10/11 systems.
- This EXE is currently **unsigned**. Windows SmartScreen may warn when it is first used; for public distribution, a proper publisher code-signing certificate is recommended.
- Be careful with the MCP URL and secret. They authorize access to the computer; never share them publicly.

### Build the EXE installer

On a Windows development machine with .NET Framework C# compiler, Inno Setup 6, a trusted Node.js runtime and a trusted cloudflared executable:

```powershell
powershell -ExecutionPolicy Bypass -File installer\build-windows.ps1 -CloudflaredExe 'C:\path\to\cloudflared.exe'
```

`-NodeExe` and `-InnoCompiler` are optional; the script looks for `node.exe` and `ISCC.exe` itself. The script only builds the version named inside it, and stops if that does not match `package.json`.

The result is written to `dist\Wanji-Setup-<version>-Windows-x64.exe`, and the script prints its size and SHA-256 hash. License notices for bundled Node.js and cloudflared are in `installer\` and packed under `licenses\`.

## Temporary browser takeover (phone browser, no account)

When AI hits CAPTCHA, QR login, or a verification page in an already-running Chrome / Edge / Firefox browser, the human can temporarily operate that same PC browser window from any phone browser.

### One-click launcher (Windows source checkout)

Double-click the Desktop shortcut 万机-手机接管浏览器.cmd, or run this from the checkout folder:

    node .\bin\human-takeover.mjs

A private URL is printed. Open it on your phone; no App, VPS, Cloudflare account, login, or separate MCP client is needed. You can tap, swipe-scroll, drag CAPTCHA sliders, and type into the existing browser. Tap **验证完成 · 交还给 AI** when done, then tell ChatGPT to continue. The temporary link is valid for up to 15 minutes, expires after 5 minutes of inactivity, and the launcher automatically stops its own tunnel after completion/expiry. Ctrl+C stops it earlier. Keep it private.

An AI already connected to the old 万机 can launch this helper with its bash tool without restarting the existing tunnel. **Important:** because it is a separate temporary instance, the old MCP's UI lock is not shared; the AI should refrain from any ui_act while the human is controlling the browser. Running the updated MCP service natively instead exposes request_human_takeover, check_human_takeover, and cancel_human_takeover tools and enforces its own UI lock.

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

Tests use a local MCP server and simulated tunnel output. No external Cloudflare resource is provisioned unless you actually run `wanji quick` or `setup`.

## License

PolyForm Noncommercial 1.0.0 — free for personal, research, study, hobby and
non-profit use; commercial use needs the author's permission. See `LICENSE`.
Copyright (c) 2026 zhuangzihan.
