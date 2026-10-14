import type { RequestResult } from '@wirebench/engine';
import { describe, expect, it } from 'vitest';
import { explainFailure, explainMissingSecret } from '../../src/secret-advice.js';

const errored = (error: NonNullable<RequestResult['error']>): RequestResult => ({
  path: 'Echo/Echo/Secured hello',
  group: 'Echo',
  name: 'Secured hello',
  protocol: 'soap',
  outcome: 'errored',
  assertions: [],
  unasserted: false,
  error,
});

describe('explainMissingSecret', () => {
  it('rewrites a missing WS-Security password, which carries no …Env name, to its ref variable', () => {
    // Exactly what the engine raises for a username token whose password the run was not given.
    const raw = errored({
      code: 'secret-missing',
      message: 'Secret sec_wss was not supplied to this run.',
      details: { ref: 'sec_wss' },
    });
    const needs = [{ ref: 'sec_wss', purpose: 'WS-Security password for "svc"' }];
    expect(explainMissingSecret(raw, needs).error?.message).toBe(
      'Set WIREBENCH_SECRET_SEC_WSS to run "Echo/Echo/Secured hello".',
    );
  });

  it('names the declared variable first when the ref has one', () => {
    const raw = errored({ code: 'secret-missing', message: 'x', details: { ref: 'sec_demo' } });
    const needs = [{ ref: 'sec_demo', envName: 'DEMO_PASSWORD', purpose: 'basic password for "svc"' }];
    expect(explainMissingSecret(raw, needs).error?.message).toBe(
      'Set WIREBENCH_SECRET_DEMO_PASSWORD (or WIREBENCH_SECRET_SEC_DEMO) to run "Echo/Echo/Secured hello".',
    );
  });

  it('rewrites a missing webhook signing secret to its CI variable', () => {
    const raw = errored({
      code: 'webhook-signing-secret',
      message: 'Signing is set on the Webhooks collection but its secret is not set',
      details: { from: 'collection', ref: 'webhook-signing:HOOKS_SIGNING' },
    });
    const needs = [
      {
        ref: 'webhook-signing:HOOKS_SIGNING',
        envName: 'HOOKS_SIGNING',
        purpose: 'webhook signing secret (the Webhooks collection)',
      },
    ];
    expect(explainMissingSecret(raw, needs).error?.message).toBe(
      'Set WIREBENCH_SECRET_HOOKS_SIGNING to run "Echo/Echo/Secured hello".',
    );
  });

  it('leaves any other error alone', () => {
    const raw = errored({ code: 'keystore-unreadable', message: 'unreadable', details: { id: 'k' } });
    expect(explainMissingSecret(raw, [])).toBe(raw);
  });
});

describe('explainFailure', () => {
  it('adds the --allow-commands advice to an unapproved MCP command, keeping what the engine said', () => {
    const raw = errored({
      code: 'mcp-command-unapproved',
      message: 'The MCP server "Local" runs the command "node server.js", which has not been approved',
    });
    expect(explainFailure(raw, []).error?.message).toBe(
      'The MCP server "Local" runs the command "node server.js", which has not been approved. ' +
        'Pass --allow-commands to let MCP servers run their local commands.',
    );
  });

  it('still explains a missing secret, and leaves any other error alone', () => {
    const missing = errored({ code: 'secret-missing', message: 'x', details: { ref: 'sec_wss' } });
    expect(explainFailure(missing, [{ ref: 'sec_wss', purpose: 'p' }]).error?.message).toContain(
      'WIREBENCH_SECRET_SEC_WSS',
    );
    const other = errored({ code: 'timeout', message: 'slow' });
    expect(explainFailure(other, [])).toBe(other);
  });
});
