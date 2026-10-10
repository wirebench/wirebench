/**
 * The writer and the save go through the protocol modules (spec §5.2) and produce the bytes they
 * always did: every fixture project saves to what it was loaded from, and the files of a project
 * come out in the order they always had.
 */
import { cp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createGrpcApi, createGrpcRequest } from '../../../src/grpc/model.js';
import { loadProject } from '../../../src/project/load.js';
import type { Project } from '../../../src/project/model.js';
import { saveProject } from '../../../src/project/save.js';
import { projectFiles } from '../../../src/project/serialize.js';
import { createBuiltinRegistry } from '../../../src/protocols.js';
import { createApi, createRestRequest } from '../../../src/rest/model.js';
import { createWsApi, createWsRequest, createWsSavedMessage } from '../../../src/ws/model.js';
import { sampleProject, tempProjectDir } from './fixture.js';

const ENGINE_FIXTURES = join(import.meta.dirname, '..', '..', 'fixtures');
const CLI_FIXTURES = join(import.meta.dirname, '..', '..', '..', '..', 'cli', 'test', 'fixtures');

/** Every project folder committed as a fixture: the five format generations, and the CLI's runner project. */
const FIXTURE_PROJECTS: readonly (readonly [string, string])[] = [
  ['format-v1', join(ENGINE_FIXTURES, 'format-v1', 'project')],
  ['format-v2', join(ENGINE_FIXTURES, 'format-v2', 'project')],
  ['format-v3', join(ENGINE_FIXTURES, 'format-v3', 'project')],
  ['format-v4', join(ENGINE_FIXTURES, 'format-v4', 'project')],
  ['format-v5', join(ENGINE_FIXTURES, 'format-v5', 'project')],
  ['runner-project', join(CLI_FIXTURES, 'runner-project')],
];

function mixedProject(): Project {
  return {
    ...sampleProject(),
    containers: {
      ...sampleProject().containers,
      rest: [
        createApi('Shop', {
          id: 'A1',
          order: 2,
          baseUrl: 'https://shop.test',
          requests: [
            createRestRequest('Create', {
              id: 'R1',
              method: 'POST',
              url: '/items',
              body: { kind: 'raw', language: 'json', text: '{\n  "name": "Fido"\n}\n' },
            }),
          ],
        }),
      ],
      grpc: [
        createGrpcApi('Greeter', {
          id: 'G1',
          order: 3,
          target: 'localhost:50051',
          requests: [createGrpcRequest('Hello', { id: 'GR1', service: 'demo.Greeter', method: 'SayHello' })],
        }),
      ],
      websocket: [
        createWsApi('Chat', {
          id: 'W1',
          order: 4,
          url: 'wss://chat.test',
          requests: [
            createWsRequest('Feed', {
              id: 'WR1',
              url: '/feed',
              messages: [createWsSavedMessage('Ping', { id: 'M1', content: '{"type":"ping"}' })],
            }),
          ],
        }),
      ],
    },
  };
}

describe('saving a fixture project', () => {
  it.each(FIXTURE_PROJECTS)(
    '%s: the first save touches only the manifest, the second nothing',
    async (_name, source) => {
      const dir = await tempProjectDir();
      await cp(source, dir, { recursive: true });

      const first = await saveProject((await loadProject(dir)).project, dir);
      expect(first.written.filter((file) => file !== 'wirebench.yaml')).toEqual([]);
      expect(first.removed).toEqual([]);

      const second = await saveProject((await loadProject(dir)).project, dir);
      expect(second.written).toEqual([]);
      expect(second.removed).toEqual([]);

      await rm(dir, { recursive: true, force: true });
    },
  );
});

describe('the files of a project', () => {
  it('list core’s and every protocol’s in the order they always had', () => {
    const keys = [...projectFiles(mixedProject()).keys()];
    const first = (prefix: string): number => keys.findIndex((key) => key.startsWith(prefix));

    expect(keys[0]).toBe('wirebench.yaml');
    const order = ['environments/', 'interfaces/', 'apis/Shop/', 'apis/Greeter/', 'apis/Chat/', 'wss/'].map(first);
    expect(order.every((index) => index > 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('are the same through a registry passed in and through the default one', () => {
    const project = mixedProject();

    expect([...projectFiles(project, { registry: createBuiltinRegistry() })]).toEqual([...projectFiles(project)]);
  });

  it('a save through a registry passed in writes what the default one writes', async () => {
    const dir = await tempProjectDir();
    await saveProject(mixedProject(), dir);

    const again = await saveProject(mixedProject(), dir, { registry: createBuiltinRegistry() });

    expect(again.written).toEqual([]);
    expect(again.removed).toEqual([]);
    await rm(dir, { recursive: true, force: true });
  });
});
