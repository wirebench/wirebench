/**
 * Pure helpers of the Files tab: remote paths, crumbs, and how an entry's size, time and mode read. Remote
 * paths are POSIX strings the server resolves; nothing here normalises one beyond joining with `/`.
 */
import type { SftpEntryWire } from '../../../../shared/sftp-wire.js';
import type { PaneSort } from './files-store.js';

/** `name` inside `dir`. */
export function joinRemote(dir: string, name: string): string {
  return dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`;
}

/** The folder holding `path`; the root is its own parent. */
export function parentOf(path: string): string {
  const trimmed = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
  const cut = trimmed.lastIndexOf('/');
  return cut <= 0 ? '/' : trimmed.slice(0, cut);
}

/**
 * What a typed path means: `~` and `~/…` are under the pane's home, a relative path is under the current
 * folder, an absolute one is itself. Surrounding blanks are dropped; an empty entry is the current folder.
 */
export function resolveTyped(input: string, home: string, current: string): string {
  const text = input.trim();
  if (text === '') return current;
  if (text === '~') return home;
  if (text.startsWith('~/')) return joinRemote(home, text.slice(2));
  if (text.startsWith('/')) return text;
  return joinRemote(current, text);
}

/** One crumb of a path bar: what it shows and where a click goes. */
export interface Crumb {
  readonly label: string;
  readonly path: string;
}

/** The crumbs of an absolute path: the root, then each folder down to the last. */
export function crumbsOf(path: string): readonly Crumb[] {
  const crumbs: Crumb[] = [{ label: '/', path: '/' }];
  let at = '';
  for (const part of path.split('/')) {
    if (part === '') continue;
    at = `${at}/${part}`;
    crumbs.push({ label: part, path: at });
  }
  return crumbs;
}

/** Permission bits as `ls` draws them, `rwxr-x---`; a set-id or sticky bit shows as `s` / `t` (`S` / `T` without x). */
export function modeString(mode: number): string {
  const triplet = (bits: number, special: boolean, mark: string): string => {
    const x = (bits & 1) !== 0;
    const exec = special ? (x ? mark : mark.toUpperCase()) : x ? 'x' : '-';
    return `${(bits & 4) !== 0 ? 'r' : '-'}${(bits & 2) !== 0 ? 'w' : '-'}${exec}`;
  };
  return (
    triplet((mode >> 6) & 7, (mode & 0o4000) !== 0, 's') +
    triplet((mode >> 3) & 7, (mode & 0o2000) !== 0, 's') +
    triplet(mode & 7, (mode & 0o1000) !== 0, 't')
  );
}

const UNITS = ['KB', 'MB', 'GB', 'TB'] as const;

/** A byte count for a column: `0 B`, `1.0 KB`, `12 MB` (one decimal below ten, none above). */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : String(Math.round(value))} ${UNITS[unit] ?? 'TB'}`;
}

const MODIFIED = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** A modified time for a column, in the user's locale. */
export function formatModified(ms: number): string {
  return MODIFIED.format(new Date(ms));
}

/** A folder, or a link to one: opening it lists it. */
export function isFolderLike(entry: Pick<SftpEntryWire, 'type' | 'targetType'>): boolean {
  return entry.type === 'dir' || (entry.type === 'symlink' && entry.targetType === 'dir');
}

/** A name starting with `.`. */
export function isHidden(name: string): boolean {
  return name.startsWith('.');
}

const NAMES = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Folders (and links to folders) first, then by the chosen column; ties go by name. */
export function sortEntries(entries: readonly SftpEntryWire[], sort: PaneSort): SftpEntryWire[] {
  const sign = sort.descending ? -1 : 1;
  const byColumn = (a: SftpEntryWire, b: SftpEntryWire): number => {
    switch (sort.column) {
      case 'size':
        return a.size - b.size;
      case 'mtime':
        return a.mtime - b.mtime;
      case 'mode':
        return (a.mode ?? 0) - (b.mode ?? 0);
      case 'name':
        return 0;
    }
  };
  return [...entries].sort((a, b) => {
    const folders = Number(isFolderLike(b)) - Number(isFolderLike(a));
    if (folders !== 0) return folders;
    const column = byColumn(a, b);
    return sign * (column !== 0 ? column : NAMES.compare(a.name, b.name));
  });
}

/** What the list shows: hidden entries only when asked, in the pane's order. */
export function visibleEntries(
  entries: readonly SftpEntryWire[],
  showHidden: boolean,
  sort: PaneSort,
): SftpEntryWire[] {
  return sortEntries(showHidden ? entries : entries.filter((e) => !isHidden(e.name)), sort);
}

/** `base`, or `base 2`, `base 3`, … — the first not in `taken`. */
export function freeName(base: string, taken: readonly string[]): string {
  const names = new Set(taken);
  if (!names.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base} ${String(n)}`;
    if (!names.has(candidate)) return candidate;
  }
}

/** Why `name` cannot name an entry, or `undefined` when it can. */
export function nameError(name: string): string | undefined {
  if (name.trim() === '') return 'A name cannot be empty.';
  if (name.includes('/') || name.includes('\0')) return 'A name cannot contain /.';
  if (name === '.' || name === '..') return 'That name is reserved.';
  return undefined;
}
