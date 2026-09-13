import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WorkspaceError } from '../../../src/errors.js';
import {
  assertPathSegment,
  workspaceDir,
  workspaceEnvironmentFile,
  workspaceManifestFile,
  workspaceProjectDir,
  workspaceTreeDir,
} from '../../../src/workspace/paths.js';
import { DEFAULT_GIT_SHARE_SETTINGS } from '../../../src/workspace/share.js';

describe('path builders', () => {
  it('workspaceDir joins the user-data root, WORKSPACES_DIR, and the workspace id', () => {
    expect(workspaceDir('/data', 'W1')).toBe(join('/data', 'workspaces', 'W1'));
  });

  it('workspaceManifestFile joins the workspace dir and workspace.yaml', () => {
    expect(workspaceManifestFile('/data/workspaces/W1')).toBe(join('/data/workspaces/W1', 'workspace.yaml'));
  });

  it('workspaceEnvironmentFile joins the environments dir and <slug>.yaml', () => {
    expect(workspaceEnvironmentFile('/data/workspaces/W1', 'dev')).toBe(
      join('/data/workspaces/W1', 'environments', 'dev.yaml'),
    );
  });

  it('workspaceProjectDir joins the projects dir and <slug>', () => {
    expect(workspaceProjectDir('/data/workspaces/W1', 'CountryInfo')).toBe(
      join('/data/workspaces/W1', 'projects', 'CountryInfo'),
    );
  });

  it('workspaceEnvironmentFile rejects an invalid slug with workspace-path-invalid', () => {
    expect(() => workspaceEnvironmentFile('/data/workspaces/W1', '../x')).toThrow(WorkspaceError);
    try {
      workspaceEnvironmentFile('/data/workspaces/W1', '../x');
      throw new Error('expected to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(WorkspaceError);
      expect((error as WorkspaceError).code).toBe('workspace-path-invalid');
    }
  });

  it('workspaceProjectDir rejects an invalid slug with workspace-path-invalid', () => {
    try {
      workspaceProjectDir('/data/workspaces/W1', '..');
      throw new Error('expected to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(WorkspaceError);
      expect((error as WorkspaceError).code).toBe('workspace-path-invalid');
    }
  });

  it('workspaceTreeDir is the workspace dir itself when there is no share', () => {
    expect(workspaceTreeDir('/data/workspaces/W1', undefined)).toBe('/data/workspaces/W1');
  });

  it('workspaceTreeDir is the managed tree/ when the share has no explicit path', () => {
    expect(workspaceTreeDir('/data/workspaces/W1', { version: 1, kind: 'git', git: DEFAULT_GIT_SHARE_SETTINGS })).toBe(
      join('/data/workspaces/W1', 'tree'),
    );
  });

  it('workspaceTreeDir is the share path when one is set', () => {
    expect(workspaceTreeDir('/data/workspaces/W1', { version: 1, kind: 'folder', path: '/x' })).toBe('/x');
  });
});

describe('assertPathSegment', () => {
  it('accepts an ordinary slug', () => {
    expect(() => assertPathSegment('dev')).not.toThrow();
  });

  it('accepts an embedded space', () => {
    expect(() => assertPathSegment('a b')).not.toThrow();
  });

  it.each(['', '.', '..', 'a/b', 'a\\b', ' leading', 'trailing ', 'CON', 'com1', 'com1.txt'])(
    'rejects %j with workspace-path-invalid',
    (segment) => {
      try {
        assertPathSegment(segment);
        throw new Error('expected to throw');
      } catch (error) {
        expect(error).toBeInstanceOf(WorkspaceError);
        expect((error as WorkspaceError).code).toBe('workspace-path-invalid');
      }
    },
  );
});
