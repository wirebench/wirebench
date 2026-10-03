import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RequestResult, RunResult } from '@wirebench/engine';
import { parseXmlDocument, validateAgainstXsd } from '@wirebench/engine/test-helpers';
import { describe, expect, it } from 'vitest';
import { renderJunit } from '../../../src/reporters/junit.js';
import { SAMPLE_RESULT } from './sample-result.js';

const XSD_PATH = join(import.meta.dirname, '..', '..', 'fixtures', 'junit.xsd');

type XmlDocument = ReturnType<typeof parseXmlDocument>;
type XmlElement = NonNullable<XmlDocument['documentElement']>;

function attributesOf(element: XmlElement): Record<string, string> {
  const out: Record<string, string> = {};
  for (let index = 0; index < element.attributes.length; index += 1) {
    const attribute = element.attributes.item(index);
    if (attribute !== null) {
      out[attribute.name] = attribute.value;
    }
  }
  return out;
}

function childrenNamed(parent: XmlElement, name: string): XmlElement[] {
  const out: XmlElement[] = [];
  for (let index = 0; index < parent.childNodes.length; index += 1) {
    const node = parent.childNodes.item(index);
    if (node !== null && node.nodeType === 1 && (node as XmlElement).tagName === name) {
      out.push(node as XmlElement);
    }
  }
  return out;
}

const baselineDiffers: RequestResult = {
  path: 'demo/diff',
  group: 'demo',
  name: 'diff',
  protocol: 'rest',
  outcome: 'failed',
  status: 200,
  durationMs: 5,
  unasserted: false,
  assertions: [
    { type: 'baseline', label: '1 difference from the baseline', outcome: 'failed', message: 'changed /a: 1 → 2' },
  ],
  baseline: {
    status: 'differs',
    format: 'json',
    ignored: 0,
    changes: [{ kind: 'changed', path: '/a', expected: '1', actual: '2' }],
  },
};

const baselineMissing: RequestResult = {
  path: 'demo/new',
  group: 'demo',
  name: 'new',
  protocol: 'rest',
  outcome: 'passed',
  status: 200,
  durationMs: 5,
  unasserted: false,
  assertions: [],
  baseline: { status: 'missing' },
};

const runOf = (requests: RequestResult[]): RunResult => ({
  startedAt: '2026-10-03T10:00:00.000Z',
  summary: {
    total: requests.length,
    passed: requests.filter((r) => r.outcome === 'passed').length,
    failed: requests.filter((r) => r.outcome === 'failed').length,
    errored: 0,
    skipped: 0,
    durationMs: 10,
  },
  requests,
});

describe('renderJunit', () => {
  const xml = renderJunit(SAMPLE_RESULT);
  const doc = parseXmlDocument(xml);
  const root = doc.documentElement as XmlElement;

  it('has a root <testsuites> with totals and a duration in seconds to three decimals', () => {
    expect(root.tagName).toBe('testsuites');
    expect(attributesOf(root)).toMatchObject({ tests: '4', failures: '1', errors: '1', skipped: '1' });
    expect(attributesOf(root)['time']).toBe('1.234');
  });

  it('has one <testsuite> per group, each with its own counts', () => {
    const suites = childrenNamed(root, 'testsuite');
    expect(suites).toHaveLength(2);

    const orders = suites.find((suite) => attributesOf(suite)['name'] === 'Orders/PlaceOrder');
    expect(orders).toBeDefined();
    expect(attributesOf(orders!)).toMatchObject({ tests: '2', failures: '1', errors: '0', skipped: '0' });

    const users = suites.find((suite) => attributesOf(suite)['name'] === 'demo/users');
    expect(users).toBeDefined();
    expect(attributesOf(users!)).toMatchObject({ tests: '2', failures: '0', errors: '1', skipped: '1' });
  });

  it('gives each request its own <testcase>, classname = group, time in seconds', () => {
    const suites = childrenNamed(root, 'testsuite');
    const orders = suites.find((suite) => attributesOf(suite)['name'] === 'Orders/PlaceOrder')!;
    const cases = childrenNamed(orders, 'testcase');
    expect(cases.map((testcase) => attributesOf(testcase)['name'])).toEqual(['Smoke', 'Bulk']);
    expect(attributesOf(cases[0]!)).toMatchObject({ classname: 'Orders/PlaceOrder', name: 'Smoke', time: '0.042' });
  });

  it('gives the failed case one <failure> per failed assertion, with message and type', () => {
    const suites = childrenNamed(root, 'testsuite');
    const orders = suites.find((suite) => attributesOf(suite)['name'] === 'Orders/PlaceOrder')!;
    const bulk = childrenNamed(orders, 'testcase').find((testcase) => attributesOf(testcase)['name'] === 'Bulk')!;
    const failures = childrenNamed(bulk, 'failure');
    expect(failures).toHaveLength(2);
    expect(attributesOf(failures[0]!)).toMatchObject({
      message: 'status is 200 — expected 200, actual 500',
      type: 'status',
    });
    expect(attributesOf(failures[1]!)).toMatchObject({
      message: 'no SOAP fault — soap:Server — out of stock',
      type: 'soap-fault',
    });
  });

  it('gives the errored case an <error> with the error code and message', () => {
    const suites = childrenNamed(root, 'testsuite');
    const users = suites.find((suite) => attributesOf(suite)['name'] === 'demo/users')!;
    const list = childrenNamed(users, 'testcase').find((testcase) => attributesOf(testcase)['name'] === 'list')!;
    const errors = childrenNamed(list, 'error');
    expect(errors).toHaveLength(1);
    expect(attributesOf(errors[0]!)).toMatchObject({ type: 'rest-unresolved-properties' });
    expect(attributesOf(errors[0]!)['message']).toContain('${baseUrl}');
  });

  it('gives the skipped case a <skipped/>', () => {
    const suites = childrenNamed(root, 'testsuite');
    const users = suites.find((suite) => attributesOf(suite)['name'] === 'demo/users')!;
    const create = childrenNamed(users, 'testcase').find((testcase) => attributesOf(testcase)['name'] === 'create')!;
    expect(childrenNamed(create, 'skipped')).toHaveLength(1);
  });

  it('carries <system-out> only for the case that has an exchange (the failed one, in this fixture)', () => {
    const suites = childrenNamed(root, 'testsuite');
    const orders = suites.find((suite) => attributesOf(suite)['name'] === 'Orders/PlaceOrder')!;
    const smoke = childrenNamed(orders, 'testcase').find((testcase) => attributesOf(testcase)['name'] === 'Smoke')!;
    const bulk = childrenNamed(orders, 'testcase').find((testcase) => attributesOf(testcase)['name'] === 'Bulk')!;
    expect(childrenNamed(smoke, 'system-out')).toHaveLength(0);
    expect(childrenNamed(bulk, 'system-out')).toHaveLength(1);
    expect(bulk.textContent).toContain('<Envelope/>');

    const users = suites.find((suite) => attributesOf(suite)['name'] === 'demo/users')!;
    const list = childrenNamed(users, 'testcase').find((testcase) => attributesOf(testcase)['name'] === 'list')!;
    expect(childrenNamed(list, 'system-out')).toHaveLength(0);
  });

  it('validates against the project-authored minimal JUnit XSD', async () => {
    const xsd = await readFile(XSD_PATH, 'utf8');
    const result = await validateAgainstXsd(xml, xsd);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('validates a run with a baseline failure and a missing baseline against the XSD', async () => {
    const xsd = await readFile(XSD_PATH, 'utf8');
    const result = await validateAgainstXsd(renderJunit(runOf([baselineDiffers, baselineMissing])), xsd);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('reports an errored assertion as an error of its own type', () => {
    const result: RunResult = {
      startedAt: '2026-09-29T10:00:00.000Z',
      summary: { total: 1, passed: 0, failed: 0, errored: 1, skipped: 0, durationMs: 10 },
      requests: [
        {
          path: 'Shop/Pay',
          group: 'Shop',
          name: 'Pay',
          protocol: 'rest',
          outcome: 'errored',
          status: 201,
          durationMs: 5,
          assertions: [
            { type: 'status', label: 'status is 200', outcome: 'failed', expected: '200', actual: '201' },
            {
              type: 'callback',
              label: 'callback orders-hook',
              outcome: 'errored',
              message: 'set WIREBENCH_SERVER_URL and WIREBENCH_SERVER_TOKEN to check callbacks',
            },
          ],
          unasserted: false,
        },
      ],
    };
    const xml = renderJunit(result);
    expect(xml).toContain(
      '<failure message="status is 200 — expected 200, actual 201" type="status"/><error type="callback" message="callback orders-hook — set WIREBENCH_SERVER_URL and WIREBENCH_SERVER_TOKEN to check callbacks"/>',
    );
  });

  it('reports only the request’s own error when the request itself errored', () => {
    const result: RunResult = {
      startedAt: '2026-09-29T10:00:00.000Z',
      summary: { total: 1, passed: 0, failed: 0, errored: 1, skipped: 0, durationMs: 10 },
      requests: [
        {
          path: 'Shop/Pay',
          group: 'Shop',
          name: 'Pay',
          protocol: 'rest',
          outcome: 'errored',
          assertions: [
            {
              type: 'callback',
              label: 'callback orders-hook',
              outcome: 'errored',
              message: 'no Wirebench Server is configured to check callbacks',
            },
          ],
          error: { code: 'network-error', message: 'Could not reach https://shop.example.test' },
          unasserted: false,
        },
      ],
    };
    const xml = renderJunit(result);
    expect(xml).toContain('<error type="network-error" message="Could not reach https://shop.example.test"/>');
    expect(xml.match(/<error /g)).toHaveLength(1);
    expect(xml).not.toContain('type="callback"');
  });

  it('renders a baseline difference as a failure with the change list as its body', () => {
    expect(renderJunit(runOf([baselineDiffers]))).toContain(
      '<failure message="1 difference from the baseline" type="baseline">changed /a: 1 → 2</failure>',
    );
  });

  it('notes a missing baseline in system-out', () => {
    expect(renderJunit(runOf([baselineMissing]))).toContain('<system-out>no baseline saved</system-out>');
  });
});
