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

  it('brings version 1 up to the current format version, otherwise unchanged', () => {
    const v1 = { formatVersion: 1, id: 'X' };
    expect(migrateWorkspace(v1, 'workspace.yaml')).toEqual({ ...v1, formatVersion: 2 });
  });

  it('passes a version-2 document through with the same formatVersion', () => {
    const v2 = { formatVersion: 2, id: 'X', disabled: ['tier'] };
    expect(migrateWorkspace(v2, 'workspace.yaml')).toEqual(v2);
  });

  it('rejects a newer format version as workspace-format-too-new', () => {
    try {
      migrateWorkspace({ formatVersion: 3 }, 'workspace.yaml');
      throw new Error('expected to throw');
    } catch (error) {
      expect((error as WorkspaceError).code).toBe('workspace-format-too-new');
      expect((error as WorkspaceError).details).toMatchObject({ formatVersion: 3, supported: 2 });
    }
  });
});
