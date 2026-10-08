import type { AreaModule } from '../area-module.js';

export const sshArea = {
  id: 'ssh',
  feature: { id: 'ssh', title: 'SSH', default: true, stage: 'experimental', requires: [] },
  rail: { label: 'Hosts', icon: 'TerminalSquare', command: 'view.showHosts', order: 60, testId: 'activity-hosts' },
  copy: {
    title: 'Hosts',
    headline: 'No hosts yet',
    body: 'Add a host, or a group that holds the user and key its hosts share.',
  },
} as const satisfies AreaModule<'ssh'>;
