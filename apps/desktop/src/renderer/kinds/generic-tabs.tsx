/**
 * The editor tabs no protocol kind owns, as `TabContribution`s beside the kinds' own. Tabs with no
 * entity id (a diff, an environment comparison, the cookie manager, a terminal) are not rows here:
 * the editor area renders those itself.
 */
import { lazy } from 'react';
import { EnvironmentPage } from '../features/environments/environment-page.js';
import { targetFromId } from '../features/environments/environment-actions.js';
import { ProjectTab } from '../features/project/project-tab.js';
import { selectEnvironment } from '../state/project.js';
import type { TabContribution, TabTitleContext } from './tab-contribution.js';

const SequenceTab = lazy(async () => {
  const module = await import('../features/sequence/sequence-tab.js');
  return { default: ({ id }: { readonly id: string }) => <module.SequenceTab sequenceId={id} /> };
});

// Split out: its body and script editors are Monaco.
const MockTab = lazy(async () => {
  const module = await import('../features/mock/mock-tab.js');
  return { default: ({ id }: { readonly id: string }) => <module.MockTab mockId={id} /> };
});

const RunnerTab = lazy(async () => {
  const module = await import('../features/runner/runner-tab.js');
  return { default: ({ id }: { readonly id: string }) => <module.RunnerTab targetId={id} /> };
});

const HistoryEntryView = lazy(async () => {
  const module = await import('../features/history/history-entry-view.js');
  return { default: ({ id }: { readonly id: string }) => <module.HistoryEntryView historyId={id} /> };
});

const CatchUrlTab = lazy(async () => {
  const module = await import('../features/webhooks/catch-url-tab.js');
  return { default: ({ id }: { readonly id: string }) => <module.CatchUrlTab hookId={id} /> };
});

function EnvironmentTab({ id }: { readonly id: string }) {
  return <EnvironmentPage target={targetFromId(id)} />;
}

function ProjectPage({ id }: { readonly id: string }) {
  return <ProjectTab projectId={id} />;
}

/**
 * One environment's name, wherever it lives. 'globals' and 'workspace' are sentinel ids for the
 * two fixed scopes that are not a real environment (see `environment-actions.ts`'s `targetId`);
 * real environments' ids are UUIDs, so the check never shadows one. The workspace's own
 * environments come first: they are what the grid tab shows, and a rename has to reach the tab.
 */
function environmentTitle(id: string, { project, workspaceEnvironments }: TabTitleContext): string | undefined {
  if (id === 'globals') return 'Globals';
  if (id === 'workspace') return 'Workspace';
  return workspaceEnvironments.find((candidate) => candidate.id === id)?.name ?? selectEnvironment(project, id)?.name;
}

export const GENERIC_TABS: readonly TabContribution[] = [
  {
    kind: 'environment',
    idField: 'environmentId',
    prefix: 'env:',
    persisted: true,
    Component: EnvironmentTab,
    title: environmentTitle,
  },
  {
    kind: 'project',
    idField: 'projectId',
    prefix: 'project:',
    persisted: true,
    Component: ProjectPage,
    title: (id, { project }) => project.projects[id]?.name,
  },
  {
    kind: 'sequence',
    idField: 'sequenceId',
    prefix: 'sequence:',
    persisted: true,
    Component: SequenceTab,
    title: (id, { project }) => project.sequences[id]?.name,
  },
  {
    kind: 'mock',
    idField: 'mockId',
    prefix: 'mock:',
    persisted: true,
    Component: MockTab,
    title: (id, { project }) => project.mocks[id]?.name,
  },
  {
    kind: 'runner',
    idField: 'runnerTargetId',
    prefix: 'runner:',
    persisted: false,
    Component: RunnerTab,
    loading: 'Loading…',
    keyed: true,
    // A Runner tab keeps the title it opened with: `Run <name>`.
    title: () => undefined,
  },
  {
    kind: 'history',
    idField: 'historyId',
    prefix: 'history:',
    persisted: false,
    Component: HistoryEntryView,
    // A history tab keeps the title it opened with: the entry it shows never changes.
    title: () => undefined,
  },
  {
    kind: 'catch-url',
    idField: 'hookId',
    prefix: 'catch-url:',
    persisted: false,
    Component: CatchUrlTab,
    loading: 'Loading…',
    keyed: true,
    title: (id, { hookNames }) => hookNames[id],
  },
];
