import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { INSTALLERS, loadRelease, mapRelease, type ApiRelease } from '../src/data/release.ts';

async function fixture(): Promise<ApiRelease> {
  const text = await readFile(new URL('../src/data/release.fixture.json', import.meta.url), 'utf8');
  return JSON.parse(text) as ApiRelease;
}

const mustNotBeCalled: typeof fetch = () => {
  throw new Error('the network must not be touched');
};

function recordingFetch(
  headers: Record<string, string>[],
  response: { ok: boolean; status: number; json?: () => Promise<unknown> },
): typeof fetch {
  return ((_url: unknown, init?: { headers?: Record<string, string> }) => {
    headers.push(init?.headers ?? {});
    return Promise.resolve(response);
  }) as unknown as typeof fetch;
}

describe('mapRelease', () => {
  it('maps the fixture to the 13 installers in page order with its urls and sizes', async () => {
    const api = await fixture();
    const release = mapRelease(api);
    expect(release.version).toBe(api.tag_name.replace(/^v/, ''));
    expect(release.installers).toHaveLength(13);
    expect(release.installers.map((i) => i.file)).toEqual(INSTALLERS.map((i) => i.file(release.version)));
    for (const installer of release.installers) {
      const asset = api.assets.find((a) => a.name === installer.file);
      expect(installer.url).toBe(asset?.browser_download_url);
      expect(installer.bytes).toBe(asset?.size);
    }
  });

  it('throws naming the file when an installer is missing', async () => {
    const api = await fixture();
    const trimmed = { ...api, assets: api.assets.filter((a) => !a.name.endsWith('.rpm')) };
    expect(() => mapRelease(trimmed)).toThrow(/\.rpm/);
  });
});

describe('loadRelease', () => {
  it('reads the fixture offline without calling fetch', async () => {
    const release = await loadRelease({ WIREBENCH_SITE_OFFLINE: '1' }, mustNotBeCalled);
    expect(release.installers).toHaveLength(13);
  });

  it('sends Authorization only when GITHUB_TOKEN is set', async () => {
    const api = await fixture();
    const ok = { ok: true, status: 200, json: () => Promise.resolve(api) };
    const withToken: Record<string, string>[] = [];
    await loadRelease({ GITHUB_TOKEN: 'tok' }, recordingFetch(withToken, ok));
    expect(withToken[0]?.['Authorization']).toBe('Bearer tok');
    const without: Record<string, string>[] = [];
    await loadRelease({}, recordingFetch(without, ok));
    expect(without[0]).not.toHaveProperty('Authorization');
    const empty: Record<string, string>[] = [];
    await loadRelease({ GITHUB_TOKEN: '' }, recordingFetch(empty, ok));
    expect(empty[0]).not.toHaveProperty('Authorization');
  });

  it('throws with the status when the request fails', async () => {
    await expect(loadRelease({}, recordingFetch([], { ok: false, status: 403 }))).rejects.toThrow(/403/);
  });
});
