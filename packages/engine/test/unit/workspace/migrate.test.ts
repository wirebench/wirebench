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
});
