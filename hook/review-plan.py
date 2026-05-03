#!/usr/bin/env python3
"""
Claude Code PreToolUse hook for ExitPlanMode. Terminal-based plan review.

Wire-up: registered in ~/.claude/settings.json as a PreToolUse hook
matched on "ExitPlanMode". Spec: /home/karim-mo/my-work/claude-code-extras/spec.md §4.

Flow:
  1. Read the PreToolUse payload from stdin (we need transcript_path).
  2. Read CLAUDE_PLAN_REVIEW_SOCKET from env. If unset, exit 0 silently
     (extension not active in this window, so let CC's native prompt handle).
  3. Grep the transcript for the plan file path. Not found -> exit 0 silently.
  4. Generate a UUID session id.
  5. Connect to the extension's per-window Unix socket. If connect fails
     (extension crashed, stale env), exit 0 silently.
  6. Send {planPath, sessionId} over the socket, newline-terminated.
  7. Block on recv until a newline-terminated JSON response arrives,
     or EOF. EOF without data is treated as cancelled.
  8. Translate response.status to (exit code, stderr):
       approved  -> exit 0, no stdout
       rejected  -> exit 2, stderr = "[Re: \"...\"] ..." lines
       cancelled -> exit 2, stderr = "wait for user" message
"""
import json
import os
import re
import socket
import sys
import uuid

ENV_SOCKET = "CLAUDE_PLAN_REVIEW_SOCKET"

# Matches absolute paths ending in /.claude/plans/<name>.md, bounded by
# whitespace or quotes. Non-greedy segments so we get minimal captures.
PLAN_PATH_REGEX = re.compile(r'/[^"\\\s]+?/\.claude/plans/[^"\\\s]+?\.md')

CANCEL_STDERR = (
    "Reviewer dismissed the review panel without submitting. "
    "Do not modify the plan further. Wait for explicit user instructions "
    "before calling ExitPlanMode again."
)


def find_plan_file(transcript_path):
    try:
        with open(transcript_path, "r", encoding="utf-8", errors="replace") as f:
            content = f.read()
    except OSError:
        return None
    matches = PLAN_PATH_REGEX.findall(content)
    # Most recent occurrence first (spec §4.3)
    for candidate in reversed(matches):
        if os.path.exists(candidate):
            return candidate
    return None


def format_rejected(comments):
    if not comments:
        return CANCEL_STDERR  # degenerate; shouldn't happen
    lines = ["Comments on the plan:"]
    for c in comments:
        # JSON-escape the selection per §9.5. json.dumps wraps in quotes
        # and escapes embedded " and control chars.
        anchor = json.dumps(c.get("selectedText", ""))
        body = (c.get("comment") or "").strip()
        lines.append("[Re: {}] {}".format(anchor, body))
    return "\n".join(lines)


def read_response(sock):
    buf = b""
    while b"\n" not in buf:
        try:
            chunk = sock.recv(8192)
        except OSError:
            return None
        if not chunk:
            break
        buf += chunk
    if not buf:
        return None
    line = buf.split(b"\n", 1)[0]
    try:
        return json.loads(line)
    except json.JSONDecodeError:
        return None


def main():
    # 1. Read stdin JSON
    try:
        payload = json.load(sys.stdin)
    except Exception:
        payload = {}
    transcript_path = payload.get("transcript_path")

    # 2. Env check
    sock_path = os.environ.get(ENV_SOCKET)
    if not sock_path:
        return 0

    # 3. Plan file discovery
    if not transcript_path or not os.path.exists(transcript_path):
        return 0
    plan_path = find_plan_file(transcript_path)
    if not plan_path:
        return 0

    # 4. Session id
    session_id = uuid.uuid4().hex

    # 5. Connect
    try:
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.connect(sock_path)
    except (FileNotFoundError, ConnectionRefusedError):
        return 0

    try:
        with s:
            # 6. Send request
            request = {"planPath": plan_path, "sessionId": session_id}
            try:
                s.sendall((json.dumps(request) + "\n").encode("utf-8"))
            except OSError:
                print(CANCEL_STDERR, file=sys.stderr)
                return 2

            # 7. Read response (blocking)
            response = read_response(s)
    except OSError:
        print(CANCEL_STDERR, file=sys.stderr)
        return 2

    if response is None:
        print(CANCEL_STDERR, file=sys.stderr)
        return 2

    # 8. Branch on status
    status = response.get("status")
    comments = response.get("comments") or []

    if status == "approved":
        return 0
    if status == "rejected":
        print(format_rejected(comments), file=sys.stderr)
        return 2
    # cancelled, or any unrecognized status
    print(CANCEL_STDERR, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
