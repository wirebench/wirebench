/**
 * Renders the package-manager manifests for a desktop release: the Homebrew cask under
 * `packaging/homebrew/Casks/` and the winget manifest set under `packaging/winget/manifests/`.
 *
 * Both name the release's installers by URL and sha256, so they are regenerated for every version
 * rather than edited by hand. Two sources for the hashes:
 *
 *  - `node scripts/packaging-manifests.ts --version 6.1.0 --artifacts <dir>` hashes the installers
 *    in `<dir>` (what `release.yml` does, with the files it is about to attach to the release).
 *  - `node scripts/packaging-manifests.ts --release v6.1.0` reads the `digest` GitHub records for each
 *    asset of that published release, so nothing has to be downloaded.
 *
 * `--out <dir>` writes somewhere other than `packaging/`. `--date YYYY-MM-DD` sets the winget
 * release date (the release's publication date with `--release`, today with `--artifacts`).
 *
 * The files are inputs for repositories outside this one: the cask goes into the owner's tap and
 * the winget set is submitted to the winget-pkgs repository. Neither is published from here; see
 * `packaging/homebrew/README.md` and `packaging/winget/README.md`.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = 'wirebench/wirebench';
const HOMEPAGE = 'https://wirebench.github.io/wirebench/';
const DESCRIPTION = 'Local-first API and SSH workbench';
const LONG_DESCRIPTION =
  'Wirebench is a local-first desktop workbench for SOAP, REST, GraphQL, gRPC, WebSocket and MCP requests, and for SSH hosts and terminals. Projects are plain files in a folder you own, so they live in git beside the code. An optional self-hosted server adds sign-in, teams and shared workspaces.';

/** The winget manifest schema version the three files declare. */
export const WINGET_SCHEMA_VERSION = '1.10.0';
export const WINGET_IDENTIFIER = 'Wirebench.Wirebench';

/** The installers a release's manifests name, keyed by the file-name suffix after `Wirebench-<version>-`. */
export const INSTALLERS = {
  macArm64: 'mac-arm64.dmg',
  macX64: 'mac-x64.dmg',
  windowsX64: 'windows-x64-setup.exe',
  windowsArm64: 'windows-arm64-setup.exe',
} as const;

export type InstallerKey = keyof typeof INSTALLERS;

/** sha256 hex digests of the four installers. */
export type Digests = Readonly<Record<InstallerKey, string>>;

export interface ReleaseFacts {
  /** The version without its `v`: `6.1.0`. */
  readonly version: string;
  readonly digests: Digests;
  /** `YYYY-MM-DD`; the winget release date. */
  readonly date: string;
}

/** The file name of one installer at `version`. */
export function installerName(version: string, key: InstallerKey): string {
  return `Wirebench-${version}-${INSTALLERS[key]}`;
}

/** The release-asset URL of one installer at `version`. */
export function installerUrl(version: string, key: InstallerKey): string {
  return `https://github.com/${REPO}/releases/download/v${version}/${installerName(version, key)}`;
}

/** The Homebrew cask: both Mac architectures, the app updates itself, zap list for a clean uninstall. */
export function renderCask({ version, digests }: ReleaseFacts): string {
  return `cask "wirebench" do
  arch arm: "arm64", intel: "x64"

  version "${version}"
  sha256 arm:   "${digests.macArm64}",
         intel: "${digests.macX64}"

  url "https://github.com/${REPO}/releases/download/v#{version}/Wirebench-#{version}-mac-#{arch}.dmg"
  name "Wirebench"
  desc "${DESCRIPTION}"
  homepage "${HOMEPAGE}"

  livecheck do
    url :url
    strategy :github_latest
  end

  auto_updates true
  depends_on macos: :ventura

  app "Wirebench.app"

  zap trash: [
    "~/Library/Application Support/Wirebench",
    "~/Library/Caches/io.wirebench.desktop",
    "~/Library/Caches/io.wirebench.desktop.ShipIt",
    "~/Library/HTTPStorages/io.wirebench.desktop",
    "~/Library/Logs/Wirebench",
    "~/Library/Preferences/io.wirebench.desktop.plist",
    "~/Library/Saved Application State/io.wirebench.desktop.savedState",
  ]
end
`;
}

/** The winget version manifest. */
export function renderWingetVersion({ version }: ReleaseFacts): string {
  return `# yaml-language-server: $schema=https://aka.ms/winget-manifest.version.${WINGET_SCHEMA_VERSION}.schema.json
PackageIdentifier: ${WINGET_IDENTIFIER}
PackageVersion: ${version}
DefaultLocale: en-US
ManifestType: version
ManifestVersion: ${WINGET_SCHEMA_VERSION}
`;
}

/** The winget installer manifest: the per-user NSIS installers for x64 and arm64. */
export function renderWingetInstaller({ version, digests, date }: ReleaseFacts): string {
  return `# yaml-language-server: $schema=https://aka.ms/winget-manifest.installer.${WINGET_SCHEMA_VERSION}.schema.json
PackageIdentifier: ${WINGET_IDENTIFIER}
PackageVersion: ${version}
InstallerType: nullsoft
Scope: user
InstallModes:
  - interactive
  - silent
  - silentWithProgress
UpgradeBehavior: install
ReleaseDate: ${date}
Installers:
  - Architecture: x64
    InstallerUrl: ${installerUrl(version, 'windowsX64')}
    InstallerSha256: ${digests.windowsX64.toUpperCase()}
  - Architecture: arm64
    InstallerUrl: ${installerUrl(version, 'windowsArm64')}
    InstallerSha256: ${digests.windowsArm64.toUpperCase()}
ManifestType: installer
ManifestVersion: ${WINGET_SCHEMA_VERSION}
`;
}

/** The winget default-locale manifest. */
export function renderWingetLocale({ version }: ReleaseFacts): string {
  return `# yaml-language-server: $schema=https://aka.ms/winget-manifest.defaultLocale.${WINGET_SCHEMA_VERSION}.schema.json
PackageIdentifier: ${WINGET_IDENTIFIER}
PackageVersion: ${version}
PackageLocale: en-US
Publisher: Wirebench contributors
PublisherUrl: https://github.com/${REPO}
PublisherSupportUrl: https://github.com/${REPO}/issues
PackageName: Wirebench
PackageUrl: ${HOMEPAGE}
License: Apache-2.0
LicenseUrl: https://github.com/${REPO}/blob/main/LICENSE
Copyright: Copyright © 2026 Wirebench contributors
ShortDescription: ${DESCRIPTION} for SOAP, REST, GraphQL, gRPC, WebSocket and MCP.
Description: ${LONG_DESCRIPTION}
Moniker: wirebench
Tags:
  - api
  - graphql
  - grpc
  - rest
  - soap
  - ssh
  - websocket
  - wsdl
ReleaseNotesUrl: https://github.com/${REPO}/releases/tag/v${version}
Documentations:
  - DocumentLabel: User guide
    DocumentUrl: ${HOMEPAGE}docs/
ManifestType: defaultLocale
ManifestVersion: ${WINGET_SCHEMA_VERSION}
`;
}

/** Every file the manifests consist of, as `relative path → contents` under the packaging root. */
export function renderAll(facts: ReleaseFacts): ReadonlyMap<string, string> {
  const winget = `winget/manifests/w/Wirebench/Wirebench/${facts.version}`;
  return new Map([
    ['homebrew/Casks/wirebench.rb', renderCask(facts)],
    [`${winget}/${WINGET_IDENTIFIER}.yaml`, renderWingetVersion(facts)],
    [`${winget}/${WINGET_IDENTIFIER}.installer.yaml`, renderWingetInstaller(facts)],
    [`${winget}/${WINGET_IDENTIFIER}.locale.en-US.yaml`, renderWingetLocale(facts)],
  ]);
}

async function sha256Of(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}

/** Hashes the four installers of `version` in `dir`. */
export async function digestsFromArtifacts(dir: string, version: string): Promise<Digests> {
  const entries = await Promise.all(
    (Object.keys(INSTALLERS) as InstallerKey[]).map(
      async (key) => [key, await sha256Of(join(dir, installerName(version, key)))] as const,
    ),
  );
  return Object.fromEntries(entries) as Digests;
}

interface ReleaseAsset {
  readonly name: string;
  readonly digest?: string | null;
}

export interface Release {
  readonly tag_name: string;
  readonly published_at: string | null;
  readonly assets: readonly ReleaseAsset[];
}

/** The facts a GitHub release record gives: version, publication date and each installer's sha256. */
export function factsFromReleaseRecord(release: Release): ReleaseFacts {
  const version = release.tag_name.replace(/^v/, '');
  const digests = Object.fromEntries(
    (Object.keys(INSTALLERS) as InstallerKey[]).map((key) => {
      const name = installerName(version, key);
      const digest = release.assets.find((asset) => asset.name === name)?.digest?.replace(/^sha256:/, '');
      if (!digest) {
        throw new Error(`release ${release.tag_name} has no sha256 digest for ${name}`);
      }
      return [key, digest];
    }),
  ) as Digests;
  const date = (release.published_at ?? new Date().toISOString()).slice(0, 10);
  return { version, digests, date };
}

async function fetchRelease(tag: string): Promise<Release> {
  const response = await fetch(`https://api.github.com/repos/${REPO}/releases/tags/${tag}`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'wirebench-packaging-manifests' },
  });
  if (!response.ok) {
    throw new Error(`GitHub answered ${String(response.status)} for release ${tag}`);
  }
  return (await response.json()) as Release;
}

function argValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

async function main(args: readonly string[]): Promise<void> {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const out = resolve(argValue(args, '--out') ?? join(repoRoot, 'packaging'));
  const tag = argValue(args, '--release');
  const artifacts = argValue(args, '--artifacts');
  const version = argValue(args, '--version');
  const date = argValue(args, '--date');

  let facts: ReleaseFacts;
  if (tag !== undefined) {
    facts = factsFromReleaseRecord(await fetchRelease(tag));
  } else if (artifacts !== undefined && version !== undefined) {
    facts = {
      version,
      digests: await digestsFromArtifacts(resolve(artifacts), version),
      date: new Date().toISOString().slice(0, 10),
    };
  } else {
    throw new Error(
      'usage: packaging-manifests.ts (--release vX.Y.Z | --version X.Y.Z --artifacts <dir>) [--out <dir>] [--date YYYY-MM-DD]',
    );
  }
  if (date !== undefined) {
    facts = { ...facts, date };
  }

  for (const [relative, contents] of renderAll(facts)) {
    const path = join(out, relative);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents);
    process.stdout.write(`wrote ${path}\n`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
