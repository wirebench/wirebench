# ADR-0027: Device keys sign through a shipped helper process

- Status: accepted
- Date: 2026-10-17
- Context: issue #428 (device keys and app lock), [ADR-0026](0026-the-local-terminal-uses-a-prebuilt-pty-binding.md)

## Context

A device key is made and used by the machine's secure hardware: the Secure Enclave through CryptoKit on macOS,
Windows Hello through WinRT's `KeyCredentialManager` on Windows. Node reaches neither. The app lock needs the
same platforms' owner prompt (`LAContext`, `UserConsentVerifier`). Four options were weighed:

1. A Node native module (N-API) per platform. It is built per architecture, vendored like the pty binding, and
   loaded into main. Objective-C and C++/WinRT code then runs inside the app process, and every Electron
   upgrade is a reason to check the build.
2. Electron's own APIs. `systemPreferences.promptTouchID` asks for Touch ID only, with no password fallback
   and no key. Electron has nothing for Windows Hello keys.
3. **A helper process per platform**, run once per request, speaking one JSON protocol: a small Swift program
   on macOS, and on Windows a PowerShell script run by the Windows PowerShell that ships with the OS.
4. Asking users to run an agent that holds such keys, and signing through the agent protocol.

## Decision

- **Option 3.** `apps/desktop/native/device-helper/` holds both helpers. `scripts/build-device-helper.ts`
  compiles the Swift one for arm64 and x86_64, joins the slices into one universal binary, and copies the
  PowerShell one. electron-builder ships either as an extra resource, outside the asar, and signs the macOS
  binary with the app.
- **The protocol is the interface.** `status`, `create`, `check`, `sign` and `unlock`, with one JSON request
  and one JSON answer, and four error reasons (`cancelled`, `missing`, `unsupported`, `failed`). Main's
  `DeviceHelper` is the only caller. Tests drive it with a fake helper, and CI runs the real ones on macOS and
  Windows.
- **A CryptoKit key, not a keychain item.** The Secure Enclave key's `dataRepresentation` is the handle
  Wirebench stores. That needs no keychain entitlement or provisioning profile, and the handle is useless on
  any other Mac.
- **A missing helper is a state.** Where there is none (Linux, or a development checkout that has not built
  it), device keys and the app lock are shown as unavailable, with the reason.

## Consequences

- No new native module is loaded into the app. A crash in the hardware code ends one helper run, not main.
- Each signature starts a process: a few milliseconds on macOS, and the start-up time of PowerShell (about a
  second) on Windows, both well inside the time the person takes to answer the prompt.
- The Windows helper cannot be checked with Hello in CI. It stays marked experimental until it has been
  checked by hand on a Windows machine with Hello set up.
- Option 4 stays open: an agent's own keys keep working as before, through `auth: { agent: true }`.
