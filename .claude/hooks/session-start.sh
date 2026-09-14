#!/bin/bash
# SessionStart hook for Claude Code on the web.
#
# The hosted environment asserts its own git identity (`Claude <noreply@anthropic.com>`) with
# `git config --global` at every session start. A repository-local setting outranks a global one,
# so this hook pins the identity commits in this repository are made under, for cloud sessions only.
#
# Signing is switched off for the same reason: the environment's SSH signing key is registered to
# the `noreply@anthropic.com` address, and a commit signed with it but carrying another committer
# email is shown by GitHub as "Unverified" — worse than an unsigned commit, which carries no badge.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-.}"
git config user.name "Mohammed Naami"
git config user.email "m.naami@outlook.com"
git config commit.gpgsign false
