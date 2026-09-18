# Working in this repository

## Git identity

- Commits are made as **Mohammed Naami <m.naami@outlook.com>** — never as `Claude <noreply@anthropic.com>`.
- In a Claude Code on the web session, `.claude/hooks/session-start.sh` sets this repository-locally at
  start-up (and turns signing off, since the environment's signing key is registered to the other
  address and would only produce an "Unverified" badge). Do not "fix" that identity back.

## Commit messages

- Do **not** add a `Claude-Session:` trailer to commit messages.
- Do **not** add a `Co-Authored-By:` trailer either.
- The message body is the record of _why_; keep it about the change.

## Pull request descriptions

- No generated-by footer: no "Generated with Claude Code" line, no session link, no bot emoji
  sign-off. The description ends with its last section.
- Same rule as the commit messages above — the text is about the change, not about what wrote it.

## Gates

- `WIREBENCH_SKIP_PERF=1 pnpm check` before every commit; `pnpm test:perf` unskipped before a push.
- e2e needs a build first: `pnpm build && xvfb-run -a pnpm test:e2e` (this container has no display).
- Never state in docs or code which product inspired a feature; `pnpm check:banned-terms` enforces it.
