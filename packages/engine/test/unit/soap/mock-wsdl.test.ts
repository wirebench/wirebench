/**
 * A SOAP mock serves its WSDL (spec §Serving the WSDL): every document of the bundle, reachable from
 * `?wsdl` by following the rewritten imports and includes, with the service address pointing at the
 * mock — and nothing but bundle documents, by index.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createMock } from '../../../src/mock/model.js';
import { startMock } from '../../../src/mock/server.js';
import type { RunningMock } from '../../../src/mock/server.js';
import { mockProject, wsdlFixture } from '../mock/fixture.js';

const running: RunningMock[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((m) => m.stop()));
});

async function start(): Promise<RunningMock> {
  const mock = createMock(
    'Echo',
    { containerId: 'I1', binding: '{urn:wb:nested}EchoBinding' },
    { id: 'M1', path: '/echo' },
  );
  const { dir, project } = await mockProject({
    wsdl: wsdlFixture('crafted/nested-imports/service.wsdl'),
    mocks: [mock],
  });
  const started = await startMock({ project, root: dir, mockId: 'M1' });
  running.push(started);
  return started;
}

/** Every `location` / `schemaLocation` attribute value in `xml`. */
function references(xml: string): string[] {
  return [...xml.matchAll(/(?:schemaLocation|location)="([^"]+)"/g)].map((match) => match[1] ?? '');
}

describe('a SOAP mock serving its WSDL', () => {
  it('rewrites the address and every import so the whole contract comes from the mock', async () => {
    const m = await start();
    const root = await fetch(`${m.url}?wsdl`);
    expect(root.status).toBe(200);
    expect(root.headers.get('content-type')).toBe('text/xml; charset=utf-8');
    const text = await root.text();
    expect(text).toContain(`location="${m.url}"`);
    expect(text).not.toContain('example.invalid');

    const seen = new Set<string>();
    const queue = references(text).filter((ref) => ref !== m.url);
    while (queue.length > 0) {
      const next = queue.shift() ?? '';
      if (seen.has(next)) continue;
      seen.add(next);
      expect(next.startsWith(`${m.url}?`)).toBe(true);
      const reply = await fetch(next);
      expect(reply.status).toBe(200);
      queue.push(...references(await reply.text()));
    }
    // types.wsdl, common.xsd and base.xsd.
    expect(seen.size).toBe(3);
  });

  it('serves bundle documents by index only', async () => {
    const m = await start();
    expect((await fetch(`${m.url}?WSDL`)).status).toBe(200);
    expect((await fetch(`${m.url}?xsd=99`)).status).toBe(404);
    expect((await fetch(`${m.url}?xsd=../../etc/passwd`)).status).toBe(404);
    expect((await fetch(`${m.url}?xsd=0`)).status).toBe(404);
  });
});
