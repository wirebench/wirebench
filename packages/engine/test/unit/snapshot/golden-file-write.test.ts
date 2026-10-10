import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProject } from '../../../src/project/model.js';
import type { Project } from '../../../src/project/model.js';
import { requestFileLocation } from '../../../src/project/request-location.js';
import { createApi, createRestRequest, withRestApis } from '../../../src/rest/model.js';
import { readGoldenFile, writeGoldenFile } from '../../../src/snapshot/golden-file.js';

// Passes through to the real `writeFile` unless a test overrides one call.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, writeFile: vi.fn(actual.writeFile) };
});

let dir: string;
let project: Project;
let folder: string;
let slug: string;
let relative: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wb-golden-write-'));
  const request = createRestRequest('Get one', { id: 'r1', url: 'https://example.test/one' });
  project = withRestApis(
    {
      ...createProject('Demo', { id: 'P1' }),
    },
    [{ ...createApi('Api', { id: 'a1', slug: 'api', order: 0, baseUrl: '' }), requests: [request] }],
  );
  const location = requestFileLocation(project, 'r1')!;
  folder = join(dir, ...location.dir.split('/'));
  slug = location.slug;
  relative = `${location.dir}/${slug}.golden.yaml`;
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, `${slug}.request.yaml`), 'name: Get one\n');
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const GOLDEN = {
  contentType: 'application/json',
  savedAt: '2026-10-03T10:00:00.000Z',
  ignore: ['/id'],
  body: '{"id": 1}\n',
};

describe('writeGoldenFile', () => {
  it('writes a golden the reader reads back, as a block scalar with sorted keys', async () => {
    expect(await writeGoldenFile(dir, project, 'r1', GOLDEN)).toEqual({ status: 'written', file: relative });
    expect(await readGoldenFile(dir, project, 'r1')).toEqual({ status: 'present', golden: GOLDEN });
    const text = readFileSync(join(folder, `${slug}.golden.yaml`), 'utf8');
    expect(text).toContain('body: |');
    expect(text.indexOf('body:')).toBeLessThan(text.indexOf('savedAt:'));
  });

  it('replaces an existing golden', async () => {
    await writeGoldenFile(dir, project, 'r1', GOLDEN);
    await writeGoldenFile(dir, project, 'r1', { ...GOLDEN, body: '{"id": 2}\n' });
    const read = await readGoldenFile(dir, project, 'r1');
    expect(read.status === 'present' && read.golden.body).toBe('{"id": 2}\n');
  });

  it('round-trips bodies a block scalar cannot hold', async () => {
    for (const body of ['', ' ', '\n', '  \n', 'a  ', ' a\n', 'a\n ']) {
      await writeGoldenFile(dir, project, 'r1', { savedAt: 's', ignore: [], body });
      const read = await readGoldenFile(dir, project, 'r1');
      expect(read.status === 'present' && read.golden.body, JSON.stringify(body)).toBe(body);
    }
  });

  it('refuses an unknown request or a request file not on disk', async () => {
    expect(await writeGoldenFile(dir, project, 'nope', GOLDEN)).toEqual({ status: 'refused', reason: 'unsaved' });
    rmSync(join(folder, `${slug}.request.yaml`));
    expect(await writeGoldenFile(dir, project, 'r1', GOLDEN)).toEqual({ status: 'refused', reason: 'unsaved' });
    expect(existsSync(join(folder, `${slug}.golden.yaml`))).toBe(false);
  });

  it('refuses when the request folder escapes the project through a symlink', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'wb-golden-out-'));
    try {
      rmSync(join(dir, 'apis'), { recursive: true });
      mkdirSync(join(outside, 'requests'), { recursive: true });
      writeFileSync(join(outside, 'requests', `${slug}.request.yaml`), 'x\n');
      mkdirSync(join(dir, 'apis'));
      symlinkSync(outside, join(dir, 'apis', 'api'));
      expect(await writeGoldenFile(dir, project, 'r1', GOLDEN)).toEqual({ status: 'refused', reason: 'unsaved' });
      expect(readdirSync(join(outside, 'requests'))).toEqual([`${slug}.request.yaml`]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('refuses a sidecar that is a symlink and leaves its target alone', async () => {
    const target = join(dir, 'target.txt');
    writeFileSync(target, 'keep');
    symlinkSync(target, join(folder, `${slug}.golden.yaml`));
    expect(await writeGoldenFile(dir, project, 'r1', GOLDEN)).toEqual({ status: 'refused', reason: 'not-a-file' });
    expect(readFileSync(target, 'utf8')).toBe('keep');
  });

  it('removes the temp file when the write fails, and names each temp file uniquely', async () => {
    const writeFile = vi.mocked(fsPromises.writeFile);
    const temps: string[] = [];
    writeFile.mockImplementationOnce((path, data) => {
      // A partial temp file is left behind by the failed write, as a full disk would.
      writeFileSync(path as string, (data as string).slice(0, 3));
      temps.push(path as string);
      return Promise.reject(new Error('disk full'));
    });
    await expect(writeGoldenFile(dir, project, 'r1', GOLDEN)).rejects.toThrow('disk full');
    expect(readdirSync(folder).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    await writeGoldenFile(dir, project, 'r1', GOLDEN);
    temps.push(writeFile.mock.calls.at(-1)?.[0] as string);
    expect(temps[0]).not.toBe(temps[1]);
  });
});
