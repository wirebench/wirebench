import { afterEach, describe, expect, it, vi } from 'vitest';
import { callOp } from '../../../src/ops/call.js';
import { runOp } from '../../../src/ops/context.js';
import { addEnvironment, removeTempDirs, soapProject, startServer } from './helpers.js';
import type { TestServer } from './helpers.js';

// The argument check refuses what the bridge would note on its own, so the bridge is made to note one.
vi.mock('@wirebench/engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@wirebench/engine')>();
  return {
    ...actual,
    envelopeFromJson: (...args: Parameters<typeof actual.envelopeFromJson>) => {
      const built = actual.envelopeFromJson(...args);
      return { ...built, notes: [...built.notes, '/note: the form has no repeat here; left out'] };
    },
  };
});

const ADD_RESPONSE =
  '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body>' +
  '<c:AddResponse xmlns:c="urn:wirebench:calculator"><c:result>5</c:result></c:AddResponse>' +
  '</soapenv:Body></soapenv:Envelope>';

const servers: TestServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await removeTempDirs();
});

describe('op call, write notes', () => {
  it('returns the notes the envelope met while it was written, with the response ones', async () => {
    const fixture = await soapProject();
    const server = await startServer(() => ({
      headers: { 'Content-Type': 'text/xml' },
      body: ADD_RESPONSE.replace(/AddResponse/g, 'Other'),
    }));
    servers.push(server);
    await addEnvironment(fixture.dir, 'local', { CalculatorService: server.url });
    const result = await runOp(
      callOp,
      { tool: 'calculator_service_add', ref: 'CalculatorService/Add', args: { environment: 'local', a: 1, b: 2 } },
      fixture.base(),
    );
    expect(result.notes).toEqual([
      '/note: the form has no repeat here; left out',
      expect.stringContaining('kept as its XML') as unknown,
    ]);
  });
});
