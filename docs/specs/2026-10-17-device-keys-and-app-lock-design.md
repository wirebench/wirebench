# Device keys and app lock (#428)

Status: accepted 2026-10-17. Builds on: #409 (Generate key… and the keychain's key list), #420 (security keys:
the signer that never holds a private key), ADR-0026 (native code shipped per platform).

## Why

A key made inside the machine's secure hardware cannot be copied off it, and every use needs the person at the
keyboard. People who do not carry a security key ask for this. Some also want Wirebench to ask for the OS
authentication before an SSH secret is used at all.

## Owner rulings (2026-10-17)

| Question                 | Ruling                                                                                                                                                                                                                                                                                                         |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Platforms and key types  | Both, each with its native key type. macOS: Secure Enclave, `ecdsa-sha2-nistp256`, done end to end. Windows: Windows Hello, RSA-2048 (an `ssh-rsa` key that signs `rsa-sha2-256`), behind the same interface, covered by CI and marked experimental until it is checked on a Windows machine. Linux: unsupported, and the app says so. |
| What each use asks for   | Biometrics or the device password/PIN. The key survives fingerprint changes.                                                                                                                                                                                                                                   |
| App lock                 | Off by default. When on, it asks before the first SSH secret is used after launch, and again after N minutes idle (default 15). The rest of the app stays usable while locked.                                                                                                                                  |
| Recovery from a lost key | Generate key… warns that the key cannot be copied or recovered and suggests keeping a second key installed on the same hosts. The docs cover replacing a lost key.                                                                                                                                             |

## Terms

- **Device key**: an SSH key whose private half is made and kept by this machine's secure hardware. Wirebench
  holds only a **handle**, which the hardware can use and nothing else can.
- **Device helper**: a small program shipped with the desktop app that talks to the hardware. It is Swift on
  macOS and a PowerShell script on Windows, and both speak one JSON protocol.

## The handle is the secret's value

A device key is stored like every other key from Generate key…: as a workspace secret named by the host's
`auth: { key: ${secret:NAME} }`. The host model does not change. The value is a text block:

```
-----BEGIN WIREBENCH DEVICE KEY-----
<base64 of one JSON object, wrapped at 64 columns>
-----END WIREBENCH DEVICE KEY-----
```

```json
{
  "v": 1,
  "platform": "macos-secure-enclave",
  "device": "work-laptop",
  "publicKey": "ecdsa-sha2-nistp256 AAAA… user@host",
  "handle": "<base64>"
}
```

- `platform` is `macos-secure-enclave` or `windows-hello`. `device` is the host name the key was made on; it
  is used only in messages.
- `handle`: on macOS, CryptoKit's `dataRepresentation` of the Secure Enclave key. That is a blob wrapped by
  this Mac's enclave and useless anywhere else. On Windows, it is the name of the Windows Hello key credential
  (`wirebench-<uuid>`).
- The public key is in the block, so the keychain can list the key, show its fingerprint and install it on a
  host without asking the hardware.
- The value is not a private key, but it is still stored as a secret. It names the key, and on macOS it is
  the only copy of the wrapped blob.

**Other machines report it as missing.** A team secret or a copied workspace can carry the block to another
machine. There, a block for another platform, or a handle this machine's hardware cannot open, is
`ssh-device-key-missing`: "SSH key NAME lives on another device (made on DEVICE)". The keychain lists the key
in that state.

## Signing in

`packages/ssh` cannot reach the hardware. `DialOptions` gains `deviceKeys?: DeviceKeySigner`:

```ts
interface DeviceKeySigner {
  /** The raw signature over `data`: P-256 r‖s (64 bytes), or an RSA PKCS#1 v1.5 SHA-256 signature. */
  sign(key: DeviceKey, data: Buffer, reason: string): Promise<Buffer>;
}
```

- `dial.ts`: when a hop's key secret is a device key block, the key is offered through the same publickey
  wrapper the security keys use. `sk-auth.ts` is generalised so that a signer names its key type and its
  signature algorithm separately. The SSH signature blob is made here: `ecdsa-sha2-nistp256` with mpint r and
  s, or `rsa-sha2-256` with the RSA signature. The connection screen logs "Confirm with Touch ID or your
  password to sign in with KEY" ("Windows Hello" on Windows).
- `readyTimeout` gets the same extra time a security key's touch gets.
- With no signer (the CLI, the runner, the MCP server) the connect fails with `ssh-device-key-unavailable`:
  "SSH key NAME is a device key; only the Wirebench app can use it". A cancelled prompt is
  `ssh-device-key-cancelled`. The hardware refusing the handle is `ssh-device-key-missing`.
- Certificates (#421) for a device key and agent forwarding of one are out of scope. Both are refused or
  skipped with a message, as they are for security keys.

## The device helper

The helper runs as a child process for each request. It reads one JSON request on stdin, writes one JSON
answer on stdout, and exits with 0 or 1. It never writes a handle or a signature to stderr.

| Command  | Request                          | Answer                                                                          |
| -------- | -------------------------------- | ------------------------------------------------------------------------------- |
| `status` | —                                | `{ "supported": bool, "reason"?: string }`                                      |
| `create` | `{ "label" }`                    | `{ "publicKey": base64, "handle": base64 or name }`                             |
| `check`  | `{ "handle" }`                   | `{ "present": bool }`, asking for nothing                                       |
| `sign`   | `{ "handle", "data", "reason" }` | `{ "signature": base64 }`                                                       |
| `unlock` | `{ "reason" }`                   | `{ "ok": true }`                                                                |
| errors   |                                  | `{ "error": "cancelled" \| "missing" \| "unsupported" \| "failed", "message" }` |

**macOS**: `apps/desktop/native/device-helper/macos/main.swift`, compiled with `swiftc` into one universal
(arm64 + x86_64) binary by `scripts/build-device-helper.ts` and signed with the app.

- `create` makes a `SecureEnclave.P256.Signing.PrivateKey` with access control
  `[.privateKeyUsage, .userPresence]`: Touch ID, or the login password when there is no sensor or the lid is
  shut. The public key it answers is the 65-byte X9.63 point.
- `sign` loads the key from the handle with an `LAContext` whose `localizedReason` is the request's `reason`,
  and answers the raw signature.
- `unlock` is `LAContext.evaluatePolicy(.deviceOwnerAuthentication)`.
- CryptoKit's Secure Enclave keys need no keychain entitlement or provisioning profile. This was checked on
  2026-10-17 with an ad-hoc signed binary.

**Windows**: `apps/desktop/native/device-helper/windows/device-helper.ps1`, run with Windows PowerShell 5.1,
which ships with Windows, as `powershell.exe -NoProfile -NonInteractive -EncodedCommand <script + one call>`.
The request goes in that call as base64 JSON, so no execution policy applies and nothing is read from stdin.

- `status` is `KeyCredentialManager.IsSupportedAsync()`.
- `create` is `RequestCreateAsync(name, FailIfExists)`. The public key it answers is the X.509
  SubjectPublicKeyInfo, which main turns into an `ssh-rsa` blob.
- `sign` is `OpenAsync(name)` followed by `RequestSignAsync(data)`: RSA PKCS#1 v1.5 over SHA-256.
- `unlock` is `UserConsentVerifier.RequestVerificationAsync(reason)`.
- Experimental: whether the Hello dialog comes to the front over the app has to be checked by hand on Windows.

**Main** (`apps/desktop/src/main/device-keys.ts`) finds the helper (packaged: `Resources/device-helper/`;
development: `apps/desktop/build-resources/device-helper/`). It runs the helper with a time limit (2 minutes
for a prompt, 10 s otherwise), maps the answers to the error codes above, and makes prompts one at a time. On
Linux, or when no helper is found, the answer is `unsupported` with a reason.

## Generate key…

- A **Device key** choice is shown when `status` says supported. It is named after the platform ("This Mac's
  Secure Enclave", "Windows Hello"), with the key type it makes beside it. Otherwise it is disabled and shows
  the reason.
- There is no passphrase field: the hardware protects the key.
- The recovery warning sits under the choice: "This key cannot be copied off this device or recovered. Keep
  a second way into the same hosts, such as another key or a security key."
- The default secret name is `id_ecdsa_device` (`id_rsa_device` on Windows).

**The keychain list**: a device key shows a "this device" badge, or "other device (DEVICE)" in the missing
state, from the helper's `check`. Install public key… works in both cases, since it needs only the public half.

## App lock

- Preferences `secrets.appLock` (false) and `secrets.appLockIdleMinutes` (15, from 1 to 240), shown in
  Settings → Secrets → App lock on every OS. Only main turns the lock on (`appLock.set`), after one successful
  `unlock` there and then, so it cannot be switched on where it cannot work; `preferences.update` refuses
  `secrets.appLock`. Turning it off asks for nothing.
- **When it locks**: at launch; after `idleMinutes` of system idle time (`powerMonitor.getSystemIdleTime`,
  checked every 30 s); on screen lock; on suspend.
- **The gate**: the SSH secret getter (sign-in, proxy password, host environment variables, snippets, key
  install) awaits `appLock.ensureUnlocked(reason)` before a secret read while locked. The keychain's key
  list, which reads only public halves, is not gated. Every waiting
  read shares one prompt. A cancelled prompt is `app-locked`: "Wirebench is locked; unlock to use SSH
  secrets".
- Sessions that are already open stay open when the app locks again. Only new secret reads ask.
- Nothing else is gated. REST, SOAP and the rest of the app stay usable, as ruled.
- Where there is no helper (Linux): the switch is disabled and shows the reason. A preferences file that says `enabled` on Linux is
  ignored, with one log line.

## Recovery and deletion

- A lost or wiped machine loses its device keys. The docs say to remove the key's public half from the hosts'
  `authorized_keys` and generate a new key.
- Deleting the secret forgets the handle. On macOS that deletes the whole key. On Windows the Hello credential
  stays until Windows' own key management removes it; cleaning it up is a follow-up.

## Tests

- `packages/ssh`: a round trip of encoding and parsing the block; refusal of an unknown platform or version;
  ecdsa r‖s → SSH signature; RSA SPKI → `ssh-rsa` blob. Sign-in against the test sshd with a software
  `DeviceKeySigner` (P-256 and RSA), plus the missing, cancelled and unavailable paths.
- Desktop main: the helper runner against a fake helper script (answers, errors, timeouts, prompts one at a
  time); generating and listing device keys; the app lock state machine with a fake clock and idle source, the
  gate sharing one prompt, and re-locking on idle, screen lock and suspend.
- macOS CI: build the helper and run `status`. A CI VM has no enclave, so `status` should say unsupported
  there. Where it says supported, also run `create` and a handle round trip; `create` does not prompt.
- Windows CI: run the script's `status` and check the answer's shape.
- Renderer: the Device key choice (supported and unsupported), the warning, the badge, the Settings section.
- Manual, per platform, recorded in `docs/manual-tests/2026-10-17-device-keys.md`: generate, install, sign in
  with Touch ID and with the password, cancel, a key from another Mac reported missing, app lock at the first
  connect, re-lock after idle and on screen lock.

## Non-goals

- Linux TPM keys.
- Agent forwarding of a device key, and certificates for one.
- Exporting or backing up a device key, which is impossible by design.
- Locking the whole window.
