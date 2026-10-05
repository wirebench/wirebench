import { describe } from 'vitest';

/** Runs only in the `kerberos-integration` CI job, which builds a realm first; skips, saying so, elsewhere. */
export const describeKerberos = (name: string, factory: () => void): void => {
  if (process.env['WIREBENCH_KERBEROS_TESTS'] === '1') {
    describe(name, factory);
    return;
  }
  console.warn(`Skipping "${name}": set WIREBENCH_KERBEROS_TESTS=1 after scripts/ci/kerberos-kdc.sh to run it.`);
  describe.skip(name, factory);
};
