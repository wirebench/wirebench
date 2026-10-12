/** The operating systems a host's icon can show; mirrors the desktop's `SSH_OS_IDS`. */
export type OsId =
  | 'ubuntu'
  | 'debian'
  | 'rhel'
  | 'centos'
  | 'fedora'
  | 'rocky'
  | 'alma'
  | 'suse'
  | 'alpine'
  | 'arch'
  | 'amazon'
  | 'linux'
  | 'macos'
  | 'freebsd'
  | 'windows';

export interface DetectedOs {
  readonly id: OsId;
  /** The system's own name for itself, for text next to the icon. */
  readonly name: string;
  readonly version?: string;
}

/** `os-release` ids (and `ID_LIKE` words) to the id the icon uses. */
const FROM_RELEASE_ID = (id: string): OsId | undefined => {
  if (id === 'ubuntu' || id === 'debian' || id === 'centos' || id === 'fedora' || id === 'rocky') return id;
  if (id === 'alpine' || id === 'arch') return id;
  if (id === 'rhel' || id === 'redhat') return 'rhel';
  if (id === 'almalinux' || id === 'alma') return 'alma';
  if (id === 'amzn' || id === 'amazon') return 'amazon';
  if (id === 'sles' || id === 'suse' || id.startsWith('opensuse')) return 'suse';
  return undefined;
};

/** `KEY="value"` / `KEY=value` lines of an `os-release` file. */
function parseKeyValues(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (!match?.[1] || match[2] === undefined) continue;
    values.set(match[1], match[2].replace(/^(["'])(.*)\1$/, '$2'));
  }
  return values;
}

/**
 * Names the operating system from the output of `cat /etc/os-release || uname -s || ver`. Understands
 * `os-release` text, `uname -s` (Darwin, FreeBSD) and the Windows `ver` banner; anything else, or nothing,
 * is `undefined`.
 */
export function detectOs(output: string): DetectedOs | undefined {
  const text = output.trim();
  if (text === '') return undefined;
  const values = parseKeyValues(text);
  const releaseId = values.get('ID')?.toLowerCase();
  if (releaseId !== undefined || values.has('NAME')) {
    const like = (values.get('ID_LIKE') ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    const id =
      (releaseId === undefined ? undefined : FROM_RELEASE_ID(releaseId)) ??
      like.map(FROM_RELEASE_ID).find((candidate) => candidate !== undefined) ??
      'linux';
    const name = values.get('NAME') || values.get('PRETTY_NAME') || releaseId || 'Linux';
    const version = values.get('VERSION_ID');
    return { id, name, ...(version ? { version } : {}) };
  }
  if (/^Darwin\b/i.test(text)) return { id: 'macos', name: 'macOS' };
  if (/^FreeBSD\b/i.test(text)) return { id: 'freebsd', name: 'FreeBSD' };
  const windows = /Microsoft Windows\s+\[Version\s+([\d.]+)\]/i.exec(text);
  if (windows) return { id: 'windows', name: 'Windows', ...(windows[1] ? { version: windows[1] } : {}) };
  return undefined;
}
