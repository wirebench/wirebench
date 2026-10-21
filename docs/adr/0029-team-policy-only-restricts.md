# ADR-0029: team policy only restricts

Date: 2026-10-21 · Status: accepted · Issue #735 (phase 4 of #184)

## Context

Wirebench's feature switches have three levels (phase 1 spec §4.1, phase 4 spec §3): what the build
composes, what a team's workspace admin sets on Wirebench Server, and what a person sets on their
machine. Precedence is policy, then preference, then the descriptor's default.

Two earlier decisions constrain what a policy may say. ADR-0016 fixed that a project folder can never
grant a capability: a `git pull` must not switch scripts on. Managed preferences lock a setting to a
value an administrator chose, but only for the settings IT needs to control, and a locked value is
refused on update rather than silently overridden.

A policy that could both enable and disable would be a remote switch: a server, or whoever reaches
it, could turn on an experimental protocol or the MCP server on every machine in the workspace,
and a person's own "off" would stop meaning anything. The epic rules out a remote flag service for
that reason.

## Decision

A workspace's feature policy is a list of feature ids that are **off** in that workspace, and nothing
else. Precisely:

- The server stores `disabledFeatures` on the workspace row; the schema has no `enabledFeatures`.
- Resolution treats a policy entry as "off, whatever the preference says". A feature the policy does
  not name is left to the preference and the default. There is no way for a policy to make a
  feature on.
- A preference that says "on" under a policy that says "off" is kept as the person wrote it and has
  no effect; Settings shows the policy as the reason and disables the toggle. Nothing rewrites the
  preferences file.
- The policy reaches a machine only through the workspace's own sync head and `GET /workspaces`,
  for the workspace it belongs to. A local or folder workspace has no policy. No file in the
  project folder is read for one.
- An id the desktop has no descriptor for is ignored, as the engine ignores an unknown switch: a
  policy written for a newer version or for a plugin restricts nothing it cannot name.

## Consequences

- An administrator can forbid scripts, a protocol or the MCP server in a workspace, which is what a
  team policy is for; they cannot roll a feature out. Rolling out stays a per-machine choice
  (Settings) or a build choice (which modules the engine composes).
- The server needs no licence feature for the policy: restricting is free, and a server that cannot
  enable anything is not a flag service.
- Experimental features can only be turned on by the person at the machine, or by the CLI flag or
  variable on a process they start. A team cannot opt its members into one.
- The guarantee composes with ADR-0016: no file that travels with a project, and no server, can add a
  capability to a machine. Every "on" is local and explicit.
