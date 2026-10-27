import type { VariableEditTargetWire } from '@shared/wire-base.js';
import { openProjectTab } from '../explorer/project-actions.js';
import { openEnvironmentTab } from './environment-actions.js';

/**
 * Opens the tab that edits a variable's scope: what a variable hover's **Edit** link does (#340). An
 * environment, Globals and the workspace's variables open on the environment page; a project's own
 * properties on its project tab.
 */
export function openVariableEditTarget(target: VariableEditTargetWire): void {
  switch (target.kind) {
    case 'environment':
      openEnvironmentTab({ kind: 'environment', id: target.id });
      return;
    case 'globals':
    case 'workspace':
      openEnvironmentTab({ kind: target.kind });
      return;
    case 'project':
      openProjectTab(target.projectId);
      return;
  }
}
