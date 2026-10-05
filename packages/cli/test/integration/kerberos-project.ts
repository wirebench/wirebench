/** A one-request REST project whose request uses Kerberos, saved with the engine. */
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

/** Env for a CLI child process that cannot load the Kerberos binding (see the fixture). */
export const NO_KERBEROS_ENV = {
  NODE_OPTIONS: `--require=${new URL('../fixtures/kerberos/no-binding.cjs', import.meta.url).pathname}`,
};
