// @vitest-environment node
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceError } from '@wirebench/engine';
import { describe, expect, it, vi } from 'vitest';
import { SnippetsService, windowSnippets } from '../src/main/snippets-service.js';
import { sshListSnippetsResponseSchema } from '@wirebench/wire/snippets-wire';
import type { SnippetsFileWire } from '@wirebench/wire/snippets-wire';

const dir = () => mkdtempSync(join(tmpdir(), 'wb-snippets-'));

const FILE = `version: 1
packages:
  - id: deploy
    name: Deploy
    snippets:
      - id: restart-api
        name: Restart API
        tags: [deploy]
        script: sudo systemctl restart api
        confirm: true
snippets:
  - id: call-health
    name: Health with token
    variables:
      - name: path
        default: health
    script: 'curl -H "Authorization: Bearer \${secret:api_token}" https://localhost/\${path}'
`;

const ONE: SnippetsFileWire = {
  version: 1,
  packages: [],
  snippets: [{ id: 'uptime', name: 'Uptime', tags: [], variables: [], script: 'uptime', enter: true, confirm: false }],
};

describe('SnippetsService', () => {
  it('no workspace open is refused as workspace-not-open', async () => {
    await expect(new SnippetsService({ treeDir: () => undefined }).list()).rejects.toMatchObject({
      name: 'WirebenchError',
      code: 'workspace-not-open',
    });
  });

  it('a missing snippets.yaml is the empty file with no problems', async () => {
    expect(await new SnippetsService({ treeDir: () => dir() }).list()).toEqual({
      file: { version: 1, packages: [], snippets: [] },
      snippets: [],
      problems: [],
    });
  });

  it('lists the file and its flat list through the channel schema; secrets are names only', async () => {
    const d = dir();
    writeFileSync(join(d, 'snippets.yaml'), FILE);
    const listed = sshListSnippetsResponseSchema.parse(await new SnippetsService({ treeDir: () => d }).list());
    expect(listed.problems).toEqual([]);
    expect(listed.file.packages[0]?.snippets[0]).toEqual({
      id: 'restart-api',
      name: 'Restart API',
      tags: ['deploy'],
      variables: [],
      script: 'sudo systemctl restart api',
      enter: true,
      confirm: true,
    });
    expect(listed.snippets.map((s) => [s.id, s.packageId, s.secrets])).toEqual([
      ['restart-api', 'deploy', []],
      ['call-health', undefined, ['api_token']],
    ]);
    expect(listed.snippets[1]?.literalStart).toBe('curl -H "Authorization: Bearer ');
    expect(listed.snippets[1]?.revision).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a malformed file is one problem with its code and path, not a throw', async () => {
    const d = dir();
    writeFileSync(join(d, 'snippets.yaml'), 'version: 1\nsnippets:\n  - { id: Bad Id, name: x, script: ls }\n');
    const result = await new SnippetsService({ treeDir: () => d }).list();
    expect(result.snippets).toEqual([]);
    expect(result.problems).toEqual([
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- asymmetric matcher
      { code: 'snippets-invalid', message: expect.any(String), path: 'snippets[0].id' },
    ]);
  });

  it('an unreadable snippets.yaml is snippets-invalid naming the errno', async () => {
    const d = dir();
    mkdirSync(join(d, 'snippets.yaml')); // reading a directory fails with EISDIR
    await expect(new SnippetsService({ treeDir: () => d }).list()).rejects.toMatchObject({
      name: 'WirebenchError',
      code: 'snippets-invalid',
      details: { file: 'snippets.yaml', errno: 'EISDIR' },
    });
  });

  it('save writes the file, re-lists it and notifies', async () => {
    const d = dir();
    const onChanged = vi.fn();
    const service = new SnippetsService({ treeDir: () => d, onChanged });
    const result = await service.save(ONE);
    expect(readFileSync(join(d, 'snippets.yaml'), 'utf8')).toBe(
      'version: 1\nsnippets:\n  - id: uptime\n    name: Uptime\n    script: uptime\n',
    );
    expect(result.snippets.map((s) => s.id)).toEqual(['uptime']);
    expect(onChanged).toHaveBeenCalledOnce();
    expect(service.current()?.snippets).toHaveLength(1);
  });

  it('a save of an invalid file is refused with its code and writes nothing', async () => {
    const d = dir();
    const service = new SnippetsService({ treeDir: () => d });
    const twice: SnippetsFileWire = { ...ONE, snippets: [...ONE.snippets, ...ONE.snippets] };
    await expect(service.save(twice)).rejects.toMatchObject({
      name: 'WirebenchError',
      code: 'snippet-duplicate-id',
    });
    const leaked: SnippetsFileWire = {
      ...ONE,
      snippets: [{ ...ONE.snippets[0]!, script: 'echo ${secret:bad name}' }],
    };
    await expect(service.save(leaked)).rejects.toMatchObject({ code: 'snippet-secret-invalid' });
    expect(() => readFileSync(join(d, 'snippets.yaml'))).toThrow();
  });

  it('serves from its cache until invalidated, then reads the disk again', async () => {
    const d = dir();
    const service = new SnippetsService({ treeDir: () => d });
    expect((await service.list()).snippets).toEqual([]);
    writeFileSync(join(d, 'snippets.yaml'), FILE);
    expect((await service.list()).snippets).toEqual([]);
    service.invalidate();
    expect((await service.list()).snippets).toHaveLength(2);
  });
});

describe('windowSnippets (multi-window)', () => {
  it("each window reads its own workspace's snippets.yaml and notifies only itself", async () => {
    const dirA = dir();
    const dirB = dir();
    writeFileSync(join(dirA, 'snippets.yaml'), FILE);
    const notifyA = vi.fn();
    const notifyB = vi.fn();
    const a = windowSnippets(() => dirA, notifyA);
    const b = windowSnippets(() => dirB, notifyB);
    expect((await a.list()).snippets).toHaveLength(2);
    await b.save(ONE);
    expect(notifyB).toHaveBeenCalledOnce();
    expect(notifyA).not.toHaveBeenCalled();
    expect(readFileSync(join(dirA, 'snippets.yaml'), 'utf8')).toBe(FILE);
  });

  it('a window with no workspace open is refused as workspace-not-open', async () => {
    const snippets = windowSnippets(() => {
      throw new WorkspaceError('workspace-not-found', 'No workspace is open');
    }, vi.fn());
    await expect(snippets.list()).rejects.toMatchObject({ code: 'workspace-not-open' });
  });
});
