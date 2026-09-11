// @vitest-environment node
import { fileURLToPath } from 'node:url';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { importDefinition } from '@wirebench/engine';
import type { ImportResult } from '@wirebench/engine';
import { registerValidateChannels } from '../src/main/ipc/validate.js';
import type { EngineService } from '../src/main/engine-service.js';
import type { ValidateChannelProject } from '../src/main/ipc/validate.js';

const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (event: unknown, payload: unknown) => Promise<unknown>) => {
      handlers.set(name, handler);
    },
  },
}));

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

function invoke(channel: string, payload: unknown): Promise<unknown> {
  const handler = handlers.get(channel);
  if (handler === undefined) {
    throw new Error(`${channel} was never registered`);
  }
  return handler({ sender: {} }, payload);
}

type Result =
  | { ok: true; value: { problems: { code: string; line?: number }[]; durationMs: number } }
  | {
      ok: false;
      error: { code: string; message: string };
    };

const envelope = (body: string) =>
  [
    '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tem="http://tempuri.org/">',
    '   <soapenv:Header/>',
    '   <soapenv:Body>',
    body,
    '   </soapenv:Body>',
    '</soapenv:Envelope>',
  ].join('\n');

const VALID_ADD = envelope('      <tem:Add><tem:intA>1</tem:intA><tem:intB>2</tem:intB></tem:Add>');

describe('validate.message IPC', () => {
  let calculator: ImportResult;

  beforeAll(async () => {
    calculator = await importDefinition({
      kind: 'file',
      path: `${repoRoot}fixtures/wsdl/public/calculator/service.wsdl`,
    });
  });

  const project = (target: ReturnType<ValidateChannelProject['validationTargetFor']>): ValidateChannelProject => ({
    validationTargetFor: () => target,
  });

  const engine = { resultFor: () => calculator } as unknown as EngineService;

  const savedTarget = {
    interfaceId: 'iface-1',
    bindingName: '{http://tempuri.org/}CalculatorSoap',
    operationName: 'Add',
    envelopeXml: VALID_ADD,
  };

  beforeEach(() => {
    handlers.clear();
  });

  it('reports nothing for a valid saved envelope', async () => {
    registerValidateChannels(engine, project(savedTarget));
    const result = (await invoke('validate.message', { requestId: 'req-1', direction: 'request' })) as Result;
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.problems).toEqual([]);
      expect(result.value.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('validates the xml the renderer sends instead of the saved envelope', async () => {
    registerValidateChannels(engine, project(savedTarget));
    const result = (await invoke('validate.message', {
      requestId: 'req-1',
      direction: 'request',
      xml: envelope('      <tem:Add><tem:intA>abc</tem:intA><tem:intB>2</tem:intB></tem:Add>'),
    })) as Result;
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.problems.map((problem) => problem.code)).toEqual(['schema-invalid']);
      expect(result.value.problems[0]?.line).toBe(4);
    }
  });

  it('cross-checks the request Content-Type against the binding version', async () => {
    registerValidateChannels(engine, project({ ...savedTarget, contentType: 'application/soap+xml' }));
    const result = (await invoke('validate.message', { requestId: 'req-1', direction: 'request' })) as Result;
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.problems.map((problem) => problem.code)).toEqual(['content-type-mismatch']);
    }
  });

  it('validates a response against the operation output', async () => {
    registerValidateChannels(engine, project(savedTarget));
    const result = (await invoke('validate.message', {
      requestId: 'req-1',
      direction: 'response',
      xml: envelope('      <tem:AddResponse><tem:AddResult>nope</tem:AddResult></tem:AddResponse>'),
    })) as Result;
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.problems).toHaveLength(1);
    }
  });

  it('fails with unknown-request when no saved request matches', async () => {
    registerValidateChannels(engine, project(undefined));
    const result = (await invoke('validate.message', { requestId: 'nope', direction: 'request' })) as Result;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('unknown-request');
    }
  });

  it('fails with unknown-operation when the binding has no such operation', async () => {
    registerValidateChannels(engine, project({ ...savedTarget, operationName: 'Nope' }));
    const result = (await invoke('validate.message', { requestId: 'req-1', direction: 'request' })) as Result;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('unknown-operation');
    }
  });
});
