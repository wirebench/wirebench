import type { ScopeKeyWire } from './wire-types.js';

/** One string per scope, for maps keyed by scope; main and the renderer key alike. */
export function scopeKeyString(key: ScopeKeyWire): string {
  switch (key.scope) {
    case 'global':
      return 'global';
    case 'workspace':
      return 'workspace';
    case 'workspaceEnvironment':
      return `workspaceEnvironment:${key.environmentId}`;
    case 'project':
      return `project:${key.projectId}`;
    case 'projectEnvironment':
      return `projectEnvironment:${key.projectId}:${key.environmentId}`;
  }
}
