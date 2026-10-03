import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProject } from '../../../src/project/model.js';
import type { Project } from '../../../src/project/model.js';
import { requestFileLocation } from '../../../src/project/request-location.js';
import { createApi, createRestRequest } from '../../../src/rest/model.js';
import { readGoldenFile } from '../../../src/snapshot/golden-file.js';

let dir: string;
let project: Project;
let folder: string;
let slug: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wb-golden-'));
  const request = createRestRequest('Get one', { id: 'r1', url: 'https://example.test/one' });
  project = {
    ...createProject('Demo', { id: 'P1' }),
    apis: [{ ...createApi('Api', { id: 'a1', slug: 'api', order: 0, baseUrl: '' }), requests: [request] }],
  };
  const location = requestFileLocation(project, 'r1')!;
  folder = join(dir, ...location.dir.split('/'));
  slug = location.slug;
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, `${slug}.request.yaml`), 'name: Get one\n');
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const golden = (text: string): void => writeFileSync(join(folder, `${slug}.golden.yaml`), text);

describe('readGoldenFile', () => {
  it('reads a present golden', async () => {
    golden(
      'contentType: application/json\nsavedAt: 2026-10-03T10:00:00.000Z\nignore:\n  - /id\nbody: |\n  {"id": 1}\n',
    );
    expect(await readGoldenFile(dir, project, 'r1')).toEqual({
      status: 'present',
      golden: {
        contentType: 'application/json',
        savedAt: '2026-10-03T10:00:00.000Z',
        ignore: ['/id'],
        body: '{"id": 1}\n',
      },
    });
  });

  it('omits an absent content type', async () => {
    golden('savedAt: s\nignore: []\nbody: x\n');
    const read = await readGoldenFile(dir, project, 'r1');
    expect(read).toEqual({ status: 'present', golden: { savedAt: 's', ignore: [], body: 'x' } });
  });

  it('is none without a sidecar, an unknown request, or a missing request file', async () => {
    expect(await readGoldenFile(dir, project, 'r1')).toEqual({ status: 'none' });
    expect(await readGoldenFile(dir, project, 'nope')).toEqual({ status: 'none' });
    golden('savedAt: s\nignore: []\nbody: x\n');
    rmSync(join(folder, `${slug}.request.yaml`));
    expect(await readGoldenFile(dir, project, 'r1')).toEqual({ status: 'none' });
  });

  it('is unreadable when malformed', async () => {
    golden('savedAt: [\n');
    expect(await readGoldenFile(dir, project, 'r1')).toEqual({ status: 'unreadable', reason: 'malformed' });
    golden('savedAt: s\nbody: x\n');
    expect(await readGoldenFile(dir, project, 'r1')).toEqual({ status: 'unreadable', reason: 'malformed' });
  });

  it('does not follow a sidecar symlink', async () => {
    const target = join(dir, 'elsewhere.yaml');
    writeFileSync(target, 'savedAt: s\nignore: []\nbody: x\n');
    symlinkSync(target, join(folder, `${slug}.golden.yaml`));
    expect(await readGoldenFile(dir, project, 'r1')).toEqual({ status: 'unreadable', reason: 'not-a-file' });
  });

  it('is none when the request folder escapes the project through a symlink', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'wb-golden-out-'));
    try {
      // The location is apis/api/requests: replace apis/api with a link to a folder outside.
      rmSync(join(dir, 'apis'), { recursive: true });
      mkdirSync(join(outside, 'requests'), { recursive: true });
      writeFileSync(join(outside, 'requests', `${slug}.request.yaml`), 'x\n');
      writeFileSync(join(outside, 'requests', `${slug}.golden.yaml`), 'savedAt: s\nignore: []\nbody: x\n');
      mkdirSync(join(dir, 'apis'));
      symlinkSync(outside, join(dir, 'apis', 'api'));
      expect(await readGoldenFile(dir, project, 'r1')).toEqual({ status: 'none' });
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
