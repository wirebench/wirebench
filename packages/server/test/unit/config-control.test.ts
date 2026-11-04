/**
 * The control role's URL (hosted edition spec §22.1, §22.2): `WIREBENCH_SERVER_CONTROL_DATABASE_URL`, hosted mode
 * only, a secret, and never in a module's view of the configuration. Every value here is a placeholder.
 */
import { afterEach, describe, expect, expectTypeOf, it } from 'vitest';
import {
  CONFIG_VARIABLES,
  ConfigError,
  controlPlaneProblems,
  describeConfig,
  forgetDatabaseUrls,
  loadConfig,
  type ModuleConfig,
} from '../../src/config.js';

const VARIABLE = 'WIREBENCH_SERVER_CONTROL_DATABASE_URL';
const CONTROL_URL = 'postgres://wirebench_control:placeholder-pw@db/wirebench';

const required = {
  WIREBENCH_SERVER_DATABASE_URL: 'postgres://u:p@db/wirebench',
  WIREBENCH_SERVER_PUBLIC_URL: 'https://wirebench.example.com',
};

function problemsOf(env: Record<string, string>): readonly { variable: string; message: string }[] {
  try {
    loadConfig({ ...required, ...env }, '0.0.0');
  } catch (error) {
    if (error instanceof ConfigError) return error.problems;
    throw error;
  }
  return [];
}

describe('the control role URL', () => {
  const saved = process.env[VARIABLE];
  afterEach(() => {
    if (saved === undefined) delete process.env[VARIABLE];
    else process.env[VARIABLE] = saved;
  });

  it('is refused on a self-hosted server, naming the variable and never its value', () => {
    const problems = problemsOf({ [VARIABLE]: CONTROL_URL });
    expect(problems).toHaveLength(1);
    expect(problems[0]!.variable).toBe(VARIABLE);
    expect(problems[0]!.message).toMatch(/^control-plane-hosted-only: /);
    expect(JSON.stringify(problems)).not.toContain('placeholder-pw');
  });

  it('is unset, and fine, on a self-hosted server by default', () => {
    expect(loadConfig(required, '0.0.0').controlDatabaseUrl).toBeUndefined();
    expect(controlPlaneProblems({ mode: 'self-hosted', controlDatabaseUrl: undefined })).toEqual([]);
  });

  it('is required in hosted mode', () => {
    expect(controlPlaneProblems({ mode: 'hosted', controlDatabaseUrl: undefined })).toEqual([
      { variable: VARIABLE, message: expect.stringMatching(/^control-plane-control-url-missing: /) as unknown },
    ]);
    expect(controlPlaneProblems({ mode: 'hosted', controlDatabaseUrl: CONTROL_URL })).toEqual([]);
  });

  it('is a secret: config check says only whether it is set, and the README never prints it', () => {
    const variable = CONFIG_VARIABLES.find((v) => v.env === VARIABLE);
    expect([variable?.key, variable?.secret, variable?.required]).toEqual(['controlDatabaseUrl', true, false]);
    const rows = describeConfig({ ...required, [VARIABLE]: CONTROL_URL });
    expect(rows.find((row) => row.variable === VARIABLE)?.status).toBe('set');
    expect(JSON.stringify(rows)).not.toContain('placeholder-pw');
  });

  it('is not in ModuleConfig', () => {
    expectTypeOf<ModuleConfig>().not.toHaveProperty('controlDatabaseUrl');
    expectTypeOf<ModuleConfig>().not.toHaveProperty('databaseUrl');
  });

  it('is forgotten with the other database URLs, so no git child inherits it', () => {
    process.env[VARIABLE] = CONTROL_URL;
    forgetDatabaseUrls();
    expect(process.env[VARIABLE]).toBeUndefined();
  });
});
