// @vitest-environment node
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseLegacyProject, readLegacySoapProject } from '@wirebench/engine';
import { EngineService } from '../src/main/engine-service.js';
import { ProjectHost } from '../src/main/project-host.js';
import type { ProjectWire } from '../src/shared/wire-types.js';

const fixtures = fileURLToPath(new URL('../../../fixtures/legacy-soap-project/', import.meta.url));

let root = '';
let projectDir = '';
let host: ProjectHost;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'wirebench-legacy-'));
  projectDir = join(root, 'Imported');
  host = new ProjectHost(new EngineService());
  await host.create({ dir: projectDir, name: 'Imported' });
});

afterEach(async () => {
  await host.close();
  rmSync(root, { recursive: true, force: true });
});

function requestNames(project: ProjectWire): string[] {
  return project.requests.map((request) => `${request.operationName}/${request.name}`).sort();
}

describe('ProjectHost.importLegacyProject', () => {
  it('imports the full fixture offline and reports what it left behind', async () => {
    const legacy = await readLegacySoapProject({ kind: 'file', path: join(fixtures, 'full.xml') });
    const { project, report } = await host.importLegacyProject({ project: legacy });

    expect(project.interfaces.map((iface) => [iface.name, iface.hydration])).toEqual([
      ['EchoBinding', 'ready'],
      ['WsiEchoBinding', 'ready'],
    ]);
    expect(requestNames(project)).toEqual([
      'Echo/Compressed',
      'Echo/Echo with header',
      'Echo/One-off URL, NTLM',
      'Echo/Request 1',
      'Echo/Staging with auth',
      'Retired/Old request',
    ]);
    const staging = project.requests.find((request) => request.name === 'Staging with auth');
    expect(staging?.envelopeXml).toContain('<com:EchoRequest>${#Project#greeting}</com:EchoRequest>');
    expect(project.environments.map((environment) => environment.name)).toEqual(['Default', 'Staging']);
    expect(report.counts).toMatchObject({ interfaces: 2, requests: 6, environments: 2, properties: 3, scripts: 5 });
    expect(report.items.filter((item) => item.severity === 'warning')).toHaveLength(5);
  });

  it('writes the scripts under imported-scripts/, where a save leaves them alone', async () => {
    const legacy = await readLegacySoapProject({ kind: 'file', path: join(fixtures, 'full.xml') });
    await host.importLegacyProject({ project: legacy });
    const afterLoad = join(projectDir, 'imported-scripts', 'afterLoadScript.groovy');
    expect(await readFile(afterLoad, 'utf8')).toBe("log.info('project loaded')\n// second line");
    expect(existsSync(join(projectDir, 'imported-scripts', 'Smoke', 'setupScript.js'))).toBe(true);

    await host.mutate({ kind: 'set-project-property', name: 'extra', value: '1' });
    await host.save({ reason: 'test' });
    expect(existsSync(afterLoad)).toBe(true);
  });

  it('never writes a password into the project folder', async () => {
    const legacy = await readLegacySoapProject({ kind: 'file', path: join(fixtures, 'full.xml') });
    await host.importLegacyProject({ project: legacy });
    const files = (await readdir(projectDir, { recursive: true, withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name));
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) {
      expect(await readFile(file, 'utf8')).not.toContain('not-a-real-password');
    }
  });

  it('reopens offline from the definition cache it wrote', async () => {
    const legacy = await readLegacySoapProject({ kind: 'file', path: join(fixtures, 'minimal.xml') });
    await host.importLegacyProject({ project: legacy });
    await host.close();

    host = new ProjectHost(new EngineService());
    await host.openProject(projectDir);
    await host.whenHydrated();
    const reopened = host.snapshot() as ProjectWire;
    expect(reopened.interfaces.map((iface) => [iface.name, iface.hydration])).toEqual([['EchoBinding', 'ready']]);
    expect(requestNames(reopened)).toEqual(['Echo/Request 1']);
  });

  it('never reads a definition from a local path the file names, and still saves the project', async () => {
    const local = pathToFileURL(join(fixtures, '../wsdl/crafted/nested-imports/service.wsdl')).href;
    const text = (await readFile(join(fixtures, 'no-cache.xml'), 'utf8')).replace(
      'definition="http://example.invalid/nested/service.wsdl"',
      `definition="${local}"`,
    );
    const { project, report } = await host.importLegacyProject({ project: parseLegacyProject(text) });
    expect(project.interfaces).toEqual([]);
    expect(report.items).toContainEqual({
      severity: 'warning',
      path: 'EchoBinding',
      message: expect.stringContaining('a local path it names is never read') as string,
    });
  });
});
