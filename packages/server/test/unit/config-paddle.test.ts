/**
 * The Paddle settings (hosted edition spec §22.1, §22.5, §22.16; slice 7 Task 12): hosted mode only and required
 * there, the client token's prefix matching the environment, and the webhook secret a secret, read from a file with
 * `_FILE`, and never in a module's view of the configuration. Every value here is a placeholder.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, expectTypeOf, it } from 'vitest';
import {
  CONFIG_VARIABLES,
  ConfigError,
  describeConfig,
  forgetDatabaseUrls,
  loadConfig,
  moduleConfigOf,
  paddleProblems,
  type ModuleConfig,
} from '../../src/config.js';

const SECRET = 'pdl_ntfset_test_placeholder_secret_value';
const PADDLE = {
  WIREBENCH_SERVER_PADDLE_ENVIRONMENT: 'sandbox',
  WIREBENCH_SERVER_PADDLE_CLIENT_TOKEN: 'test_placeholdertoken',
  WIREBENCH_SERVER_PADDLE_TEAM_PRICE_ID: 'pri_test_team',
  WIREBENCH_SERVER_PADDLE_WEBHOOK_SECRET: SECRET,
};
const HOSTED = {
  mode: 'hosted',
  paddleEnvironment: 'sandbox',
  paddleClientToken: 'test_placeholdertoken',
  paddleTeamPriceId: 'pri_test_team',
  paddleWebhookSecret: SECRET,
} as const;
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

describe('the Paddle settings (spec §22.5)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-paddle-'));
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('are each refused on a self-hosted server, naming the variable and never its value', () => {
    const problems = problemsOf(PADDLE);
    expect(problems.map((p) => p.variable).sort()).toEqual(Object.keys(PADDLE).sort());
    for (const problem of problems) expect(problem.message).toMatch(/^control-plane-hosted-only: /);
    expect(JSON.stringify(problems)).not.toContain(SECRET);
  });

  it('are each required in hosted mode', () => {
    expect(paddleProblems(HOSTED)).toEqual([]);
    const missing = paddleProblems({ mode: 'hosted' });
    expect(missing.map((p) => p.variable).sort()).toEqual(Object.keys(PADDLE).sort());
    for (const problem of missing) expect(problem.message).toMatch(/^control-plane-paddle-missing: /);
    expect(paddleProblems({ mode: 'self-hosted' })).toEqual([]);
  });

  it("refuse a client token whose prefix is not the environment's", () => {
    expect(paddleProblems({ ...HOSTED, paddleEnvironment: 'production' })).toEqual([
      {
        variable: 'WIREBENCH_SERVER_PADDLE_CLIENT_TOKEN',
        message: expect.stringMatching(/^control-plane-paddle-token-environment: /) as unknown,
      },
    ]);
    expect(paddleProblems({ ...HOSTED, paddleEnvironment: 'production', paddleClientToken: 'live_x' })).toEqual([]);
  });

  it('check the shapes of the token and the price id', () => {
    const problems = problemsOf({
      WIREBENCH_SERVER_PADDLE_CLIENT_TOKEN: 'pk_nope',
      WIREBENCH_SERVER_PADDLE_TEAM_PRICE_ID: 'price 1',
      WIREBENCH_SERVER_PADDLE_ENVIRONMENT: 'staging',
    });
    expect(problems.map((p) => p.variable).sort()).toEqual([
      'WIREBENCH_SERVER_PADDLE_CLIENT_TOKEN',
      'WIREBENCH_SERVER_PADDLE_ENVIRONMENT',
      'WIREBENCH_SERVER_PADDLE_TEAM_PRICE_ID',
    ]);
  });

  it('keep the webhook secret a secret: config check says only whether it is set', () => {
    const variable = CONFIG_VARIABLES.find((v) => v.env === 'WIREBENCH_SERVER_PADDLE_WEBHOOK_SECRET');
    expect([variable?.secret, variable?.file]).toEqual([true, true]);
    for (const key of ['paddleEnvironment', 'paddleClientToken', 'paddleTeamPriceId'])
      expect(CONFIG_VARIABLES.find((v) => v.key === key)?.secret).toBe(false);
    const rows = describeConfig({ ...required, ...PADDLE });
    expect(rows.find((row) => row.variable === 'WIREBENCH_SERVER_PADDLE_WEBHOOK_SECRET')?.status).toBe('set');
    expect(JSON.stringify(rows)).not.toContain(SECRET);
  });

  it('read the webhook secret from _FILE, trimmed, and refuse it beside the variable or unreadable', () => {
    const file = join(dir, 'secret');
    writeFileSync(file, `${SECRET}\n`);
    const env = { WIREBENCH_SERVER_PADDLE_WEBHOOK_SECRET_FILE: file };
    // Read, then refused as hosted-only: the value got as far as the hosted rule.
    expect(problemsOf(env)).toEqual([
      {
        variable: 'WIREBENCH_SERVER_PADDLE_WEBHOOK_SECRET',
        message: expect.stringMatching(/^control-plane-hosted-only: /) as unknown,
      },
    ]);
    expect(describeConfig({ ...required, ...env }).find((r) => r.variable.endsWith('WEBHOOK_SECRET'))?.status).toBe(
      'set',
    );
    expect(problemsOf({ ...env, WIREBENCH_SERVER_PADDLE_WEBHOOK_SECRET: SECRET })).toEqual([
      {
        variable: 'WIREBENCH_SERVER_PADDLE_WEBHOOK_SECRET_FILE',
        message: expect.stringMatching(/is set beside/) as unknown,
      },
    ]);
    const missing = problemsOf({ WIREBENCH_SERVER_PADDLE_WEBHOOK_SECRET_FILE: join(dir, 'nope') });
    expect(missing).toEqual([
      { variable: 'WIREBENCH_SERVER_PADDLE_WEBHOOK_SECRET_FILE', message: 'names a file that cannot be read' },
    ]);
    expect(JSON.stringify(missing)).not.toContain(dir);
    expect(
      describeConfig({ ...required, WIREBENCH_SERVER_PADDLE_WEBHOOK_SECRET_FILE: join(dir, 'nope') }).find((r) =>
        r.variable.endsWith('WEBHOOK_SECRET'),
      )?.status,
    ).toBe('invalid');
  });

  it("keep the webhook secret out of a module's view, and forget it from the environment", () => {
    expectTypeOf<ModuleConfig>().not.toHaveProperty('paddleWebhookSecret');
    expectTypeOf<ModuleConfig>().toHaveProperty('paddleTeamPriceId');
    const config = { ...loadConfig(required, '0.0.0'), ...HOSTED };
    const view = moduleConfigOf(config);
    expect(Object.keys(view)).not.toContain('paddleWebhookSecret');
    expect(JSON.stringify(view)).not.toContain(SECRET);
    expect(view.paddleTeamPriceId).toBe('pri_test_team');
    const saved = process.env.WIREBENCH_SERVER_PADDLE_WEBHOOK_SECRET;
    process.env.WIREBENCH_SERVER_PADDLE_WEBHOOK_SECRET = SECRET;
    forgetDatabaseUrls();
    expect(process.env.WIREBENCH_SERVER_PADDLE_WEBHOOK_SECRET).toBeUndefined();
    if (saved !== undefined) process.env.WIREBENCH_SERVER_PADDLE_WEBHOOK_SECRET = saved;
  });
});
