import { describe } from 'vitest';
import type { SuiteAPI } from 'vitest';

/**
 * Gate for tests that perform real network I/O. Such tests only run when
 * `WIREBENCH_NETWORK_TESTS=1` is set in the environment (see `test:interop`),
 * so the default test run never touches the network.
 */
export const describeNetwork: SuiteAPI =
  process.env['WIREBENCH_NETWORK_TESTS'] === '1' ? describe : (describe.skip as SuiteAPI);
