# Device keys and app lock — plan (#428)

Spec: `docs/specs/2026-10-17-device-keys-and-app-lock-design.md`. One commit per task, each made after
`WIREBENCH_SKIP_PERF=1 pnpm check` passes. One implementation PR, which closes #428.

## T1 — the device key block (`packages/ssh/src/device-key.ts`)

- `encodeDeviceKey`, `parseDeviceKey` (undefined when the text is not a block; `ssh-key-invalid` for a bad one,
  an unknown `v` or an unknown `platform`), `isDeviceKeySecret`.
- `ecdsaSignatureBlob(rawRS)`, `rsaSignatureBlob(sig)`, `sshRsaBlobFromSpki(der)`, `ecdsaBlobFromX963(point)`.
- `keygen.ts`: `describePrivateKey` reads a block (public key and fingerprint); `looksLikeKeySecret` = a private
  key or a block. Exported from `index.ts`.
- Tests: round trip, refusals, signature blobs that verify with node's crypto against the public blob.

## T2 — signing in with a device key (`sk-auth.ts`, `dial.ts`)

- Generalise `SkSigner` to name a key type and a signature algorithm (security keys keep both the same).
- `DialOptions.deviceKeys?: DeviceKeySigner`. A hop whose key is a block signs through it, with the
  `ssh-device-key-unavailable`, `-missing` and `-cancelled` errors, progress lines, and the extra ready time.
  A certificate attached to a device key is refused.
- Errors in `errors.ts` and the desktop error copy.
- Tests: sign-in against the SSH fixture with a software signer (P-256 and RSA, the server accepting
  `rsa-sha2-256`); no signer; a signer that answers missing or cancelled.

## T3 — the macOS helper

- `apps/desktop/native/device-helper/macos/main.swift`: `status`, `create`, `sign`, `unlock` per the spec.
- `scripts/build-device-helper.ts`: on darwin, `swiftc -O` for arm64 and x86_64 (target macOS 13), then `lipo`,
  then an ad-hoc sign, into `apps/desktop/build-resources/device-helper/`. On win32, it copies the `.ps1`. On
  Linux it does nothing.
- Root `package*` scripts run it before electron-builder; it is git-ignored like the other vendored folders.
- A test that runs only on darwin: build, then `status` answers the right shape; when supported, `create` and
  a handle that loads.

## T4 — the Windows helper

- `apps/desktop/native/device-helper/windows/device-helper.ps1`: the same four commands through WinRT
  (`KeyCredentialManager`, `UserConsentVerifier`), with an `Await` helper over `AsTask`.
- A test that runs only on win32: `status` answers `{ supported: boolean }`.

## T5 — main: helper runner and device keys

- `apps/desktop/src/main/device-keys.ts`: `DeviceHelper` (locate, spawn, JSON, time limits, one prompt at a
  time, error mapping) and `DeviceKeys` (`status`, `create(label)` → block text, a `DeviceKeySigner` for dial).
- `ssh-connect.ts` / `ssh-service.ts` / SFTP / forwards: pass `deviceKeys` to dial.
- `ssh-keys.ts`: `generate` with algorithm `device`; `keys()` lists blocks with `device: { platform, here }`.
- Wire: `sshKeyAlgorithmSchema` gains `device`; `SshKeyWire.device`; `ssh.deviceKeyStatus` IPC.
- Tests: the runner against a fake helper script; generate and list; a block from another device listed as
  missing.

## T6 — renderer: Generate key… and the key list

- The Device key choice (enabled from `ssh.deviceKeyStatus`, with the reason when it is not), no passphrase,
  the recovery warning, the default name.
- The badge and the missing state in the key list.
- Tests: component tests for both states, the warning and the badge.

## T7 — app lock

- Preferences: `security.appLock { enabled, idleMinutes }`, a `security` section, defaults, reset.
- `apps/desktop/src/main/app-lock.ts`: the state machine (locked at launch, `ensureUnlocked` sharing one
  prompt, re-lock on idle, screen lock and suspend), with injected clock, idle source and unlock function.
- Gate in the SSH connector's secret getter, and in key install.
- IPC `security.appLockTest` (one `unlock` before the switch turns on).
- Settings: a Security section with the switch and the minutes.
- Tests: the state machine, the gate, the preference, the Settings section.

## T8 — packaging

- `electron-builder.yml`: mac `extraResources` `build-resources/device-helper` → `device-helper`, and in
  `x64ArchFiles`; win `extraResources` for the `.ps1`.
- `release.yml`: build the helper in the mac and win jobs. `scripts/check-device-helper.ts` checks the packed
  app (a universal binary on mac, the script on win).
- Run the desktop build (`pnpm --filter @wirebench/desktop build`) and `electron-builder --mac --dir` here, and
  check that the helper is in the bundle and passes `codesign --verify`.

## T9 — docs

- `docs/security.md`: "Device keys" and "App lock" sections.
- ADR-0027: device keys sign through a shipped helper process (not a native module).
- User docs for keys and the Settings page; CHANGELOG under [Unreleased].
- `docs/manual-tests/2026-10-17-device-keys.md`: the per-platform checklist, with results as they come in.

## Manual checks (one ask to the owner, at the end)

Touch ID and password sign-in, cancel, app lock at the first connect and after idle or screen lock, on this Mac
with a packaged build. Windows Hello on a Windows machine, when one is available.
