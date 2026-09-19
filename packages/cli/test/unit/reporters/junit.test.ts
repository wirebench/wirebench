import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
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
    expect(attributesOf(errors[0]!)).toMatchObject({ type: 'unresolved-properties' });
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
});
