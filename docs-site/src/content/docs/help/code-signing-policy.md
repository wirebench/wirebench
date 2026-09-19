---
title: Code-signing policy
description: How Wirebench releases are built, signed and approved, and what each signature covers.
---

Wirebench releases are built only by the project's
[release workflow](https://github.com/wirebench/wirebench/blob/main/.github/workflows/release.yml),
from a version tag in the public repository. Nothing is built or signed on a developer's machine.

## Windows

Free code signing provided by [SignPath.io](https://about.signpath.io/), certificate by
[SignPath Foundation](https://signpath.org/).

- **What is signed:** the program files (`Wirebench.exe` and the other executables it ships) and the
  installers built around them (`…-setup.exe` and `.msi`), for x64 and arm64.
- **Who approves:** every signing request is approved in SignPath by a project maintainer before it is
  signed. The approvers are the maintainers who can publish a release on GitHub.
- **What the workflow checks first:** a release is built only after the project's full check suite
  (`pnpm check`) passes.

## macOS

Releases are signed with the project's Apple *Developer ID Application* certificate and notarised by
Apple, once that certificate is in place. Until then, macOS builds are unsigned, and the
[install guide](/wirebench/getting-started/installation/) explains how to open them.

## Every release

- Releases are created as drafts. A maintainer reviews the draft and publishes it by hand.
- Each file carries a GitHub build attestation that links it to the commit and workflow run that
  built it. Each release also includes a CycloneDX SBOM of the app's dependencies. See
  [Verify a download](/wirebench/getting-started/installation/#verify-a-download).
- The app talks to no server of the project's own. Update checks go to GitHub Releases, and only when
  you ask for one or turn on checking at launch.

## Privacy

Wirebench sends no telemetry and collects no data. See the
[FAQ](/wirebench/help/faq/#does-wirebench-send-any-telemetry-or-usage-data).
