# Claude Plan Review

A VS Code extension and Claude Code hook that adds an inline plan-review UI for Claude Code sessions running inside the VS Code integrated terminal.

When Claude Code finishes drafting a plan and tries to call `ExitPlanMode`, this opens a webview where you can read the plan, select passages, attach inline comments, and approve, request changes, or cancel. Comments and the action you picked feed back to Claude Code as the hook response, so iteration on the plan happens in the same loop you already use.

## Why

Claude Code already has a plan-review UI inside its first-party VS Code extension. If you instead run Claude Code inside the integrated terminal (no extension, just the CLI), `ExitPlanMode` only gives you a yes/no prompt in the terminal. There's no way to write inline comments or to point at a specific paragraph. This project closes that gap by registering a `PreToolUse` hook that hands off to a local extension which renders the plan in a proper editor surface.

## Features

- Plan rendered as Markdown with VS Code theme colors.
- Click-and-drag text selection inside the plan to attach a comment to that exact passage.
- Click an existing highlight to edit its comment in place.
- Approve, Request Changes, or Cancel. Comments are only forwarded to Claude when you Request Changes.
- Per-VS-Code-window routing, so multiple windows can run reviews concurrently without crossing wires.

## Requirements

- VS Code (any recent version) with the `code` CLI on `PATH`.
- Node.js + npm (for the build).
- Python 3 (used by the hook and the install script).
- Claude Code installed and configured.

## Install

```sh
git clone <repo-url> claude-plan-review
cd claude-plan-review
bash scripts/install.sh
```

The script:

1. Builds the extension (TypeScript and Vite).
2. Packages it with `@vscode/vsce` and installs the VSIX via `code --install-extension`.
3. Copies `hook/review-plan.py` to `~/.claude/hooks/`.
4. Registers a `PreToolUse` matcher for `ExitPlanMode` in `~/.claude/settings.json`. Idempotent, safe to re-run.

After install, run `Developer: Reload Window` in VS Code so the new extension activates.

The extension activates during VS Code startup and contributes the `CLAUDE_PLAN_REVIEW_SOCKET` env var to integrated terminals. If a terminal was opened before activation finished (which is common at startup), it won't have the var and the hook can't reach the extension. VS Code surfaces a banner suggesting to relaunch those terminals; do so and open a fresh terminal. After that, `echo $CLAUDE_PLAN_REVIEW_SOCKET` should print the socket path.

`CLAUDE_HOME` overrides `~/.claude` if you keep your Claude config elsewhere:

```sh
CLAUDE_HOME=/path/to/claude bash scripts/install.sh
```

## Use

1. Open Claude Code in a VS Code integrated terminal.
2. Use plan mode as usual. When Claude tries to exit plan mode, the review panel opens.
3. Read, select, comment. Click `Approve`, `Request Changes`, or `Cancel`.
4. The hook returns the result to Claude, which either proceeds, iterates on the plan with your comments, or waits.

## How it works

A short tour:

1. The extension activates on VS Code startup. It binds a Unix socket at `/tmp/claude-plan-review-<sessionId>.sock` and pushes the path into integrated-terminal env via VS Code's `EnvironmentVariableCollection` API as `CLAUDE_PLAN_REVIEW_SOCKET`.
2. When Claude Code calls `ExitPlanMode`, its `PreToolUse` hook (`hook/review-plan.py`) reads the env var, finds the plan path by grepping the transcript, and connects to the socket.
3. The extension opens a webview panel for that socket connection. The webview is a small React app that handles the selection + comment UX.
4. On submit, the webview posts the comments and the chosen action back to the extension. The extension serializes a JSON response over the socket.
5. The hook reads the response and translates it into the CC hook contract: exit 0 for approve, exit 2 with formatted comments on stderr for request-changes, exit 2 with a wait-for-user message for cancel.

A debug sidecar of every response is also written to `/tmp/plan-review-<sessionId>.json`.

## Tmux in VS Code

The IPC relies on the `CLAUDE_PLAN_REVIEW_SOCKET` env var being inherited by Claude Code when it runs. `tmux` does not pass through new env vars by default. If you run Claude Code inside a tmux session spawned from a VS Code terminal, add this to `~/.tmux.conf`:

```
set-option -ga update-environment "CLAUDE_PLAN_REVIEW_SOCKET"
```

Then reload tmux's config with `tmux source-file ~/.tmux.conf`. Detach + re-attach is not enough on its own, you have to source the file. As a last-resort fallback, `tmux kill-server` forces a clean restart on the next `tmux new`.

Each tmux session captures the env at attach time. New panes inside that session inherit it. Existing panes keep whatever env they had before.

## Known limitations

- Terminals opened before the extension finishes activating won't have the env var injected. VS Code will show a `relaunch terminal` banner. This can happen on any startup, not just on install. See **Install** for the same note in context.
- The hook discovers the plan file by grepping the Claude Code transcript for paths matching `**/.claude/plans/<name>.md`. If your CC setup writes plans elsewhere, the hook silently no-ops and CC falls back to its native prompt.

## Layout

```
extension/        VS Code extension (TypeScript + React + Vite webview)
  src/extension.ts        activation, socket, env var injection
  src/review-panel.ts     panel lifecycle, message handling
  src/webview/            React app (App.tsx, highlight.ts, styles.css, ...)
hook/review-plan.py       PreToolUse hook for ExitPlanMode
scripts/install.sh        build + package + install + settings.json patch
```
