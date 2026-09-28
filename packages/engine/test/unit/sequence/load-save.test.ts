/**
 * Sequences inside a project folder: they load and save beside everything else, a deleted one's file
 * goes, `formatVersion` does not move, and nothing this build could not read is ever deleted or
 * overwritten by a save.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isWirebenchError } from '../../../src/errors.js';
import { loadProject } from '../../../src/project/load.js';
import { createProject } from '../../../src/project/model.js';
import type { Project } from '../../../src/project/model.js';
import { saveProject } from '../../../src/project/save.js';
import { createSequence, createSequenceStep } from '../../../src/sequence/model.js';
import { listTree, tempProjectDir } from '../project/fixture.js';

function withSequences(...names: string[]): Project {
  return {
    ...createProject('Seq Project', { id: 'P1' }),
    sequences: names.map((name, index) =>
      createSequence(name, { id: `S${index}`, order: index, steps: [createSequenceStep('R1', { id: `T${index}` })] }),
    ),
  };
}

const FOREIGN = {
  newer: 'kind: sequence\nversion: 2\nid: S9\nname: From a newer build\norder: 0\n',
  malformed: 'kind: sequence\nversion: 1\nid: S8\nname: "unclosed\n',
};

describe('sequences in a project folder', () => {
  it('load back as saved, in order, with formatVersion unchanged', async () => {
    const dir = await tempProjectDir();
    await saveProject(withSequences('Checkout', 'Refund'), dir);
    expect(await listTree(dir)).toEqual(
      expect.arrayContaining(['sequences/Checkout.sequence.yaml', 'sequences/Refund.sequence.yaml']),
    );
    expect(await readFile(join(dir, 'wirebench.yaml'), 'utf8')).toContain('formatVersion: 5');

    const { project, problems } = await loadProject(dir);
    expect(problems).toEqual([]);
    expect(project.sequences.map((s) => s.name)).toEqual(['Checkout', 'Refund']);
  });

  it('removes the file of a deleted sequence', async () => {
    const dir = await tempProjectDir();
    await saveProject(withSequences('Checkout', 'Refund'), dir);
    const { project } = await loadProject(dir);
    await saveProject({ ...project, sequences: project.sequences.filter((s) => s.name !== 'Refund') }, dir);
    expect(await listTree(dir)).not.toContain('sequences/Refund.sequence.yaml');
    expect(await listTree(dir)).toContain('sequences/Checkout.sequence.yaml');
  });

  it('reports a newer, a malformed and a duplicate file as problems, and a save leaves all three alone', async () => {
    const dir = await tempProjectDir();
    await saveProject(withSequences('Checkout'), dir);
    const checkout = await readFile(join(dir, 'sequences/Checkout.sequence.yaml'), 'utf8');
    await writeFile(join(dir, 'sequences/newer.sequence.yaml'), FOREIGN.newer);
    await writeFile(join(dir, 'sequences/malformed.sequence.yaml'), FOREIGN.malformed);
    // A copy with the same id sorts after the original, so it is the one refused.
    await writeFile(join(dir, 'sequences/zz-copy.sequence.yaml'), checkout.replace('name: Checkout', 'name: Copy'));

    const { project, problems } = await loadProject(dir);
    expect(project.sequences.map((s) => s.name)).toEqual(['Checkout']);
    expect(problems.map((p) => [p.code, p.file])).toEqual(
      expect.arrayContaining([
        ['sequence-version-too-new', 'sequences/newer.sequence.yaml'],
        ['sequence-file-invalid', 'sequences/malformed.sequence.yaml'],
        ['sequence-duplicate-id', 'sequences/zz-copy.sequence.yaml'],
      ]),
    );

    // Even a save that drops every sequence it knows keeps the three it could not read.
    await saveProject({ ...project, sequences: [] }, dir);
    const tree = await listTree(dir);
    expect(tree).not.toContain('sequences/Checkout.sequence.yaml');
    expect(tree).toEqual(
      expect.arrayContaining([
        'sequences/newer.sequence.yaml',
        'sequences/malformed.sequence.yaml',
        'sequences/zz-copy.sequence.yaml',
      ]),
    );
    expect(await readFile(join(dir, 'sequences/newer.sequence.yaml'), 'utf8')).toBe(FOREIGN.newer);
  });

  it('refuses to overwrite a file it could not read', async () => {
    const dir = await tempProjectDir();
    await mkdir(join(dir, 'sequences'), { recursive: true });
    await saveProject(withSequences(), dir);
    await writeFile(join(dir, 'sequences/newer.sequence.yaml'), FOREIGN.newer);
    const { project } = await loadProject(dir);

    const clash = { ...project, sequences: [createSequence('newer', { id: 'S1', slug: 'newer' })] };
    await expect(saveProject(clash, dir)).rejects.toSatisfy(
      (error: unknown) => isWirebenchError(error) && error.code === 'sequence-file-conflict',
    );
    expect(await readFile(join(dir, 'sequences/newer.sequence.yaml'), 'utf8')).toBe(FOREIGN.newer);
  });

  it('ignores files in sequences/ that are not sequence files', async () => {
    const dir = await tempProjectDir();
    await saveProject(withSequences('Checkout'), dir);
    await writeFile(join(dir, 'sequences/README.md'), '# notes\n');
    const { project, problems } = await loadProject(dir);
    expect(problems).toEqual([]);
    await saveProject({ ...project, sequences: [] }, dir);
    expect(await listTree(dir)).toContain('sequences/README.md');
  });
});
