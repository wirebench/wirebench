import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  factsFromReleaseRecord,
  renderAll,
  renderCask,
  renderWingetInstaller,
  type Release,
} from './packaging-manifests.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const digest = (c: string): string => c.repeat(64);

const release: Release = {
  tag_name: 'v9.8.7',
  published_at: '2026-10-11T14:23:07Z',
  assets: [
    { name: 'Wirebench-9.8.7-mac-arm64.dmg', digest: `sha256:${digest('a')}` },
    { name: 'Wirebench-9.8.7-mac-x64.dmg', digest: `sha256:${digest('b')}` },
    { name: 'Wirebench-9.8.7-mac-universal.dmg', digest: `sha256:${digest('f')}` },
    { name: 'Wirebench-9.8.7-windows-x64-setup.exe', digest: `sha256:${digest('c')}` },
    { name: 'Wirebench-9.8.7-windows-arm64-setup.exe', digest: `sha256:${digest('d')}` },
  ],
};

describe('factsFromReleaseRecord', () => {
  it('takes the version from the tag, the date from publication and each installer digest', () => {
    expect(factsFromReleaseRecord(release)).toEqual({
      version: '9.8.7',
      date: '2026-10-11',
      digests: { macArm64: digest('a'), macX64: digest('b'), windowsX64: digest('c'), windowsArm64: digest('d') },
    });
  });

  it('refuses a release that is missing an installer digest', () => {
    const assets = release.assets.filter((asset) => !asset.name.endsWith('windows-arm64-setup.exe'));
    expect(() => factsFromReleaseRecord({ ...release, assets })).toThrow(/windows-arm64-setup\.exe/);
  });
});

describe('rendered manifests', () => {
  const facts = factsFromReleaseRecord(release);

  it('puts each Mac architecture digest beside its arch in the cask', () => {
    const cask = renderCask(facts);
    expect(cask).toContain('version "9.8.7"');
    expect(cask).toContain(`arm:   "${digest('a')}"`);
    expect(cask).toContain(`intel: "${digest('b')}"`);
    expect(cask).toContain('Wirebench-#{version}-mac-#{arch}.dmg');
  });

  it('names both Windows installers with upper-case digests', () => {
    const installer = renderWingetInstaller(facts);
    expect(installer).toContain('/v9.8.7/Wirebench-9.8.7-windows-x64-setup.exe');
    expect(installer).toContain(`InstallerSha256: ${digest('c').toUpperCase()}`);
    expect(installer).toContain(`InstallerSha256: ${digest('d').toUpperCase()}`);
    expect(installer).toContain('ReleaseDate: 2026-10-11');
  });

  it('lays the winget files out the way the winget-pkgs repository does', () => {
    expect([...renderAll(facts).keys()]).toEqual([
      'homebrew/Casks/wirebench.rb',
      'winget/manifests/w/Wirebench/Wirebench/9.8.7/Wirebench.Wirebench.yaml',
      'winget/manifests/w/Wirebench/Wirebench/9.8.7/Wirebench.Wirebench.installer.yaml',
      'winget/manifests/w/Wirebench/Wirebench/9.8.7/Wirebench.Wirebench.locale.en-US.yaml',
    ]);
  });

  it('matches the committed cask, so a hand edit is caught', async () => {
    const committed = await readFile(join(repoRoot, 'packaging/homebrew/Casks/wirebench.rb'), 'utf8');
    const version = /version "([^"]+)"/.exec(committed)?.[1] ?? '';
    const arm = /arm: {3}"([0-9a-f]{64})"/.exec(committed)?.[1] ?? '';
    const intel = /intel: "([0-9a-f]{64})"/.exec(committed)?.[1] ?? '';
    const rendered = renderCask({
      version,
      date: '2026-01-01',
      digests: { macArm64: arm, macX64: intel, windowsX64: '', windowsArm64: '' },
    });
    expect(committed).toBe(rendered);
  });
});
