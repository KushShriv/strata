#!/bin/sh
# Install the Strata skill for Claude Code by linking it into ~/.claude/skills.
# Usage: ./install.sh [--copy]
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
DEST="${HOME}/.claude/skills/strata"
mkdir -p "${HOME}/.claude/skills"
if [ -e "$DEST" ] || [ -L "$DEST" ]; then
  printf 'Already present: %s (remove it first to reinstall)\n' "$DEST"
  exit 0
fi
if [ "${1:-}" = "--copy" ]; then
  cp -R "$ROOT/skill" "$DEST"
else
  ln -s "$ROOT/skill" "$DEST"
fi
printf 'Installed: %s\n' "$DEST"
command -v python3 >/dev/null 2>&1 || printf 'Note: python3 is required for the digest and pack scripts.\n'
command -v graphify >/dev/null 2>&1 || printf 'Optional: install graphify (pip install graphifyy) for module graphs on larger repos.\n'
printf 'In Claude Code, run: /strata <path-or-github-url> --level all\n'
