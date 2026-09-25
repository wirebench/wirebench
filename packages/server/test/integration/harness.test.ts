import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { GitCli } from '@wirebench/engine';
import type { ServerModule } from '../../src/context.js';
import { NO_HOOKS_DIR } from '../../src/repos/repo-store.js';
import { describeDb } from '../helpers/database.js';
import { identityHarness } from '../helpers/identity.js';

describeDb('identityHarness (sync spec R13)', () => {
  it('hands every module a hermetic ctx.git: the no-hooks directory and no global or system config', async () => {
    let git: GitCli | undefined;
    const probe: ServerModule = {
      name: 'server-sync',
      register: (_app, ctx) => {
        git = ctx.git;
        return Promise.resolve();
      },
    };
    const h = await identityHarness({ modules: [probe] });
    try {
      // GitCli passes `-c core.hooksPath=<hooksDir>` on every call, so this reads back its hooks dir.
      const hooksPath = await git!.run(h.dataDir, ['config', '--get', 'core.hooksPath']);
      expect(hooksPath.stdout.trim()).toBe(join(h.dataDir, NO_HOOKS_DIR));
      // The global config is a file that does not exist, so git refuses to list it: the developer's
      // ~/.gitconfig (user, hooks, aliases) can never reach a server test.
      await expect(git!.run(h.dataDir, ['config', '--global', '--list'])).rejects.toMatchObject({ code: 'git-failed' });
    } finally {
      await h.close();
    }
  });
});
