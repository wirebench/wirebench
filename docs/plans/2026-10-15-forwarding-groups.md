# Forwarding groups (#583) — plan

Named sets of forwarding rules, started and stopped together. Owner decisions (issue #583): a group can hold
rules from different hosts, a rule belongs to at most one group, and groups are stored in the project's
`hosts.yaml` next to the rules.

## Shape

```yaml
version: 2
forwardGroups:
  - id: dev
    name: Dev
    rules:
      - { host: bastion, rule: pg }
      - { host: cache-1, rule: redis }
```

- A member names a **resolved** rule: a host id plus a rule id that the host has, either its own rule or one
  inherited from its groups. One rule on a host group yields one rule per host, and each can sit in a different
  forwarding group.
- `forwardGroups` needs `version: 2`, and a version 1 file that lists one is refused. Version 1 files load
  unchanged. The writer puts `version: 2` only when there is at least one group, so a file without groups
  stays readable by older builds. An older build refuses a version 2 file instead of dropping its groups.
- Refused when parsing: group ids used twice (`ssh-forward-group-duplicate-id`), and the same host and rule in
  two groups or twice in one group (`ssh-forward-group-member-twice`). A member whose host or rule is no
  longer in the file is kept. The view shows it as "removed from hosts.yaml" with Remove from group, so
  renaming or deleting a rule never makes the file fail to load.
- Deleting a group keeps its rules; they move to Ungrouped.

## Tasks (one commit each, `WIREBENCH_SKIP_PERF=1 pnpm check` green)

1. **Schema + migration** — `packages/ssh/src/forward-groups.ts` (schema, checks, serialiser),
   `model.ts` (`version: 1 | 2`, optional `forwardGroups`, written version), and `ssh-wire.ts` (wire mirror).
   Unit tests: v1 round-trip, v2 round-trip, v1 with groups refused, duplicates refused, dangling member
   kept, written version.
2. **CLI** — `wirebench ssh forward --group <id>` starts every member, one connection per host. Members
   are started with the same checks as a single-host run. Any failure ends the run with exit 3, as a
   single-host run already does: a script needs one clear exit. `--port` keys become `[host/]rule`. Unit
   and integration tests.
3. **Renderer** — group edits on the hosts file (`forwarding/forward-groups.ts`: create, rename, delete,
   move a rule, remove a member), `startGroup` / `stopGroup` (`Promise.allSettled`, each start through
   `startForward` so prompts work as they do for one rule), the group status line ("2 of 3 running · 1
   failed"), the view as sections (groups, then Ungrouped) with a header menu (Start/Stop, Rename, Delete),
   a "New group…" action and a "Move to group" row submenu. Renderer unit tests.
4. **Palette + docs + e2e** — `ssh.startForwardGroup` / `ssh.stopForwardGroup` ("Start forwarding
   group…", "Stop forwarding group…") with palette modes, regenerated commands docs, the hosts guide and
   CLI reference, CHANGELOG, and an e2e test: a group of two rules on two hosts, Start group, both run,
   Stop group (Docker sshd, headless).

## Not in scope

- Starting a group in main as one call: the renderer already gets per-rule prompts (bind confirm,
  host-key trust) from `startForward`, and a main-side loop would have to bring them back.
- Group auto-start.
