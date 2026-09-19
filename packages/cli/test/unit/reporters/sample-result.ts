import type { RunResult } from '@wirebench/engine';

/**
 * A fixed run covering every outcome, in two groups, shared by the reporter tests so each report
 * format is checked against the same run.
 */
export const SAMPLE_RESULT: RunResult = {
  startedAt: '2026-09-18T10:00:00.000Z',
  environment: 'local',
  summary: { total: 4, passed: 1, failed: 1, errored: 1, skipped: 1, durationMs: 1234 },
  requests: [
    {
      path: 'Orders/PlaceOrder/Smoke',
      group: 'Orders/PlaceOrder',
      name: 'Smoke',
      protocol: 'soap',
      outcome: 'passed',
      status: 200,
      durationMs: 41.6,
      assertions: [{ type: 'soap-fault', label: 'no SOAP fault', outcome: 'passed' }],
      unasserted: false,
    },
    {
      path: 'Orders/PlaceOrder/Bulk',
      group: 'Orders/PlaceOrder',
      name: 'Bulk',
      protocol: 'soap',
      outcome: 'failed',
      status: 500,
      durationMs: 120.2,
      assertions: [
        { type: 'status', label: 'status is 200', outcome: 'failed', expected: '200', actual: '500' },
        { type: 'soap-fault', label: 'no SOAP fault', outcome: 'failed', message: 'soap:Server — out of stock' },
        { type: 'sla', label: 'responds within 500 ms', outcome: 'passed' },
      ],
      unasserted: false,
      exchange: {
        request: 'POST /orders HTTP/1.1\r\n\r\n<Envelope/>',
        response: 'HTTP/1.1 500 Internal Server Error\r\n\r\n<Envelope><Fault/></Envelope>',
      },
    },
    {
      path: 'demo/users/list',
      group: 'demo/users',
      name: 'list',
      protocol: 'rest',
      outcome: 'errored',
      assertions: [],
      error: {
        code: 'unresolved-properties',
        message: '"demo/users/list" has property references nothing resolves: ${baseUrl}',
        details: { unresolved: ['${baseUrl}'] },
      },
      unasserted: false,
    },
    {
      path: 'demo/users/create',
      group: 'demo/users',
      name: 'create',
      protocol: 'rest',
      outcome: 'skipped',
      assertions: [],
      unasserted: true,
    },
  ],
};
