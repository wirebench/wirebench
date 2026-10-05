/** A one-request REST project whose request uses Kerberos, saved with the engine. */
import { fileURLToPath } from 'node:url';
import { createApi, createProject, createRestRequest, saveProject } from '@wirebench/engine';

export async function writeKerberosProject(dir: string, baseUrl: string): Promise<void> {
  await saveProject(
    {
      ...createProject('Krb', { id: 'p-krb' }),
      apis: [
        {
          ...createApi('Svc', { id: 'api-svc', slug: 'svc', baseUrl }),
          requests: [
            createRestRequest('Call', {
              id: 'r1',
              slug: 'call',
              url: '/svc',
              auth: { type: 'kerberos' },
            }),
          ],
        },
      ],
    },
    dir,
  );
}

/**
 * Env for a CLI child process that cannot load the Kerberos binding (see the fixture). The path is
 * a file path, not a URL's percent-encoded one, and quoted so NODE_OPTIONS keeps a space in it.
 * Inside those quotes NODE_OPTIONS reads a backslash as an escape, so Windows separators become
 * forward slashes, which Windows accepts.
 */
export const NO_KERBEROS_ENV = {
  NODE_OPTIONS: `--require "${fileURLToPath(new URL('../fixtures/kerberos/no-binding.cjs', import.meta.url)).replaceAll('\\', '/')}"`,
};
