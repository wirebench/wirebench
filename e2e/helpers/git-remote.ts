import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** A commit identity for {@link gitConfigEnv}; `null` means "no identity configured at all". */
export interface GitIdentity {
  readonly name: string;
  readonly email: string;
}

/** One global config file per identity, written once per worker process. */
const configFiles = new Map<string, string>();

/**
 * The env that makes git — the app's and the spec's own — read a throwaway global config instead
 * of the developer's or the runner's: `GIT_CONFIG_GLOBAL` points at a temp `gitconfig` and
 * `GIT_CONFIG_NOSYSTEM=1` skips the system one.
 *
 * With an identity the file carries `[user] name/email`. With `null` it carries only
 * `user.useConfigOnly = true`: an empty file is not enough, because git otherwise invents an
 * identity from the login name and host name on any machine whose host name looks like a domain
 * (every hosted macOS runner), and the "set your identity" flow under test would never start.
 */
export function gitConfigEnv(identity: GitIdentity | null): Record<string, string> {
  const key = identity === null ? '' : `${identity.name}\n${identity.email}`;
  let file = configFiles.get(key);
  if (file === undefined) {
    file = join(mkdtempSync(join(tmpdir(), 'wirebench-e2e-gitconfig-')), 'gitconfig');
    const body =
      identity === null
        ? '[user]\n\tuseConfigOnly = true\n'
        : `[user]\n\tname = ${identity.name}\n\temail = ${identity.email}\n`;
    writeFileSync(file, body, 'utf8');
    configFiles.set(key, file);
  }
  return { GIT_CONFIG_GLOBAL: file, GIT_CONFIG_NOSYSTEM: '1' };
}

/** The identity every sync spec commits under. */
export const ADA: GitIdentity = { name: 'Ada', email: 'ada@example.com' };

/**
 * Runs the spec's own git — never the app's — with the hermetic config above, and returns its
 * stdout. Throws on a non-zero exit, like `execFileSync`.
 */
export function runGit(args: readonly string[], identity: GitIdentity | null = ADA): string {
  return execFileSync('git', [...args], {
    env: { ...process.env, ...gitConfigEnv(identity) },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * A bare repository in a temp directory, its `HEAD` on `main`, to share a workspace to. `url` is
 * the `file://` form (`pathToFileURL`, so a Windows drive path becomes `file:///C:/…`), which is
 * the only local form the app's remote check accepts.
 */
export function createBareRemote(): Promise<{ dir: string; url: string }> {
  // `realpathSync.native` resolves the macOS `/var` → `/private/var` link and Windows 8.3 short
  // names, so the URL the app stores and the path the spec reads name the same folder.
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'wirebench-e2e-remote-')));
  try {
    runGit(['init', '--quiet', '--bare', '--initial-branch=main', dir]);
  } catch {
    // git older than 2.28 has no `--initial-branch`.
    runGit(['init', '--quiet', '--bare', dir]);
  }
  runGit(['--git-dir', dir, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
  return Promise.resolve({ dir, url: pathToFileURL(dir).href });
}

/** One line per commit on the remote's `main`, newest first, in `format` (`%s` subject, `%an` author); `[]` before the first push. */
export function remoteLog(dir: string, format = '%s'): string[] {
  try {
    return runGit(['--git-dir', dir, 'log', `--format=${format}`, 'main'])
      .split('\n')
      .filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

/** Every file path in the remote's `HEAD` tree, `/`-separated as git reports them; `[]` before the first push. */
export function remoteFiles(dir: string): string[] {
  try {
    return runGit(['--git-dir', dir, 'ls-tree', '-r', '--name-only', 'HEAD'])
      .split('\n')
      .filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

/** Whether any file on the remote's `main` contains `text` literally. */
export function remoteContains(dir: string, text: string): boolean {
  try {
    return runGit(['--git-dir', dir, 'grep', '--fixed-strings', '--files-with-matches', '-e', text, 'main']).length > 0;
  } catch {
    // `git grep` exits 1 for "no match", and fails outright before the first push.
    return false;
  }
}

/** The commit `rev` (default `main`) names on the remote; `undefined` before the first push. */
export function remoteHead(dir: string, rev = 'main'): string | undefined {
  try {
    return runGit(['--git-dir', dir, 'rev-parse', '--verify', rev]).trim();
  } catch {
    return undefined;
  }
}

/** The commit a working tree's `HEAD` names; `undefined` when it has none yet. */
export function treeHead(tree: string): string | undefined {
  try {
    return runGit(['-C', tree, 'rev-parse', '--verify', 'HEAD']).trim();
  } catch {
    return undefined;
  }
}
