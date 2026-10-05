# ADR-0019: Kerberos uses an optional native module, vendored per architecture

- Status: accepted
- Date: 2026-10-05
- Context: `docs/specs/2026-10-05-kerberos-spnego-auth-design.md`, issue #40, roadmap item 7. Until now
  `docs/release.md` stated that Wirebench has no native modules, and the v1 boundaries made adding one an
  ask-first decision.

## Context

Kerberos over HTTP (SPNEGO, `WWW-Authenticate: Negotiate`) is how Windows-integrated sites authenticate. The
value is single sign-on: the request goes out with the ticket the user already holds from their Windows logon
or `kinit`, so no password is typed. Only the operating system can produce a token from that ticket: SSPI on
Windows, GSSAPI on macOS and Linux. Four options were weighed:

1. The `kerberos` npm package (Apache-2.0, N-API v9, prebuilt for darwin x64/arm64, linux x64/arm64 and
   win32 x64), as an optional dependency.
2. A Kerberos client in TypeScript that talks to the KDC with a typed password. No native code, but no
   single sign-on, which is most of the point. It also means owning a large amount of protocol and crypto
   code.
3. Getting the token from an operating-system tool run as a child process. Slow on every send, different on
   every platform, and fragile.
4. Not building it yet.

## Decision

- **Option 1.** `kerberos` is an `optionalDependency` of `@wirebench/engine`, pinned to an exact version and
  loaded lazily by one module (`http/auth/kerberos-native.ts`). Nothing else imports it.
- **A missing or broken binary is a state, not a crash.** The loader returns `available` or
  `unavailable(reason)`. The UI shows the scheme disabled with that reason, and a send that asks for it is
  refused with `kerberos-unavailable`.
- **The desktop app vendors the binaries rather than trusting the install.** The release jobs build several
  architectures from one `pnpm install`, with `npmRebuild: false`, so the installed `.node` file matches only
  the runner. A packaging script downloads the pinned prebuilt tarballs for every architecture of the target
  platform and checks their SHA-256 against hashes committed in the repository. It places them at
  `resources/kerberos/<platform>-<arch>/kerberos.node`, unpacked from the asar, so they are signed with the
  app and listed in the SBOM. Every architecture's build carries the same files, so the macOS universal merge
  is a plain copy.
- **Kerberos only, never NTLM.** The client is initialised with the Kerberos mechanism (`GSS_MECH_OID_KRB5`,
  which on Windows selects the SSPI `Kerberos` package rather than `Negotiate`). A failure says so, rather
  than quietly authenticating with NTLM. The NTLM scheme already exists for anyone who wants it.

## Consequences

- Wirebench ships its first native binary. `docs/release.md` and the `npmRebuild` comment in
  `electron-builder.yml` are corrected, and the SBOM gains the component.
- Windows on ARM has no prebuild, so the scheme is unavailable there until upstream ships one. The same is
  true of a Linux machine without `libgssapi_krb5`. Both show the reason in the UI.
- `@wirebench/cli` installs from npm pick up the binary through the engine's optional dependency, via
  `prebuild-install`. Where the install fails, the CLI still works and refuses only Kerberos sends.
- Upgrading `kerberos` means updating the pinned version and the committed hashes together. The packaging
  check fails if they disagree.
