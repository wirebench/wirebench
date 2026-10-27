import type { AreaModule } from '../area-module.js';

export const sshArea = {
  id: 'ssh',
  feature: { id: 'ssh', title: 'SSH', default: true, stage: 'stable', requires: [] },
  rail: {
    label: 'Hosts',
    icon: 'TerminalSquare',
    command: 'view.showHosts',
    order: 60,
    testId: 'activity-hosts',
    // The SSH menu is the only way into Snippets, Layouts and the rest: a second click must not hide it.
    reselect: 'focus',
  },
  copy: {
    title: 'Hosts',
    headline: 'No hosts yet',
    body: 'Add a host, or a group that holds the user and key its hosts share.',
  },
} as const satisfies AreaModule<'ssh'>;
