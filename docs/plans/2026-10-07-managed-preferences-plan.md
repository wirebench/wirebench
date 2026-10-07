# Managed preferences (#67) — plan

IT locks the proxy, CA bundle and update settings on managed machines with a policy file.

## Design

- **File**: `policy.yaml`, same shape as `preferences.yaml`, read once at startup (a change needs a
  restart). Locations:
  - Windows `%ProgramData%\Wirebench\policy.yaml`
  - macOS `/Library/Application Support/Wirebench/policy.yaml`
  - Linux `/etc/wirebench/policy.yaml`
  - `WIREBENCH_POLICY_FILE` overrides the path only when the app is unpackaged (dev, e2e).
- **Lockable keys** (the issue's three areas, nothing else): `proxy.mode|host|port|username|excludes`,
  `ssl.minVersion|caBundlePath`, `updates.checkOnLaunch`. The proxy password stays the user's (it is
  a keychain reference, never a value). Any other key is ignored and reported.
- **Effect**: every key present in the file is locked. Effective preferences = user document with the
  policy laid over it; `preferences.yaml` keeps only the user's own values, so removing the policy
  gives the user their settings back.
- **Writes**: `PreferencesService.update` refuses a patch touching a locked key
  (`preference-locked`); `ssl.pickCaBundle` / `ssl.clearCaBundle` refuse before any dialog when the
  CA bundle is locked. Reset restores the user's values; locked values stay.
- **CA bundle trust**: a policy CA bundle path is admin-written in a system location, so it is
  recorded as a read pick at startup, like a path main picked itself.
- **Bad file**: unreadable/invalid YAML → no locks, error shown in Preferences and logged. A bad
  field drops that field only (same per-field tolerance as preferences).
- **Renderer**: new `preferences.policy` channel → `{ path, locked[], ignored[], error? }`, fetched
  once. Preferences shows a banner naming the file, and each locked control is disabled with a
  "Locked by policy" marker.

## Tasks

1. Policy loader + locked-key overlay in `PreferencesService` (unit tests).
2. IPC channel, ssl refusals, startup wiring (tests).
3. Renderer: banner + locked controls in Proxy, SSL, Updates (tests).
4. Admin docs page (docs-site guide) + CHANGELOG.
