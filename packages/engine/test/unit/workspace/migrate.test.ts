import { describe, expect, it } from 'vitest';
import { WorkspaceError } from '../../../src/errors.js';
import { migrateWorkspace } from '../../../src/workspace/migrate.js';

describe('migrateWorkspace', () => {
  it('rejects an array-typed document as workspace-file-invalid', () => {
    try {
      migrateWorkspace([1, 2, 3], 'workspace.yaml');
      throw new Error('expected to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(WorkspaceError);
      expect((error as WorkspaceError).code).toBe('workspace-file-invalid');
    }
  });

  it('brings version 1 up to the current format version, lifting activeEnvironmentId into legacy', () => {
    const v1 = { formatVersion: 1, id: 'X', activeEnvironmentId: 'E1', writtenBy: 'wirebench' };
    expect(migrateWorkspace(v1, 'workspace.yaml')).toEqual({
      manifest: { formatVersion: 3, id: 'X' },
      legacy: { activeEnvironmentId: 'E1' },
    });
  });

  it('brings version 2 up to the current format version, lifting activeEnvironmentId and dropping writtenBy', () => {
    const v2 = { formatVersion: 2, id: 'X', disabled: ['tier'], activeEnvironmentId: 'E2', writtenBy: 'wirebench' };
    expect(migrateWorkspace(v2, 'workspace.yaml')).toEqual({
      manifest: { formatVersion: 3, id: 'X', disabled: ['tier'] },
      legacy: { activeEnvironmentId: 'E2' },
    });
  });

  it('passes a version-3 document through with no legacy fields, since it never had activeEnvironmentId', () => {
    const v3 = { formatVersion: 3, id: 'X', disabled: ['tier'] };
    expect(migrateWorkspace(v3, 'workspace.yaml')).toEqual({ manifest: v3, legacy: {} });
  });

  it('rejects a newer format version as workspace-format-too-new', () => {
    try {
      migrateWorkspace({ formatVersion: 4 }, 'workspace.yaml');
      throw new Error('expected to throw');
    } catch (error) {
      expect((error as WorkspaceError).code).toBe('workspace-format-too-new');
      expect((error as WorkspaceError).details).toMatchObject({ formatVersion: 4, supported: 3 });
    }
  });
});
