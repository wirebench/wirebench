// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createInterface, createProject, createRequest, loadProject, saveProject } from '@wirebench/engine';
import type { Interface, Project } from '@wirebench/engine';
import { applyChange } from '../src/main/project-mutations.js';
import { findRequest } from '../src/main/project-wire.js';

const BINDING = '{http://tempuri.org/}CalculatorSoap';

let root: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wirebench-assertions-'));
});

afterEach(() => {
  if (root !== undefined) {
    rmSync(root, { recursive: true, force: true });
    root = undefined;
  }
});

function build(): Project {
  const iface: Interface = createInterface('Calculator', {
    id: 'iface-1',
    definitionUrl: 'http://example.test/service.wsdl',
    endpoints: [{ id: 'ep-1', name: 'Primary', url: 'http://a.test/soap', authMode: 'complement' }],
    operations: [
      {
        name: 'Add',
        bindingName: BINDING,
        slug: 'Add',
        order: 0,
        requests: [
          {
            ...createRequest('Request 1', {
              id: 'req-1',
              envelopeXml: '<Add/>',
              soapVersion: '1.1',
              endpointId: 'ep-1',
            }),
            assertions: [
              { type: 'status', equals: 200 },
              { type: 'sla', maxMs: 500 },
            ],
          },
        ],
      },
    ],
  });
  return { ...createProject('Demo', { id: 'proj-1' }), interfaces: [iface] };
}

describe('assertions survive a desktop mutation round trip', () => {
  it('are still there after load → rename → save → reload', async () => {
    const dir = root!;
    await saveProject(build(), dir);

    const { project: loaded, problems } = await loadProject(dir);
    expect(problems).toEqual([]);

    const { project: renamed } = await applyChange(
      loaded,
      { kind: 'update-request', requestId: 'req-1', patch: { name: 'Renamed request' } },
      { generate: () => Promise.reject(new Error('not needed')) },
    );
    const beforeSave = findRequest(renamed, 'req-1');
    expect(beforeSave?.request.name).toBe('Renamed request');
    expect(beforeSave?.request.assertions).toEqual([
      { type: 'status', equals: 200 },
      { type: 'sla', maxMs: 500 },
    ]);

    await saveProject(renamed, dir);
    const { project: reloaded, problems: reloadProblems } = await loadProject(dir);
    expect(reloadProblems).toEqual([]);
    const reloadedRequest = findRequest(reloaded, 'req-1');
    expect(reloadedRequest?.request.name).toBe('Renamed request');
    expect(reloadedRequest?.request.assertions).toEqual([
      { type: 'status', equals: 200 },
      { type: 'sla', maxMs: 500 },
    ]);
  });
});
