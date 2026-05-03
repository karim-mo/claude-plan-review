#!/usr/bin/env bash
# Install Claude Plan Review locally:
#   1. npm install + compile extension
#   2. vsce package → claude-plan-review-*.vsix
#   3. code --install-extension <vsix>
#   4. copy hook/review-plan.py to ~/.claude/hooks/
#   5. patch ~/.claude/settings.json (idempotent) to register the PreToolUse hook
#
# Idempotent. Running multiple times is safe.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EXT_DIR="$REPO_ROOT/extension"
HOOK_SRC="$REPO_ROOT/hook/review-plan.py"
CLAUDE_DIR="${CLAUDE_HOME:-$HOME/.claude}"
CLAUDE_HOOKS_DIR="$CLAUDE_DIR/hooks"
HOOK_DEST="$CLAUDE_HOOKS_DIR/review-plan.py"
SETTINGS_PATH="$CLAUDE_DIR/settings.json"

say() { printf '==> %s\n' "$*"; }

# --- preflight: required tools ---------------------------------------------
require_cmd() {
	if ! command -v "$1" >/dev/null 2>&1; then
		echo "error: '$1' not found on PATH. $2" >&2
		exit 1
	fi
}

require_cmd node "Install Node.js (e.g. 'apt install nodejs' or https://nodejs.org)."
require_cmd npm "Install npm (usually bundled with Node.js)."
require_cmd python3 "Install Python 3 (e.g. 'apt install python3')."
require_cmd code "Open VS Code once, or enable shell integration so 'code' is on PATH."

# --- 1+2: build + package --------------------------------------------------
say "Building extension in $EXT_DIR"
cd "$EXT_DIR"
npm install --silent
npm run compile

# Clean any old vsix artifacts first so we don't install a stale one
rm -f claude-plan-review-*.vsix

say "Packaging VSIX via @vscode/vsce"
npx --yes @vscode/vsce package --skip-license --allow-missing-repository

VSIX="$(ls -t claude-plan-review-*.vsix 2>/dev/null | head -1)"
if [[ -z "$VSIX" ]]; then
	echo "error: no vsix was produced" >&2
	exit 1
fi
say "Built $VSIX"

# --- 3: install extension --------------------------------------------------
say "Installing extension"
code --install-extension "$EXT_DIR/$VSIX" --force

# --- 4: copy hook ----------------------------------------------------------
say "Deploying hook to $HOOK_DEST"
mkdir -p "$CLAUDE_HOOKS_DIR"
cp "$HOOK_SRC" "$HOOK_DEST"
chmod +x "$HOOK_DEST"

# --- 5: patch settings.json (idempotent) -----------------------------------
say "Registering PreToolUse hook in $SETTINGS_PATH"
SETTINGS_PATH="$SETTINGS_PATH" HOOK_DEST="$HOOK_DEST" python3 <<'PYEOF'
import json
import os
import pathlib

settings_path = pathlib.Path(os.environ["SETTINGS_PATH"])
hook_dest = os.environ["HOOK_DEST"]
command = "python3 {}".format(hook_dest)

settings_path.parent.mkdir(parents=True, exist_ok=True)
if settings_path.exists():
    try:
        data = json.loads(settings_path.read_text() or "{}")
    except json.JSONDecodeError as e:
        print("  error: could not parse existing settings.json:", e)
        raise SystemExit(1)
else:
    data = {}

hooks = data.setdefault("hooks", {})
pre = hooks.setdefault("PreToolUse", [])

# Find existing ExitPlanMode matcher, or create one
target = None
for entry in pre:
    if entry.get("matcher") == "ExitPlanMode":
        target = entry
        break
if target is None:
    target = {"matcher": "ExitPlanMode", "hooks": []}
    pre.append(target)

entry_hooks = target.setdefault("hooks", [])
# Check if our hook is already registered
already = any(
    h.get("type") == "command" and "review-plan.py" in (h.get("command") or "")
    for h in entry_hooks
)

if already:
    print("  already registered, no changes")
else:
    entry_hooks.append({
        "type": "command",
        "command": command,
        "timeout": 86400,
    })
    settings_path.write_text(json.dumps(data, indent=2) + "\n")
    print("  registered hook:", command)
PYEOF

say "Done."
echo
echo "Next steps:"
echo "  - Restart VS Code (or any affected windows) so the extension activates."
echo "  - Open a NEW integrated terminal inside VS Code (the env var is"
echo "    injected at terminal spawn time)."
echo "  - Run Claude Code in that terminal, enter plan mode, call ExitPlanMode."
echo "  - A webview should pop up with the plan and annotation UX."
