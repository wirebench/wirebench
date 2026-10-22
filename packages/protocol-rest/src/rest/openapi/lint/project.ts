/**
 * A project's own rule sets (#342 spec §5): every `*.yaml` / `*.yml` file in its `lint/` folder, in
 * name order, read for {@link lintOpenApi}. The CLI and the desktop both read them here, so the two
 * apply the same files in the same order.
 */

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { LintRulesetFile } from './model.js';

/** The folder of a project that holds its rule sets. */
export const LINT_FOLDER = 'lint';

/**
 * The project's rule-set files, named `lint/<file>`; none when the folder does not exist.
 *
 * @param projectDir the project's folder (the one holding `wirebench.yaml`)
 */
export async function readProjectLintRulesets(projectDir: string): Promise<LintRulesetFile[]> {
  const folder = join(projectDir, LINT_FOLDER);
  let names: string[];
  try {
    names = await readdir(folder);
  } catch {
    return [];
  }
  const files: LintRulesetFile[] = [];
  for (const name of names.filter((entry) => /\.ya?ml$/i.test(entry)).sort()) {
    files.push({ name: `${LINT_FOLDER}/${name}`, text: await readFile(join(folder, name), 'utf8') });
  }
  return files;
}
