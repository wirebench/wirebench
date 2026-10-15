# Homebrew cask

`Casks/wirebench.rb` installs the Wirebench desktop app on macOS with Homebrew. It picks the Apple
silicon or Intel `.dmg` from the GitHub release and checks it against the sha256 in the file. The app
updates itself, so the cask says `auto_updates true` and `brew upgrade` leaves it alone unless asked.

The file in this folder is generated. Never edit the version or the hashes by hand: render it with
`scripts/packaging-manifests.ts`, which writes the cask and the winget manifests together.

## Where the file comes from

**On every tag.** The `release` job in `.github/workflows/release.yml` hashes the signed installers it
is about to attach and adds `wirebench-package-manifests-<version>.zip` to the draft release. The zip
holds `homebrew/Casks/wirebench.rb` and the winget manifest set for that version.

**By hand, for a published release.** GitHub records a sha256 for each release asset, so nothing needs
downloading:

```bash
node scripts/packaging-manifests.ts --release v6.1.0
```

That rewrites `packaging/homebrew/Casks/wirebench.rb` and adds `packaging/winget/manifests/…/6.1.0/`.
Commit both.

The cask names the release's download URLs, and a draft release's assets are not public. Copy the cask
into the tap only after the release is published, and only for a final release, never a `-rc`.

## Create the tap (once)

A tap is a GitHub repository whose name starts with `homebrew-`. Homebrew drops that prefix in the
install command.

1. Create a public repository `wirebench/homebrew-tap`, with a `Casks/` folder and a short README.
2. Copy `packaging/homebrew/Casks/wirebench.rb` into its `Casks/` folder and push.
3. Check it from a Mac:

   ```bash
   brew tap wirebench/tap
   brew audit --cask --strict --online wirebench/tap/wirebench
   brew install --cask wirebench/tap/wirebench
   ```

## Each release

1. Publish the GitHub release.
2. Take `homebrew/Casks/wirebench.rb` from the release's `wirebench-package-manifests-<version>.zip`, or
   run the command above.
3. Replace `Casks/wirebench.rb` in `wirebench/homebrew-tap`, then commit and push.

The step stays manual on purpose. Pushing to the tap from `release.yml` would need a token with write
access to a second repository, and the release is a draft until a person publishes it.

## How users install

```bash
brew install --cask wirebench/tap/wirebench
```

`brew upgrade --cask --greedy wirebench` moves to the tap's version, and
`brew uninstall --cask --zap wirebench` also removes the app's settings and caches.

Once the project meets the main cask repository's notability rules, the same file can be proposed
there. Users would then run `brew install --cask wirebench`.
