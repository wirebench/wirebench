import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { clarkToQName, environmentFor, openProject, readWsdl } from '../../../src/ops/project.js';
import { soapInterfacesOf } from '@wirebench/engine';

const FIXTURE = join(import.meta.dirname, '..', '..', 'fixtures', 'runner-project');
const dirs: string[] = [];
const context = (projectDir: string): { projectDir: string; warn: (line: string) => void } => ({
  projectDir,
  warn: () => undefined,
});

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('openProject', () => {
  it('loads a project fresh', async () => {
    const opened = await openProject(context(FIXTURE));
    expect(opened.project.name).toBe('Runner fixture');
  });

  it('refuses a workspace folder and a folder with no project', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'wirebench-ws-'));
    const empty = await mkdtemp(join(tmpdir(), 'wirebench-empty-'));
    dirs.push(workspace, empty);
    await writeFile(join(workspace, 'workspace.yaml'), 'name: x\n');

    await expect(openProject(context(workspace))).rejects.toMatchObject({ code: 'workspace-not-project' });
    await expect(openProject(context(empty))).rejects.toMatchObject({ code: 'project-not-found' });
  });
});

/** The `code` a call throws, or `undefined` when it returns. */
function codeOf(call: () => unknown): string | undefined {
  try {
    call();
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

describe('environmentFor', () => {
  it('requires, finds and narrows environments', async () => {
    const opened = await openProject(context(FIXTURE));
    expect(codeOf(() => environmentFor(opened, undefined))).toBe('environment-required');
    expect(codeOf(() => environmentFor(opened, 'nope'))).toBe('environment-not-found');
    expect(environmentFor(opened, 'local')?.name).toBe('local');
    expect(codeOf(() => environmentFor(opened, 'local', ['staging']))).toBe('environment-not-allowed');
    expect(environmentFor(opened, 'local', ['local'])?.name).toBe('local');
  });
});

describe('definitions', () => {
  it('reports an interface with no cached definition', async () => {
    const opened = await openProject(context(FIXTURE));
    const echo = soapInterfacesOf(opened.project)[0];
    if (echo === undefined) throw new Error('fixture has no interface');
    await expect(readWsdl(FIXTURE, echo)).rejects.toMatchObject({ code: 'definition-cache-missing' });
  });

  it('reads Clark notation', () => {
    expect(clarkToQName('{urn:echo}EchoSoap')).toEqual({ namespaceUri: 'urn:echo', localName: 'EchoSoap' });
    expect(clarkToQName('Bare')).toEqual({ namespaceUri: '', localName: 'Bare' });
  });
});
