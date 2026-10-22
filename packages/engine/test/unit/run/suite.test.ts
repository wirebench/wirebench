/**
 * `runSuite` and `selectSuite` (#343): `wirebench run`'s selection and run loop as a library, shared
 * by the CLI and a server running a schedule. The CLI's own tests are the parity oracle; these pin
 * the library's contract with the echo protocol, which reaches no network.
 */
import { describe, expect, it } from 'vitest';
import { unavailableCaptureSource } from '#core/assert/capture-source';
import { isWirebenchError } from '#core/errors';
import { createProject } from '#core/project/model';
import type { Environment, Project } from '#core/project/model';
import { createProtocolRegistry } from '#core/protocol/registry';
import { BUILTIN_PROTOCOLS, SCRIPTS_FEATURE } from '../../../src/protocols.js';
import type { RunContext } from '#core/run/context';
import { planIterations } from '#core/run/iterations';
import { maskRequestResult } from '#core/run/mask';
import type { RequestResult } from '#core/run/run';
import { runSuite, selectSuite } from '#core/run/suite';
import type { RunSuiteOptions, SuiteSelection } from '#core/run/suite';
import { echoApi, echoProtocol, echoRequest, withEchoApis } from '../../helpers/echo-protocol.js';

const registry = createProtocolRegistry([...BUILTIN_PROTOCOLS, echoProtocol], { features: [SCRIPTS_FEATURE] });

function environment(name: string): Environment {
  return { id: name, name, slug: name, order: 0, endpoints: {}, properties: { who: name }, disabledProperties: [] };
}

const passes = echoRequest('Passes', '{"who":"${who}"}', {
  assertions: [{ type: 'match', language: 'jsonpath', expression: '$.who', equals: 'staging' }],
});
const fails = echoRequest('Fails', '{"who":"${who}"}', {
  assertions: [{ type: 'match', language: 'jsonpath', expression: '$.who', equals: 'nobody' }],
});

function project(requests = [passes, fails], environments = [environment('staging')]): Project {
  return withEchoApis({ ...createProject('Suite', { id: 'p-suite' }), environments }, [echoApi('Mirror', 0, requests)]);
}

function context(p: Project, extra: Partial<RunContext> = {}): Omit<RunContext, 'scripting'> {
  return {
    project: p,
    projectDir: '/nowhere',
    environmentId: 'staging',
    overrides: {},
    host: { getSecret: () => Promise.resolve(undefined) },
    registry,
    ...extra,
  };
}

function options(selection: SuiteSelection, extra: Partial<RunSuiteOptions> = {}): RunSuiteOptions {
  return {
    selection,
    plan: planIterations({}),
    bail: false,
    requireAssertions: false,
    captures: unavailableCaptureSource('no capture server in this test'),
    containsKnownSecret: () => false,
    onSecretValue: () => undefined,
    ...extra,
  };
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return isWirebenchError(error) ? error.code : 'not-a-wirebench-error';
  }
  return undefined;
}

describe('selectSuite', () => {
  it('picks the named environment and every request when there are no selectors', () => {
    const selection = selectSuite(project(), undefined, { environment: 'staging', select: [] }, registry);
    expect(selection.environment?.name).toBe('staging');
    expect(selection.selected.map((s) => s.path)).toEqual(['Mirror/Passes', 'Mirror/Fails']);
    expect(selection.sequences).toBeUndefined();
  });

  it('refuses what would make the run test nothing, with a code', () => {
    expect(codeOf(() => selectSuite(project(), undefined, { select: [] }, registry))).toBe('environment-required');
    expect(codeOf(() => selectSuite(project(), undefined, { environment: 'prod', select: [] }, registry))).toBe(
      'environment-not-found',
    );
    expect(
      codeOf(() => selectSuite(project(), undefined, { environment: 'staging', select: ['Nope'] }, registry)),
    ).toBe('selector-unmatched');
    expect(codeOf(() => selectSuite(project([], []), undefined, { select: [] }, registry))).toBe('nothing-to-run');
    expect(
      codeOf(() =>
        selectSuite(project(), undefined, { environment: 'staging', select: [], sequences: ['X'] }, registry),
      ),
    ).toBe('sequence-not-found');
  });
});

describe('runSuite', () => {
  it('runs the selection and reports each request as it finishes', async () => {
    const p = project();
    const done: RequestResult[] = [];
    const outcome = await runSuite(
      context(p),
      options(selectSuite(p, undefined, { environment: 'staging', select: [] }, registry), {
        onRequestDone: (r) => done.push(r),
      }),
    );
    expect(outcome.kind).toBe('ran');
    if (outcome.kind !== 'ran') return;
    expect(outcome.result.summary).toMatchObject({ total: 2, passed: 1, failed: 1, errored: 0, skipped: 0 });
    expect(outcome.result.environment).toBe('staging');
    expect(done.map((r) => r.outcome)).toEqual(['passed', 'failed']);
  });

  it('under bail, skips what follows a failure', async () => {
    const p = project([fails, passes]);
    const outcome = await runSuite(
      context(p),
      options(selectSuite(p, undefined, { environment: 'staging', select: [] }, registry), { bail: true }),
    );
    expect(outcome.kind === 'ran' && outcome.result.requests.map((r) => r.outcome)).toEqual(['failed', 'skipped']);
  });

  it('runs each iteration of a data-driven plan and tags its requests', async () => {
    const p = project([passes]);
    const outcome = await runSuite(
      context(p),
      options(selectSuite(p, undefined, { environment: 'staging', select: [] }, registry), {
        plan: planIterations({ rows: [{ a: '1' }, { a: '2' }] }),
      }),
    );
    expect(outcome.kind === 'ran' && outcome.result.summary.iterations).toEqual({ planned: 2, run: 2 });
  });

  it('marks everything skipped when the signal has already stopped the run', async () => {
    const p = project();
    const controller = new AbortController();
    controller.abort();
    const outcome = await runSuite(
      context(p, { signal: controller.signal }),
      options(selectSuite(p, undefined, { environment: 'staging', select: [] }, registry)),
    );
    expect(outcome.kind === 'ran' && outcome.result.requests.map((r) => r.outcome)).toEqual(['skipped', 'skipped']);
  });

  it('refuses a script that does not check, before anything is sent', async () => {
    const broken = echoRequest('Broken', 'x', {
      scripts: { api: 'wirebench', enabled: true, secrets: [], pre: { text: 'wirebench.nope.call();' } },
    });
    const p = project([broken]);
    const sent: RequestResult[] = [];
    const outcome = await runSuite(
      context(p),
      options(selectSuite(p, undefined, { environment: 'staging', select: [] }, registry), {
        onRequestDone: (r) => sent.push(r),
      }),
    );
    expect(outcome.kind).toBe('scripts-refused');
    expect(sent).toEqual([]);
  });
});

describe('maskRequestResult', () => {
  it('masks assertion text and error messages', () => {
    const masked = maskRequestResult(
      {
        path: 'A/b',
        group: 'A',
        name: 'b',
        protocol: 'echo',
        outcome: 'failed',
        unasserted: false,
        assertions: [{ type: 'status', label: 'has s3cret', outcome: 'failed', actual: 's3cret' }],
        error: { code: 'x', message: 'saw s3cret', details: { deep: ['s3cret'] } },
      },
      (text) => text.replaceAll('s3cret', '***'),
    );
    expect(JSON.stringify(masked)).not.toContain('s3cret');
  });
});
