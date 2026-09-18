/**
 * Guards the rule that Wirebench describes its own behaviour on its own terms: the names of
 * other SOAP tooling vendors and products must not appear anywhere in the tracked tree — not in
 * code, comments, identifiers, UI strings, tests, fixtures, docs, ADRs, the spec or the plan.
 *
 * The reasons are two. Wirebench is a clean-room implementation, and a comment saying it matches
 * some other tool is exactly the provenance claim the licensing rule in `CONTRIBUTING.md` exists
 * to avoid. And a behaviour worth implementing is worth describing directly — "the `${#Env#x}`
 * property syntax" tells a reader what the code does, where a product name does not.
 *
 * Every tracked file is scanned, case-insensitively, including `THIRD-PARTY-LICENSES.md`: a
 * bundled dependency's licence text must not carry these names either. The one exception is
 * {@link FORMAT_IDENTIFIER_PATHS}: the legacy SOAP project import has to recognise that file by its
 * namespace URI and root element name, which contain the terms, so the constants holding them and the
 * hand-written fixtures written in that format are exempt. Nothing else is.
 *
 * `node scripts/check-banned-terms.ts` prints the result and exits non-zero, listing
 * `file:line`, on any hit. Wired into `pnpm check` as `pnpm check:banned-terms`.
 */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

/** The product and vendor names that must never appear. Matched case-insensitively. */
export const BANNED_TERMS: readonly string[] = ['soapui', 'readyapi', 'smartbear', 'eviware'];

/** One offending line. */
export interface BannedTermHit {
  readonly file: string;
  readonly line: number;
  readonly term: string;
  readonly text: string;
}

/** This script itself is the one place the terms are written down, so it never reports itself. */
const SELF_RELATIVE_PATH = 'scripts/check-banned-terms.ts';

/**
 * Where a foreign file format's own identifiers must appear verbatim (owner ruling of 2026-09-18,
 * `docs/specs/2026-09-18-legacy-soap-project-import-design.md` ruling 5). An entry ending in `/` exempts
 * everything under that folder; any other entry exempts exactly that file.
 */
export const FORMAT_IDENTIFIER_PATHS: readonly string[] = [
  'packages/engine/src/soap/legacy-project/format.ts',
  'fixtures/legacy-soap-project/',
];

/** True when `path` (repo-relative, `/`-separated) is the checker itself or a format-identifier path. */
export function isExemptPath(path: string): boolean {
  if (path === SELF_RELATIVE_PATH) {
    return true;
  }
  return FORMAT_IDENTIFIER_PATHS.some((entry) => (entry.endsWith('/') ? path.startsWith(entry) : path === entry));
}

/**
 * Finds every banned term in `content`. Pure — the file is identified by `file` only so the
 * caller can report a location.
 */
export function findBannedTerms(file: string, content: string): BannedTermHit[] {
  const hits: BannedTermHit[] = [];
  const lines = content.split('\n');
  for (const [index, text] of lines.entries()) {
    const lowered = text.toLowerCase();
    for (const term of BANNED_TERMS) {
      if (lowered.includes(term)) {
        hits.push({ file, line: index + 1, term, text: text.trim() });
      }
    }
  }
  return hits;
}

/** Every path `git ls-files` reports, which is the tracked tree minus everything ignored. */
async function trackedFiles(repoRoot: string): Promise<string[]> {
  const { stdout } = await promisify(execFile)('git', ['ls-files', '-z'], {
    cwd: repoRoot,
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout.split('\0').filter((path) => path.length > 0);
}

async function main(): Promise<void> {
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  const files = (await trackedFiles(repoRoot)).filter((path) => !isExemptPath(path));

  const hits: BannedTermHit[] = [];
  for (const file of files) {
    let content: string;
    try {
      content = await readFile(join(repoRoot, file), 'utf-8');
    } catch {
      continue; // A binary or unreadable file cannot contain a term worth reporting.
    }
    hits.push(...findBannedTerms(file, content));
  }

  if (hits.length === 0) {
    process.stdout.write(`banned terms: none of ${String(BANNED_TERMS.length)} across ${String(files.length)} files\n`);
    return;
  }
  process.stderr.write(
    `${String(hits.length)} banned-term reference(s) found; describe the behaviour instead:\n${hits
      .map((hit) => `  ${hit.file}:${String(hit.line)}: ${hit.text}`)
      .join('\n')}\n`,
  );
  process.exitCode = 1;
}

// Only run when executed directly, not when the test file imports the pure function above.
if (process.argv[1] !== undefined && import.meta.url === new URL(process.argv[1], 'file:').href) {
  await main();
}
