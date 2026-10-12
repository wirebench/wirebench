import { WirebenchError } from '@wirebench/engine';

/**
 * A name from the other side as a single path part on this machine (spec D9): `''`, `.`, `..` and a name
 * holding `/`, `\` or NUL are refused, so a hostile or broken server can never make a copy write outside
 * the folder the user chose.
 *
 * @throws WirebenchError `sftp-failed` with `details.reason: 'unsafe-name'`
 */
export function safeLocalName(name: string): string {
  if (name === '' || name === '.' || name === '..' || /[/\\\0]/.test(name)) {
    throw new WirebenchError('sftp-failed', `${JSON.stringify(name)} is not a safe file name`, {
      details: { name, reason: 'unsafe-name' },
    });
  }
  return name;
}

/** `archive.tar.gz` → [`archive`, `.tar.gz`]; a leading dot belongs to the stem (`.env` → [`.env`, ``]). */
const splitName = (name: string): [string, string] => {
  const dot = name.indexOf('.', 1);
  return dot < 0 ? [name, ''] : [name.slice(0, dot), name.slice(dot)];
};

/** The first free `name (n).ext`, n from 1: `a.txt` → `a (1).txt`, `archive.tar.gz` → `archive (1).tar.gz`, `.env` → `.env (1)`. */
export async function keepBothName(name: string, taken: (candidate: string) => Promise<boolean>): Promise<string> {
  const [stem, extension] = splitName(name);
  for (let n = 1; ; n += 1) {
    const candidate = `${stem} (${String(n)})${extension}`;
    if (!(await taken(candidate))) return candidate;
  }
}

/**
 * A name as a single part of a host's path: `''`, `.`, `..` and a name holding `/` or NUL are refused (a
 * backslash is an ordinary character there).
 *
 * @throws WirebenchError `sftp-failed` with `details.reason: 'unsafe-name'`
 */
export function safeRemoteName(name: string): string {
  if (name === '' || name === '.' || name === '..' || /[/\0]/.test(name)) {
    throw new WirebenchError('sftp-failed', `${JSON.stringify(name)} is not a safe file name`, {
      details: { name, reason: 'unsafe-name' },
    });
  }
  return name;
}
