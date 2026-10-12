/**
 * Pure helpers of the Files tab: remote paths. Remote paths are POSIX strings the server resolves; nothing
 * here normalises one beyond joining with `/`.
 */

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
