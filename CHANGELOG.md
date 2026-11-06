# Changelog

## 0.6.8 (2026-11-06)

### One-click joiner EXE (`wanji invite --exe`, manager button)
- Permanent by default: the EXE carries a reusable pairing code that adds any number of
  computers and never expires until the main computer revokes it. `--once` (manager:
  "一次性" checkbox) makes a one-use code instead, expiring after `--days` (7, at most 30).
  `wanji invite --list` shows what still works; `wanji invite --cancel [id]` revokes one or
  all (manager button). Joined computers stay; the app removes them one by one. Hub API:
  POST invites `{reusable, days, label}`, GET invites, DELETE invites[/id].
- Running the EXE on a computer already joined to that main computer repairs it (same
  identity, route kept) instead of adding it twice; a key the main computer removed joins afresh.
- `join` runs from the extracted copy and checks first (main computer, used code), so a
  refused run changes nothing; only then it stops an old service and copies node and the app.
- One autostart step (one administrator prompt) instead of two; Chinese messages.
- No Python 3.10-3.13 on the computer: desktop control downloads a private CPython 3.12.10
  (the official NuGet package, SHA-256 pinned, no installer or admin) into the Wanji folder;
  pip retries from the Tsinghua mirror when PyPI fails.
- Joined computers get an entry in Settings > Apps that runs `wanji uninstall --purge`.
- `COMPUTER_MCP_HOME` is written into launcher.vbs; `COMPUTER_MCP_TASK` and
  `COMPUTER_MCP_AUTOSTART=limited` let a test install beside the real service.

## 0.6.7 (2026-11-05)

### Audit fixes
- Relay installer now installs 0.6.7 (0.4.0 never existed on npm); README install matches the released version.
- cloudflared downloads are pinned to 2026.10.7 and SHA-256 checked.
- Handoff token comparison uses a hash, like the main service.
- LAN keeps only the ChaCha20 cipher suite; transfer writes refuse symlinks, junctions and Windows alternate data streams.
- Test fixtures use fake paths and domains; the npm package no longer includes `desktop/__pycache__`.

### Scoped client tokens
- The hub can now issue per-client tokens (`cmcp_...`) that expose only a chosen
  subset of tools, managed through the hub API (`token-tools`, create/update/list/
  delete). The main admin key is unaffected and keeps full access.
- `list_computers` convenience summaries (shared-memory banner, durable-task index)
  now obey the caller's tool scope instead of leaking them to restricted clients.
- `initialize` instructions, memory block, recent-calls hint and durable-task hint
  are only included when the caller's token allows the corresponding tool.

### Durable tasks
- New `task_archive` / `task_unarchive`: archived tasks stop counting toward the
  200-task limit and are hidden from `task_list` unless `include_archived` is true.
  Archiving a task leased by another AI needs its lease token.
- New `task_reopen`: reopen a `done` task as active instead of duplicating it.
- `task_update` accepts `add_step` to append a step (40 max).
- New `task_renew`: extend a lease by 1-60 minutes (default 15) before a long action.
- The router renews a task lease every 5 minutes while a task-linked action runs,
  so a single action longer than the 15-minute lease (bash allows up to 60 minutes)
  no longer loses its lease and its final checkpoint.
- `task_create` now refuses an exact duplicate of a live task's goal and points at
  the existing task instead.
- `task_unarchive` refuses when 200 live tasks already exist, so restoring an
  archived task can no longer push the count past the limit.
- Lease auto-renewal during a task-linked action stops after 65 minutes (bash
  allows at most 60), and a failed renewal is logged instead of swallowed.

### Skills
- New `skill_verify`: record that a skill's requirements were checked on one
  computer, so `skill_list` shows it ready instead of `needs_setup`. It runs and
  installs nothing; the check itself must be done first with the bash tool
  (and `skill_risk` for setup commands) with owner approval. The record lives in
  `skills-state.json` and goes stale when the skill files change.

### Desktop control
- OCR is no longer fatal to `ui_look`: if OCR fails, the call still returns the
  screenshot and the UIA controls, plus an `OCR failed` warning line, and the full
  traceback goes to the helper's stderr log. A failed OCR does not poison the
  screenshot cache, so the next look retries it.
- `_ocr_still_there` (used before acting on an element) also degrades instead of
  throwing: an OCR failure is treated as "cannot confirm", so the element is
  re-located instead of failing the action.

## 0.6.6
- Durable multi-agent tasks and quota-loss recovery: `task_create`, `task_list`,
  `task_get`, `task_claim`, `task_update` with 15-minute exclusive leases, 200-task
  cap, 40 steps, 80 events.

## 0.6.5
- Skill-enabled MCP service: host-scoped skill system (`skill_list`, `skill_load`,
  `skill_read`, `skill_risk`).
