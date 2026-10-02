export interface Installer {
  readonly platform: 'macOS' | 'Windows' | 'Linux';
  readonly label: string;
  readonly file: string;
  readonly url: string;
  readonly bytes: number;
}
export interface Release {
  readonly version: string; // "2.2.1": the tag without its "v"
  readonly publishedAt: string; // ISO 8601 from the API
  readonly notesUrl: string; // the release's html_url
  readonly installers: readonly Installer[];
}
interface Asset {
  readonly name: string;
  readonly browser_download_url: string;
  readonly size: number;
}
export interface ApiRelease {
  readonly tag_name: string;
  readonly published_at: string;
  readonly html_url: string;
  readonly assets: readonly Asset[];
}
/** The installers the download page lists, in page order; `file` is the artifact name for a version. */
export const INSTALLERS: readonly {
  readonly platform: Installer['platform'];
  readonly label: string;
  readonly file: (version: string) => string;
}[] = [
  { platform: 'macOS', label: 'Universal .dmg', file: (v) => `Wirebench-${v}-mac-universal.dmg` },
  { platform: 'macOS', label: 'Apple silicon .dmg', file: (v) => `Wirebench-${v}-mac-arm64.dmg` },
  { platform: 'macOS', label: 'Intel .dmg', file: (v) => `Wirebench-${v}-mac-x64.dmg` },
  { platform: 'Windows', label: 'x64 setup .exe', file: (v) => `Wirebench-${v}-windows-x64-setup.exe` },
  { platform: 'Windows', label: 'arm64 setup .exe', file: (v) => `Wirebench-${v}-windows-arm64-setup.exe` },
  { platform: 'Windows', label: 'x64 .msi', file: (v) => `Wirebench-${v}-windows-x64.msi` },
  { platform: 'Windows', label: 'arm64 .msi', file: (v) => `Wirebench-${v}-windows-arm64.msi` },
  { platform: 'Linux', label: 'x86_64 .AppImage', file: (v) => `Wirebench-${v}-linux-x86_64.AppImage` },
  { platform: 'Linux', label: 'arm64 .AppImage', file: (v) => `Wirebench-${v}-linux-arm64.AppImage` },
  { platform: 'Linux', label: 'amd64 .deb', file: (v) => `wirebench_${v}_amd64.deb` },
  { platform: 'Linux', label: 'arm64 .deb', file: (v) => `wirebench_${v}_arm64.deb` },
  { platform: 'Linux', label: 'x86_64 .rpm', file: (v) => `wirebench-${v}.x86_64.rpm` },
  { platform: 'Linux', label: 'amd64 .snap', file: (v) => `wirebench_${v}_amd64.snap` },
];

/** Maps an API release to the page's table. Throws, naming the file, when an installer is missing. */
export function mapRelease(api: ApiRelease): Release {
  const version = api.tag_name.replace(/^v/, '');
  const byName = new Map(api.assets.map((asset) => [asset.name, asset]));
  const installers = INSTALLERS.map(({ platform, label, file }) => {
    const name = file(version);
    const asset = byName.get(name);
    if (asset === undefined) {
      throw new Error(`release ${api.tag_name} has no asset ${name}`);
    }
    return { platform, label, file: name, url: asset.browser_download_url, bytes: asset.size };
  });
  return { version, publishedAt: api.published_at, notesUrl: api.html_url, installers };
}

const LATEST = 'https://api.github.com/repos/wirebench/wirebench/releases/latest';

/** The latest release from GitHub, or the fixture when WIREBENCH_SITE_OFFLINE=1. */
export async function loadRelease(
  env: NodeJS.ProcessEnv = process.env,
  fetchFn: typeof fetch = fetch,
): Promise<Release> {
  if (env['WIREBENCH_SITE_OFFLINE'] === '1') {
    const { default: fixture } = await import('./release.fixture.json', { with: { type: 'json' } });
    return mapRelease(fixture);
  }
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json' };
  const token = env['GITHUB_TOKEN'];
  if (token !== undefined && token !== '') {
    headers['Authorization'] = `Bearer ${token}`;
  }
  const response = await fetchFn(LATEST, { headers });
  if (!response.ok) {
    throw new Error(`latest release request failed: ${String(response.status)}`);
  }
  return mapRelease((await response.json()) as ApiRelease);
}
