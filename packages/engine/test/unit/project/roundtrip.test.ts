import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ProjectError } from '../../../src/errors.js';
import { loadProject } from '../../../src/project/load.js';
import { saveProject } from '../../../src/project/save.js';
import { projectFiles } from '../../../src/project/serialize.js';
import { stringifyYaml } from '../../../src/project/yaml.js';
import type { Project, RequestDef } from '../../../src/project/model.js';
import { CRLF_ENVELOPE, listTree, readBytes, sampleProject, tempProjectDir } from './fixture.js';

function withRequests(project: Project, map: (r: RequestDef) => RequestDef | undefined): Project {
  return {
    ...project,
    interfaces: project.interfaces.map((i) => ({
      ...i,
      operations: i.operations.map((o) => ({
        ...o,
        requests: o.requests.map(map).filter((r): r is RequestDef => r !== undefined),
      })),
    })),
  };
}

describe('saveProject', () => {
  it('writes the documented folder layout', async () => {
    const dir = await tempProjectDir();
    const result = await saveProject(sampleProject(), dir);

    expect(await listTree(dir)).toEqual([
      'environments/dev.yaml',
      'environments/prod.yaml',
      'interfaces/CountryInfo/interface.yaml',
      'interfaces/CountryInfo/operations/ListOfCountryNamesByCode/Kitchen sink.request.yaml',
      'interfaces/CountryInfo/operations/ListOfCountryNamesByCode/Kitchen sink.xml',
      'interfaces/CountryInfo/operations/ListOfCountryNamesByCode/Request 1.request.yaml',
      'interfaces/CountryInfo/operations/ListOfCountryNamesByCode/Request 1.xml',
      'interfaces/CountryInfo/operations/ListOfCountryNamesByCode/Smoke test.request.yaml',
      'interfaces/CountryInfo/operations/ListOfCountryNamesByCode/Smoke test.xml',
      'interfaces/Orders_ v2_legacy_/interface.yaml',
      'interfaces/Orders_ v2_legacy_/operations/PlaceOrder/Bulk _ batch.request.yaml',
      'interfaces/Orders_ v2_legacy_/operations/PlaceOrder/Bulk _ batch.xml',
      'interfaces/Orders_ v2_legacy_/operations/PlaceOrder/Request 1.request.yaml',
      'interfaces/Orders_ v2_legacy_/operations/PlaceOrder/Request 1.xml',
      'wirebench.yaml',
      'wss/incoming/default.yaml',
      'wss/keystores.yaml',
      'wss/outgoing/prod-signature.yaml',
    ]);
    expect(result.removed).toEqual([]);
    expect(result.unchanged).toEqual([]);
    expect(result.written).toHaveLength(18);

    await rm(dir, { recursive: true, force: true });
  });

  it('writes envelopes byte-exactly, CRLF and trailing space included', async () => {
    const dir = await tempProjectDir();
    await saveProject(sampleProject(), dir);

    const bytes = await readBytes(dir, 'interfaces/CountryInfo/operations/ListOfCountryNamesByCode/Smoke test.xml');
    expect(bytes.toString('utf8')).toBe(CRLF_ENVELOPE);
    expect(bytes.includes('\r\n')).toBe(true);

    await rm(dir, { recursive: true, force: true });
  });

  it('emits YAML with stable, sorted key order and no line wrapping', async () => {
    const dir = await tempProjectDir();
    await saveProject(sampleProject(), dir);

    expect((await readBytes(dir, 'wirebench.yaml')).toString('utf8')).toMatchInlineSnapshot(`
      "description: Round-trip fixture
      disabled:
        - tier
      formatVersion: 2
      id: ID0001
      name: Demo Project
      properties:
        region: eu-west-1
        tier: gold
      settings:
        cacheDefinitions: true
        defaultTimeoutMs: 60000
        prettyPrintResponses: true
        resourceRoot: ./res
      writtenBy: wirebench
      "
    `);
    expect((await readBytes(dir, 'environments/dev.yaml')).toString('utf8')).toMatchInlineSnapshot(`
      "disabled:
        - region
      endpoints:
        CountryInfo: http://localhost:8080/country
      id: ID0009
      name: dev
      order: 0
      properties:
        region: local
      "
    `);

    await rm(dir, { recursive: true, force: true });
  });

  it('leaves a re-save of an unchanged project entirely untouched', async () => {
    const dir = await tempProjectDir();
    const project = sampleProject();
    await saveProject(project, dir);

    const again = await saveProject(project, dir);
    expect(again.written).toEqual([]);
    expect(again.removed).toEqual([]);
    expect(again.unchanged).toHaveLength(18);

    await rm(dir, { recursive: true, force: true });
  });

  it('rewrites exactly the two files of a renamed request', async () => {
    const dir = await tempProjectDir();
    const project = sampleProject();
    const previous = projectFiles(project);
    await saveProject(project, dir);

    const renamed = withRequests(project, (r) =>
      r.slug === 'Smoke test' ? { ...r, name: 'Smoke test v2', slug: 'Smoke test v2' } : r,
    );
    const result = await saveProject(renamed, dir, { previous });

    const opDir = 'interfaces/CountryInfo/operations/ListOfCountryNamesByCode';
    expect(result.written).toEqual([`${opDir}/Smoke test v2.request.yaml`, `${opDir}/Smoke test v2.xml`]);
    expect(result.removed).toEqual([`${opDir}/Smoke test.request.yaml`, `${opDir}/Smoke test.xml`]);
    expect(result.unchanged).toHaveLength(16);

    await rm(dir, { recursive: true, force: true });
  });

  it('removes exactly the two files of a deleted request', async () => {
    const dir = await tempProjectDir();
    const project = sampleProject();
    await saveProject(project, dir);

    const trimmed = withRequests(project, (r) => (r.slug === 'Bulk _ batch' ? undefined : r));
    const result = await saveProject(trimmed, dir);

    const opDir = 'interfaces/Orders_ v2_legacy_/operations/PlaceOrder';
    expect(result.removed).toEqual([`${opDir}/Bulk _ batch.request.yaml`, `${opDir}/Bulk _ batch.xml`]);
    expect(result.written).toEqual([]);
    expect(await listTree(dir)).not.toContain(`${opDir}/Bulk _ batch.xml`);

    await rm(dir, { recursive: true, force: true });
  });

  it('leaves foreign files inside managed directories untouched by a save', async () => {
    const dir = await tempProjectDir();
    const project = sampleProject();
    await saveProject(project, dir);

    await writeFile(join(dir, 'environments', 'notes.txt'), 'ignored');
    const opDir = 'interfaces/CountryInfo/operations/ListOfCountryNamesByCode';
    await writeFile(join(dir, ...`${opDir}/Ghost.xml`.split('/')), '<x/>');
    await writeFile(join(dir, 'README.md'), '# notes');
    await mkdir(join(dir, 'wss', 'outgoing'), { recursive: true });
    await writeFile(join(dir, 'wss', 'outgoing', '.gitkeep'), '');

    const result = await saveProject(project, dir);

    expect(result.removed).toEqual([]);
    const tree = await listTree(dir);
    expect(tree).toContain('environments/notes.txt');
    expect(tree).toContain(`${opDir}/Ghost.xml`);
    expect(tree).toContain('README.md');
    expect(tree).toContain('wss/outgoing/.gitkeep');

    await rm(dir, { recursive: true, force: true });
  });

  it('rejects a slug that would escape the project root, before touching disk', async () => {
    const dir = await tempProjectDir();
    const project = sampleProject();

    for (const badSlug of ['..', '../x', 'a/b', '.']) {
      const corrupted = { ...project, environments: [{ ...project.environments[0]!, slug: badSlug }] };
      await expect(saveProject(corrupted, dir)).rejects.toMatchObject({ code: 'project-path-invalid' });
    }
    expect(await listTree(dir)).toEqual([]);

    await rm(dir, { recursive: true, force: true });
  });

  it('rejects an absolute or escaping WssRef.file, before touching disk', async () => {
    const dir = await tempProjectDir();
    const project = sampleProject();

    for (const badFile of ['../outside.yaml', '/etc/passwd', 'wss/../outside.yaml', 'other/x.yaml']) {
      const corrupted: Project = {
        ...project,
        wss: {
          ...project.wss,
          outgoing: [{ id: 'W1', name: 'x', file: badFile, document: { id: 'W1', name: 'x' } }],
        },
      };
      await expect(saveProject(corrupted, dir)).rejects.toMatchObject({ code: 'project-path-invalid' });
    }
    expect(await listTree(dir)).toEqual([]);

    await rm(dir, { recursive: true, force: true });
  });

  it('preserves unknown fields of a WS-Security document across a load/save cycle', async () => {
    const dir = await tempProjectDir();
    const project = sampleProject();
    await saveProject(project, dir);

    const outgoingPath = join(dir, 'wss', 'outgoing', 'prod-signature.yaml');
    const richDocument = stringifyYaml({
      id: 'W1',
      name: 'prod-signature',
      entries: [{ type: 'Timestamp' }],
      ttl: 300,
    });
    await writeFile(outgoingPath, richDocument);

    const { project: loaded } = await loadProject(dir);
    await saveProject(loaded, dir);
    const after = (await readBytes(dir, 'wss/outgoing/prod-signature.yaml')).toString('utf8');
    expect(after).toBe(richDocument);

    await rm(dir, { recursive: true, force: true });
  });

  it('deletes a removed interface folder, definition cache included, and never touches a live one', async () => {
    const dir = await tempProjectDir();
    const project = sampleProject();
    await saveProject(project, dir);
    await mkdir(join(dir, 'interfaces', 'CountryInfo', 'definition'), { recursive: true });
    await writeFile(join(dir, 'interfaces', 'CountryInfo', 'definition', 'service.wsdl'), 'cached');
    await mkdir(join(dir, 'interfaces', 'Orders_ v2_legacy_', 'definition'), { recursive: true });
    await writeFile(join(dir, 'interfaces', 'Orders_ v2_legacy_', 'definition', 'orders.wsdl'), 'cached');

    const result = await saveProject(
      { ...project, interfaces: project.interfaces.filter((i) => i.slug === 'CountryInfo') },
      dir,
    );

    expect(result.removed).toEqual(['interfaces/Orders_ v2_legacy_']);
    const tree = await listTree(dir);
    expect(tree).toContain('interfaces/CountryInfo/definition/service.wsdl');
    expect(tree.filter((f) => f.startsWith('interfaces/Orders_'))).toEqual([]);

    await rm(dir, { recursive: true, force: true });
  });

  it('prunes an operation folder once its last request is deleted', async () => {
    const dir = await tempProjectDir();
    const project = sampleProject();
    await saveProject(project, dir);

    const emptied: Project = {
      ...project,
      interfaces: project.interfaces.map((i) =>
        i.slug === 'PlaceOrderHost' ? i : { ...i, operations: i.operations.map((o) => ({ ...o, requests: [] })) },
      ),
    };
    const result = await saveProject(emptied, dir);

    expect(result.removed).toContain('interfaces/CountryInfo/operations/ListOfCountryNamesByCode');
    expect(result.removed).toContain('interfaces/CountryInfo/operations');
    expect(await listTree(dir)).toContain('interfaces/CountryInfo/interface.yaml');

    await rm(dir, { recursive: true, force: true });
  });

  it('writes disabled sorted, deduplicated, and dropped once its list would be empty', async () => {
    const dir = await tempProjectDir();
    const project: Project = {
      ...sampleProject(),
      properties: { b: '2', a: '1' },
      disabledProperties: ['b', 'a', 'b', 'ghost'],
    };
    await saveProject(project, dir);

    const text = (await readBytes(dir, 'wirebench.yaml')).toString('utf8');
    expect(text).toContain('disabled:\n  - a\n  - b\n');
    expect(text).not.toContain('ghost');

    await rm(dir, { recursive: true, force: true });
  });

  it('omits disabled entirely once every disabled name has been removed from properties', async () => {
    const dir = await tempProjectDir();
    const project: Project = { ...sampleProject(), properties: {}, disabledProperties: ['tier'] };
    await saveProject(project, dir);

    const text = (await readBytes(dir, 'wirebench.yaml')).toString('utf8');
    expect(text).not.toContain('disabled');

    await rm(dir, { recursive: true, force: true });
  });
});

describe('loadProject', () => {
  it('round-trips a project to a deep-equal model', async () => {
    const dir = await tempProjectDir();
    const project = sampleProject();
    await saveProject(project, dir);

    const { project: loaded, problems } = await loadProject(dir);
    expect(problems).toEqual([]);
    expect(loaded).toEqual(project);

    await rm(dir, { recursive: true, force: true });
  });

  it('survives a second save/load cycle without touching a file', async () => {
    const dir = await tempProjectDir();
    await saveProject(sampleProject(), dir);
    const { project: loaded } = await loadProject(dir);
    const again = await saveProject(loaded, dir);
    expect(again.written).toEqual([]);

    await rm(dir, { recursive: true, force: true });
  });

  it('reports a missing envelope as a problem and loads an empty body', async () => {
    const dir = await tempProjectDir();
    await saveProject(sampleProject(), dir);
    const xml = 'interfaces/CountryInfo/operations/ListOfCountryNamesByCode/Request 1.xml';
    await rm(join(dir, ...xml.split('/')));

    const { project: loaded, problems } = await loadProject(dir);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.code).toBe('missing-envelope');
    expect(problems[0]?.file).toBe(xml);
    expect(problems[0]?.message).toContain('Request 1');
    expect(loaded.interfaces[0]?.operations[0]?.requests[0]?.envelopeXml).toBe('');

    await rm(dir, { recursive: true, force: true });
  });

  it('reports an operation folder no interface declares', async () => {
    const dir = await tempProjectDir();
    await saveProject(sampleProject(), dir);
    await mkdir(join(dir, 'interfaces', 'CountryInfo', 'operations', 'Ghost'), { recursive: true });

    const { problems } = await loadProject(dir);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.code).toBe('orphan-operation-folder');
    expect(problems[0]?.file).toBe('interfaces/CountryInfo/operations/Ghost');
    expect(problems[0]?.message).toContain('Ghost');

    await rm(dir, { recursive: true, force: true });
  });

  it('reports an interface folder without an interface.yaml', async () => {
    const dir = await tempProjectDir();
    await saveProject(sampleProject(), dir);
    await mkdir(join(dir, 'interfaces', 'Stray'), { recursive: true });

    const { project: loaded, problems } = await loadProject(dir);
    expect(problems.map((p) => p.code)).toEqual(['missing-interface-file']);
    expect(loaded.interfaces).toHaveLength(2);

    await rm(dir, { recursive: true, force: true });
  });

  it('throws project-not-found when there is no manifest', async () => {
    const dir = await tempProjectDir();
    await expect(loadProject(dir)).rejects.toMatchObject({
      name: 'ProjectError',
      code: 'project-not-found',
    });
    await rm(dir, { recursive: true, force: true });
  });

  it('throws project-file-invalid with the file path for malformed yaml', async () => {
    const dir = await tempProjectDir();
    await saveProject(sampleProject(), dir);
    const file = 'environments/dev.yaml';
    await writeFile(join(dir, ...file.split('/')), 'endpoints: [unclosed\n');

    const error = await loadProject(dir).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProjectError);
    expect((error as ProjectError).code).toBe('project-file-invalid');
    expect((error as ProjectError).details).toMatchObject({ file });

    await rm(dir, { recursive: true, force: true });
  });

  it('throws project-file-invalid with the file path for a schema violation', async () => {
    const dir = await tempProjectDir();
    await saveProject(sampleProject(), dir);
    const file = 'interfaces/CountryInfo/interface.yaml';
    await writeFile(join(dir, ...file.split('/')), 'kind: soap\nid: X\n');

    const error = (await loadProject(dir).catch((e: unknown) => e)) as ProjectError;
    expect(error.code).toBe('project-file-invalid');
    expect(error.details).toMatchObject({ file });
    expect((error.details as { issues: unknown[] }).issues.length).toBeGreaterThan(0);

    await rm(dir, { recursive: true, force: true });
  });

  it('ignores an unknown top-level key in a manifest written by a newer 1.x build', async () => {
    const dir = await tempProjectDir();
    const project = sampleProject();
    await saveProject(project, dir);
    const file = 'wirebench.yaml';
    const text = (await readBytes(dir, file)).toString('utf8');
    await writeFile(join(dir, file), `${text}surprise: yes\n`);

    const { project: loaded } = await loadProject(dir);
    expect(loaded).toEqual(project);
    expect(Object.keys(loaded)).not.toContain('surprise');

    await saveProject(loaded, dir);
    const saved = (await readBytes(dir, file)).toString('utf8');
    expect(saved).not.toContain('surprise');

    await rm(dir, { recursive: true, force: true });
  });

  it('throws project-format-too-new for a newer formatVersion', async () => {
    const dir = await tempProjectDir();
    await saveProject(sampleProject(), dir);
    const text = (await readBytes(dir, 'wirebench.yaml')).toString('utf8');
    await writeFile(join(dir, 'wirebench.yaml'), text.replace('formatVersion: 2', 'formatVersion: 3'));

    const error = (await loadProject(dir).catch((e: unknown) => e)) as ProjectError;
    expect(error.code).toBe('project-format-too-new');
    expect(error.details).toMatchObject({ formatVersion: 3, supported: 2 });

    await rm(dir, { recursive: true, force: true });
  });

  it('throws project-file-invalid for a missing or older formatVersion', async () => {
    const dir = await tempProjectDir();
    await saveProject(sampleProject(), dir);
    const text = (await readBytes(dir, 'wirebench.yaml')).toString('utf8');
    await writeFile(join(dir, 'wirebench.yaml'), text.replace('formatVersion: 2', 'formatVersion: "1"'));

    const error = (await loadProject(dir).catch((e: unknown) => e)) as ProjectError;
    expect(error.code).toBe('project-file-invalid');
    expect(JSON.stringify(error.details)).toContain('formatVersion');

    await rm(dir, { recursive: true, force: true });
  });

  it('reports an envelope with no request file and ignores foreign files', async () => {
    const dir = await tempProjectDir();
    await saveProject(sampleProject(), dir);
    const opDir = 'interfaces/CountryInfo/operations/ListOfCountryNamesByCode';
    await writeFile(join(dir, ...`${opDir}/Ghost.xml`.split('/')), '<x/>');
    await writeFile(join(dir, 'environments', 'notes.txt'), 'ignored');
    await mkdir(join(dir, 'wss', 'outgoing', 'nested'), { recursive: true });

    const { project: loaded, problems } = await loadProject(dir);
    expect(problems.map((p) => p.code)).toEqual(['orphan-request-file']);
    expect(problems[0]?.file).toBe(`${opDir}/Ghost.xml`);
    expect(loaded.environments.map((e) => e.slug)).toEqual(['dev', 'prod']);
    expect(loaded.wss.outgoing.map((w) => w.name)).toEqual(['prod-signature']);

    await rm(dir, { recursive: true, force: true });
  });

  it('round-trips activeEnvironmentId through save and load', async () => {
    const dir = await tempProjectDir();
    const project = { ...sampleProject(), activeEnvironmentId: sampleProject().environments[0]!.id };
    await saveProject(project, dir);

    expect((await readBytes(dir, 'wirebench.yaml')).toString('utf8')).toContain('activeEnvironmentId:');

    const { project: loaded } = await loadProject(dir);
    expect(loaded.activeEnvironmentId).toBe(project.activeEnvironmentId);
    expect(loaded).toEqual(project);

    await rm(dir, { recursive: true, force: true });
  });

  it('omits activeEnvironmentId entirely when unset', async () => {
    const dir = await tempProjectDir();
    await saveProject(sampleProject(), dir);

    expect((await readBytes(dir, 'wirebench.yaml')).toString('utf8')).not.toContain('activeEnvironmentId');
    const { project: loaded } = await loadProject(dir);
    expect(loaded.activeEnvironmentId).toBeUndefined();

    await rm(dir, { recursive: true, force: true });
  });

  it('loads a project with no wss directory at all', async () => {
    const dir = await tempProjectDir();
    const project = sampleProject();
    await saveProject({ ...project, wss: { outgoing: [], incoming: [], keystores: [] } }, dir);

    const { project: loaded } = await loadProject(dir);
    expect(loaded.wss).toEqual({ outgoing: [], incoming: [], keystores: [] });

    await rm(dir, { recursive: true, force: true });
  });
});
