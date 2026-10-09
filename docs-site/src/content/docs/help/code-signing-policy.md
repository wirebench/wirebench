---
title: Code-signing policy
description: How Wirebench releases are built, signed and approved, who holds each role, and what each signature covers.
---

Wirebench releases are built only by the project's
[release workflow](https://github.com/wirebench/wirebench/blob/main/.github/workflows/release.yml),
from a version tag in the public repository. Nothing is built or signed on a developer's machine.

## Windows

Windows releases are signed with Microsoft's
[Azure Artifact Signing](https://learn.microsoft.com/azure/artifact-signing/) service, under a Public Trust
certificate profile. The release workflow signs in to Azure through GitHub's OpenID Connect, so no
signing key or client secret is stored in the repository or on a developer's machine.

- **What is signed:** the program files (`Wirebench.exe` and the other executables it ships) and the
  installers built around them (`…-setup.exe` and `.msi`), for x64 and arm64.
- **Who approves:** only the release workflow may sign, and every release stays a draft until an
  approver named under [Team roles](#team-roles) publishes it.
- **What the workflow checks first:** a release is built only after the project's full check suite
  (`pnpm check`) passes.

Windows signing is being set up. Releases up to and including 4.0.0 ship unsigned Windows
installers, so Windows names an unknown publisher when they run.

## Team roles

| Role | Who | What the role covers |
| --- | --- | --- |
| Authors | [Mohammed Naami (@mnaami)](https://github.com/mnaami) | Trusted to change the source code without a further review. |
| Reviewers | [Mohammed Naami (@mnaami)](https://github.com/mnaami) | Review every change proposed by someone who is not an author before it is merged. |
| Approvers | [Mohammed Naami (@mnaami)](https://github.com/mnaami) | Review and publish each release. |

Everyone in these roles uses multi-factor authentication on GitHub and on Azure.

## macOS

Releases are signed with the project's Apple *Developer ID Application* certificate and notarised by
Apple, so Gatekeeper opens them without a warning.

## Every release

- Releases are created as drafts. A maintainer reviews the draft and publishes it by hand.
- Each file carries a GitHub build attestation that links it to the commit and workflow run that
  built it. Each release also includes a CycloneDX SBOM of the app's dependencies. See
  [Verify a download](/wirebench/docs/getting-started/installation/#verify-a-download).
- The app talks to no server of the project's own. Update checks go to GitHub Releases, and only when
  you ask for one or turn on checking at launch, which is off by default.

## Privacy

This program will not transfer any information to other networked systems unless specifically
requested by the user.

Wirebench sends no telemetry and collects no data. The requests it sends are the ones you send. See
the [FAQ](/wirebench/docs/help/faq/#does-wirebench-send-any-telemetry-or-usage-data).
