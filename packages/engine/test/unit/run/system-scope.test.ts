/**
 * A run's `${#System#…}` scope (#343): the host may supply its own, so a server running a schedule
 * never lets a project read the server's environment.
 */
import { describe, expect, it } from 'vitest';
import { createProject } from '#core/project/model';
import type { Environment, Project } from '#core/project/model';
import { expand } from '#core/project/properties';
import { scopesFor, type RunContext } from '#core/run/context';
import { createWorkspace } from '#core/workspace/model';
import { testHost } from '../../helpers/send-host.js';

const environment: Environment = {
  id: 'dev',
  name: 'dev',
  slug: 'dev',
  order: 0,
  endpoints: {},
  properties: {},
  disabledProperties: [],
};
const project: Project = { ...createProject('P', { id: 'p1' }), environments: [environment] };

function context(extra: Partial<RunContext> = {}): RunContext {
  return { project, projectDir: '/tmp/p', environmentId: 'dev', overrides: {}, host: testHost(), ...extra };
}

const VARIABLE = 'WIREBENCH_TEST_SYSTEM_SCOPE';

describe('scopesFor with a supplied system scope', () => {
  it('reads the process environment when the run supplies none', () => {
    process.env[VARIABLE] = 'from-process';
    try {
      expect(expand(`\${#System#${VARIABLE}}`, scopesFor(context())).text).toBe('from-process');
    } finally {
      delete process.env[VARIABLE];
    }
  });

  it('reads only the supplied scope: an unset name stays unresolved, never the process value', () => {
    process.env[VARIABLE] = 'from-process';
    try {
      expect(expand(`\${#System#${VARIABLE}}`, scopesFor(context({ system: {} }))).text).toBe(
        `\${#System#${VARIABLE}}`,
      );
      expect(expand(`\${#System#${VARIABLE}}`, scopesFor(context({ system: { [VARIABLE]: 'given' } }))).text).toBe(
        'given',
      );
    } finally {
      delete process.env[VARIABLE];
    }
  });

  it('applies inside a workspace too', () => {
    process.env[VARIABLE] = 'from-process';
    try {
      const workspace = { workspace: createWorkspace('W'), projectSlug: 'p' };
      const workspaced: RunContext = {
        project,
        projectDir: '/tmp/p',
        overrides: {},
        host: testHost(),
        workspace,
        system: {},
      };
      expect(expand(`\${#System#${VARIABLE}}`, scopesFor(workspaced)).text).toBe(`\${#System#${VARIABLE}}`);
    } finally {
      delete process.env[VARIABLE];
    }
  });

  it('reports a system value it reads from the supplied scope, for masking', () => {
    const reported: string[] = [];
    const scopes = scopesFor(
      context({
        system: { [VARIABLE]: 'a-long-system-value' },
        host: { ...testHost(), onSecretValue: (value) => reported.push(value) },
      }),
    );
    expand(`\${#System#${VARIABLE}}`, scopes);
    expect(reported).toContain('a-long-system-value');
  });
});
