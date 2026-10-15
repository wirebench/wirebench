# winget manifests

`manifests/w/Wirebench/Wirebench/<version>/` holds the three files winget needs to install the Wirebench
desktop app on Windows:

| File                                    | What it says                                                         |
| --------------------------------------- | -------------------------------------------------------------------- |
| `Wirebench.Wirebench.yaml`              | The package id, the version and the default locale.                  |
| `Wirebench.Wirebench.installer.yaml`    | The per-user setup `.exe` for x64 and arm64, with each one's sha256. |
| `Wirebench.Wirebench.locale.en-US.yaml` | Name, publisher, license, description, tags and links.               |

The folder path is the one the winget-pkgs repository uses, so the version folder is copied across as it
is. The manifests use schema 1.10.0 and name the NSIS installers (`InstallerType: nullsoft`), which
install for the current user without an administrator prompt. The app updates itself as well, so
`winget upgrade` and the in-app updater both work.

The files are generated. Never edit the version or the hashes by hand: render them with
`scripts/packaging-manifests.ts`, as described in [`../homebrew/README.md`](../homebrew/README.md).
Every tag's draft release carries them in `wirebench-package-manifests-<version>.zip`, and
`node scripts/packaging-manifests.ts --release v<version>` writes them here for a published release.
Submit only a published, final release, never a `-rc`: the installer URLs of a draft are not public.

## Check a version locally (on Windows)

```powershell
winget validate --manifest packaging\winget\manifests\w\Wirebench\Wirebench\6.1.0
winget settings --enable LocalManifestFiles
winget install --manifest packaging\winget\manifests\w\Wirebench\Wirebench\6.1.0
```

## Submit to winget-pkgs

The first submission creates the package. Each later release is another version folder under the same
package id.

1. Fork `microsoft/winget-pkgs` on GitHub.
2. Copy this version's folder to the same path in the fork,
   `manifests/w/Wirebench/Wirebench/<version>/`, on a new branch.
3. Open a pull request titled `New package: Wirebench.Wirebench version <version>` for the first one, and
   `New version: Wirebench.Wirebench version <version>` after that. Fill in the checklist the pull request
   template shows.
4. The repository's bots validate the manifests, download both installers and run them in a sandbox.
   A moderator merges once they pass, usually within a few days.

`wingetcreate` does steps 1 to 3 in one command once the package exists:

```powershell
wingetcreate submit --token <a GitHub token> packaging\winget\manifests\w\Wirebench\Wirebench\<version>
```

While the Windows installers are unsigned, the sandbox run can raise a SmartScreen review, which only
slows the first submission down. See the code-signing policy in the docs site's Help section.

## How users install

```powershell
winget install Wirebench.Wirebench
```

`winget install wirebench` works too, through the `Moniker`. `winget upgrade Wirebench.Wirebench`
updates the app.
