import { ESLint } from 'eslint';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// `.pathname` of a file: URL is not a path on Windows ('/D:/a/...'); only
// `fileURLToPath` turns it into one.
const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url));

describe('engine lint guard', () => {
  it('rejects importing electron from within packages/engine/src', async () => {
    const eslint = new ESLint({ cwd: repoRoot });

    let tempFile: string | undefined;
    try {
      let results;
      let restrictedImportError;
      try {
        results = await eslint.lintText("import 'electron';\n", {
          filePath: 'packages/engine/src/probe.ts',
        });
        restrictedImportError = results.flatMap((r) => r.messages).find((m) => m.ruleId === 'no-restricted-imports');
      } catch {
        results = undefined;
      }

      if (restrictedImportError === undefined) {
        // The type-checked config cannot lint a virtual (non-existent) file, since
        // rules relying on the TS project service need a real file on disk. Fall
        // back to writing a real, temporary probe file under packages/engine/src.
        tempFile = join('packages', 'engine', 'src', `__lint-guard-probe-${process.pid}.ts`);
        const absolute = join(repoRoot, tempFile);
        writeFileSync(absolute, "import 'electron';\n", 'utf8');
        results = await eslint.lintFiles([tempFile]);
        restrictedImportError = results.flatMap((r) => r.messages).find((m) => m.ruleId === 'no-restricted-imports');
      }

      expect(restrictedImportError).toBeDefined();
    } finally {
      if (tempFile !== undefined) {
        rmSync(join(repoRoot, tempFile), { force: true });
      }
    }
  });
});
