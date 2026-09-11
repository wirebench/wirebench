# Releasing Wirebench

Wirebench ships as an Electron app packaged by [electron-builder]: a macOS `.dmg` and `.zip`
(universal), a Windows NSIS installer, and Linux `AppImage`, `.deb` and `.rpm` packages. The
configuration lives in `apps/desktop/electron-builder.yml`; the release pipeline is
`.github/workflows/release.yml`.

## Building locally

```bash
pnpm package          # this OS
pnpm package:mac      # or :win / :linux
```

Each script runs `pnpm build` first (electron-builder only copies what is already built) and
writes to `apps/desktop/release/`, which is git-ignored. Nothing is ever published from a
developer machine: `--publish never` is part of every script.

A local build is **unsigned**. macOS will refuse to open the resulting app from Finder without
right-click → Open (or `xattr -d com.apple.quarantine`), and SmartScreen will warn on Windows.
That is expected; only CI builds with the signing secrets produce distributable artifacts.

### pnpm specifics

- `npmRebuild: false`. Wirebench has no native modules, and running npm's rebuild against
  pnpm's symlinked store is a good way to flatten a tree that was fine.
- electron-builder resolves pnpm's symlinks itself, including the `@wirebench/engine`
  workspace link — no `node-linker=hoisted`, no `shamefully-hoist`. **Build the engine first**
  (`pnpm build` does): only its `dist/` is packaged, and a stale `dist/` ships stale code.
- Only the packages the *main process* loads at runtime are `dependencies` of
  `apps/desktop`. Everything Vite bundles into the renderer is a `devDependency` and is
  deliberately not in the asar. Adding a main-process dependency means adding it to
  `dependencies`, or the packaged app will fail to resolve it at runtime.

### What is unpacked from the asar

`xmllint-wasm` reads `xmllint.wasm` off the disk relative to `__dirname` and spawns a worker
from it, so it is `asarUnpack`ed into `app.asar.unpacked/`. The engine's XPath worker
(`dist/xpath/worker.js`) stays *inside* the asar — Electron's asar support covers the
`worker_threads` a main-process `new Worker()` creates. `e2e/specs/packaged.spec.ts` proves
both still work in a packaged build; if either ever stops, that spec is where it shows up.

## Electron fuses

`scripts/fuses.ts` runs as electron-builder's `afterPack` hook (before signing — flipping a
fuse rewrites the binary and invalidates any signature over it) and burns this wire into the
shipped executable:

| Fuse | Value | Why |
| --- | --- | --- |
| `RunAsNode` | off | The app binary is not a general-purpose Node interpreter. |
| `EnableCookieEncryption` | on | Session cookies are encrypted with the OS credential store. |
| `EnableNodeOptionsEnvironmentVariable` | off | `NODE_OPTIONS` cannot inject code into the app. |
| `EnableNodeCliInspectArguments` | off | No debugger can be attached to read secrets. |
| `EnableEmbeddedAsarIntegrityValidation` | on | The asar is hash-checked against the binary. |
| `OnlyLoadAppFromAsar` | on | App code loads from the asar only. |

The packaged e2e reads the fuses back off the built binary and compares them with that table.

Two consequences worth knowing:

- **The macOS bundle must be signed.** Flipping a fuse invalidates the signature, and
  `EnableEmbeddedAsarIntegrityValidation` only trusts `Info.plist` through one — an unsigned
  fused bundle does not start at all, silently. The hook therefore re-applies an *ad-hoc*
  signature (`codesign --sign -`) right after flipping; a real Developer ID signature replaces
  it later in the build when one is configured.
- **Playwright cannot drive the packaged app the usual way.** `_electron.launch` talks to the
  main process over Node's inspector, which `EnableNodeCliInspectArguments` and `RunAsNode`
  disable. `e2e/specs/packaged.spec.ts` attaches to the renderer over Chromium's remote
  debugging port instead (`launchPackagedApp`), so it drives the artifact a user would install
  rather than a specially relaxed build.

## Cutting a release

1. Bump `version` in `apps/desktop/package.json` (that is the version the artifacts carry).
2. Add the release's section to `CHANGELOG.md` if the repository has one — the workflow uses
   that section as the release body, and falls back to GitHub's generated notes.
3. Tag and push:

   ```bash
   git tag v0.1.0
   git push origin v0.1.0
   ```

The workflow runs `pnpm check`, packages on all three runners, uploads the artifacts and
creates a **draft** release (a tag containing `-`, such as `v0.1.0-rc.1`, is marked as a
pre-release). Review the draft, install one artifact per OS, then publish it by hand.

## Required secrets

All of these are optional: with none of them set the workflow still succeeds and produces
unsigned artifacts.

| Secret | Platform | Purpose |
| --- | --- | --- |
| `CSC_LINK` | macOS | Base64 `.p12` of the *Developer ID Application* certificate. |
| `CSC_KEY_PASSWORD` | macOS | Password for that `.p12`. |
| `APPLE_ID` | macOS | Apple ID used for notarization. |
| `APPLE_APP_SPECIFIC_PASSWORD` | macOS | App-specific password for that Apple ID. |
| `APPLE_TEAM_ID` | macOS | Team the certificate belongs to. |
| `WIN_CSC_LINK` | Windows | Base64 code-signing certificate. |
| `WIN_CSC_KEY_PASSWORD` | Windows | Password for it. |

Notarization runs only when all three `APPLE_*` values are present. `GITHUB_TOKEN` is provided
by Actions and is the only credential the draft-release step needs.

## Auto-update

The app checks for updates against **GitHub Releases** and nowhere else, through
`electron-updater`'s GitHub provider. It does so only when the user runs *Check for Updates…*
or has turned on *Preferences → Updates → Check for updates on launch*, which is **off by
default**. `autoDownload` and `autoInstallOnAppQuit` are forced off: a download takes one
confirmation and installing takes a second one. A check that cannot reach the feed reports
"Could not check for updates" and does nothing else. No telemetry is sent, ever.

The feed is read from `repository` in `apps/desktop/package.json`, currently the placeholder
`https://github.com/wirebench/wirebench.git`. **Confirm or correct that URL before the first
release** — with a wrong or missing one, every update check simply fails as above, and the
update metadata electron-builder generates (`latest*.yml`) points at a repository that does
not exist.

Update metadata is only meaningful for artifacts a user can install: publish `latest-mac.yml`,
`latest.yml` and `latest-linux.yml` alongside the binaries (the workflow uploads them), and
keep the `.blockmap` files — they are what makes an update a delta download.

[electron-builder]: https://www.electron.build/
