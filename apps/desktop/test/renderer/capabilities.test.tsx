import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ALL_CAPABILITIES, type Capability } from '@wirebench/wire/capabilities';
import type { AccountWire, AppFeaturesWire, WorkspaceSummaryWire } from '@wirebench/wire/wire-base';
import type { WirebenchApi } from '../../src/preload/build-api.js';
import { hasCapability } from '../../src/renderer/lib/capabilities.js';
import { WorkspacePicker } from '../../src/renderer/features/workspace/picker-screen.js';
import { ImportDialog } from '../../src/renderer/features/explorer/import-dialog.js';
import { explorerMenuItems } from '../../src/renderer/features/explorer/context-menu.js';
import type { ExplorerNode } from '../../src/renderer/features/explorer/tree-nodes.js';
import { FeaturesSection } from '../../src/renderer/features/preferences/sections/features-section.js';
import { availableNav, resolveSection } from '../../src/renderer/features/preferences/settings-model.js';
import { TeamSecretsSection } from '../../src/renderer/features/sync/team-secrets-section.js';
import { listCommands, listPaletteCommands, registerCommand, resetCommands } from '../../src/renderer/lib/commands.js';
import type { CommandContext } from '../../src/renderer/lib/commands.js';
import { resetKerberosAvailability } from '../../src/renderer/lib/use-kerberos-availability.js';
import { useAccountStore } from '../../src/renderer/state/account.js';
import { DEFAULT_PREFERENCES_WIRE } from '../../src/renderer/state/preferences-defaults.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import { TEAM_SECRETS_OFF_STATUS, useTeamSecretsStore } from '../../src/renderer/state/team-secrets.js';
import { useWorkspaceStore } from '../../src/renderer/state/workspace.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';

/** What the server's hello frame lists today (Part B): a public send and nothing of a machine. */
const BROWSER: readonly Capability[] = ['send:public'];

/** Puts `capabilities` on the installed stub's env, as the preload or the browser bootstrap would. */
function withCapabilities(api: WirebenchApi, capabilities: readonly Capability[], host: 'electron' | 'browser'): void {
  Object.defineProperty(api, 'env', {
    configurable: true,
    value: { e2e: false, osTheme: 'dark', host, capabilities },
  });
}

function install(capabilities: readonly Capability[] | undefined, overrides = {}): WirebenchApi {
  const api = installWirebenchApi(overrides);
  if (capabilities !== undefined) {
    withCapabilities(api, capabilities, capabilities === ALL_CAPABILITIES ? 'electron' : 'browser');
  }
  return api;
}

const ROWS: WorkspaceSummaryWire[] = [
  {
    id: 'broken',
    name: 'broken',
    dir: '/user-data/workspaces/broken',
    projectCount: 0,
    internalProjectCount: 0,
    createdAt: '',
    unreadable: true,
  },
];

/** The embedded account as `account.list` shows it before `me` resolves: no user id yet. */
const SERVER: AccountWire = {
  url: 'https://team.example.test',
  userId: '',
  email: 'ada@example.test',
  displayName: 'Ada',
  deviceName: 'browser',
  signedOut: false,
  addedAt: '2026-10-28T00:00:00.000Z',
};

afterEach(() => {
  cleanup();
});

describe('hasCapability', () => {
  it('is every capability with no list at all, as a renderer test stub or the desktop has', () => {
    install(undefined);
    expect(ALL_CAPABILITIES.every((capability) => hasCapability(capability))).toBe(true);
  });

  it('answers from the env list when there is one', () => {
    install(BROWSER);
    expect(hasCapability('send:public')).toBe(true);
    expect(hasCapability('files')).toBe(false);
    expect(hasCapability('dialogs')).toBe(false);
  });
});

describe('the workspace picker by capability', () => {
  beforeEach(() => {
    useWorkspaceStore.setState({
      workspace: null,
      workspaces: [],
      suggestions: ['/old/project'],
      status: 'idle',
      error: undefined,
      lastError: undefined,
    });
    useAccountStore.setState({ servers: [SERVER] });
  });
  afterEach(() => {
    useAccountStore.setState({ servers: [] });
  });

  const listing = () => ({
    workspace: {
      list: vi.fn().mockResolvedValue({ ok: true, value: { workspaces: ROWS, suggestions: ['/old/project'] } }),
    },
  });

  it('offers only server workspaces without files and dialogs', async () => {
    install(BROWSER, listing());
    render(<WorkspacePicker />);
    await screen.findAllByTestId('workspace-picker-row');

    expect(screen.getByTestId('workspace-open-team')).toBeTruthy();
    expect(screen.queryByTestId('workspace-create')).toBeNull();
    expect(screen.queryByTestId('workspace-create-name')).toBeNull();
    expect(screen.queryByTestId('workspace-import-folder')).toBeNull();
    expect(screen.queryByTestId('workspace-join')).toBeNull();
    expect(screen.queryByText('Project folders you opened before')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reveal the folder of broken' })).toBeNull();
  });

  it('offers every way in with every capability, as the desktop does today', async () => {
    install(ALL_CAPABILITIES, listing());
    render(<WorkspacePicker />);
    await screen.findAllByTestId('workspace-picker-row');

    for (const id of ['workspace-create', 'workspace-import-folder', 'workspace-join', 'workspace-open-team']) {
      expect(screen.getByTestId(id)).toBeTruthy();
    }
    expect(screen.getByText('Project folders you opened before')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reveal the folder of broken' })).toBeTruthy();
  });
});

describe('the import dialog by capability', () => {
  beforeEach(() => {
    useProjectStore.getState().reset();
    resetKerberosAvailability();
  });

  const stubs = { definition: { cancelImport: vi.fn().mockResolvedValue({ ok: true, value: { cancelled: true } }) } };

  it('keeps URL imports and drops the file pickers without files and dialogs', () => {
    install(BROWSER, stubs);
    render(<ImportDialog open onOpenChange={vi.fn()} />);

    expect(screen.getByRole('tab', { name: 'URL' })).toBeTruthy();
    expect(screen.getByLabelText('Definition URL or file')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'File' }));
    expect(screen.queryByTestId('import-browse')).toBeNull();
    expect(screen.queryByTestId('import-browse-folder')).toBeNull();
    expect(screen.queryByTestId('import-file-input')).toBeNull();
    // A dropped file is read here, as text, so the drop zone stays.
    expect(screen.getByText('Drop an OpenAPI, Postman, WSDL or .proto file here')).toBeTruthy();
  });

  it('offers Browse… and the path with every capability', () => {
    install(ALL_CAPABILITIES, stubs);
    render(<ImportDialog open onOpenChange={vi.fn()} />);

    fireEvent.click(screen.getByRole('tab', { name: 'File' }));
    expect(screen.getByTestId('import-browse')).toBeTruthy();
    expect(screen.getByTestId('import-file-input')).toBeTruthy();
  });
});

describe('the explorer project menu by capability', () => {
  const project: ExplorerNode = { id: 'proj:p1', label: 'Node', kind: 'project', projectId: 'p1' };

  it('has no Reveal and no export without files and dialogs', () => {
    install(BROWSER);
    const labels = explorerMenuItems(project).map((item) => item.label);
    expect(labels.some((label) => /Reveal|file manager/.test(label))).toBe(false);
    expect(labels.some((label) => label.startsWith('Export'))).toBe(false);
    expect(labels).toContain('Move to workspace…');
  });

  it('has them with every capability', () => {
    install(ALL_CAPABILITIES);
    const labels = explorerMenuItems(project).map((item) => item.label);
    expect(labels).toContain('Export project…');
    expect(labels).toContain('Export as Postman Collection…');
    expect(labels.some((label) => /Reveal|file manager/.test(label))).toBe(true);
  });
});

describe('commands by capability', () => {
  const context = {} as CommandContext;

  beforeEach(() => {
    resetCommands();
    for (const id of ['workspace.create', 'app.checkForUpdates', 'workspace.manage'] as const) {
      registerCommand({
        id,
        label: id,
        category: 'Workspace',
        run: vi.fn(),
        unavailable: () => 'never listed for a missing capability',
      });
    }
  });
  afterEach(() => {
    resetCommands();
  });

  it('lists no command whose capability is missing, not even disabled in the palette', () => {
    install(BROWSER);
    expect(listCommands(context).map((command) => command.id)).toEqual(['workspace.manage']);
    expect(listPaletteCommands(context).map((row) => row.command.id)).toEqual(['workspace.manage']);
  });

  it('lists them all with every capability', () => {
    install(ALL_CAPABILITIES);
    expect(listCommands(context)).toHaveLength(3);
  });
});

describe('Settings by capability', () => {
  const sectionIds = (): string[] => availableNav().flatMap((group) => group.sections.map((section) => section.id));

  it('leaves out the sections the browser cannot use, and opens on the default instead of one', () => {
    install(BROWSER);
    const ids = sectionIds();
    for (const id of ['updates', 'git', 'plugins', 'terminal', 'ssh', 'secrets']) {
      expect(ids).not.toContain(id);
    }
    expect(ids).toContain('appearance');
    expect(resolveSection('updates')).toBe('appearance');
  });

  it('lists every section with every capability', () => {
    install(ALL_CAPABILITIES);
    expect(sectionIds()).toEqual(expect.arrayContaining(['updates', 'git', 'plugins', 'terminal', 'ssh', 'secrets']));
    expect(resolveSection('updates')).toBe('updates');
  });

  const areas: AppFeaturesWire = {
    states: [],
    areas: [
      {
        id: 'ssh',
        title: 'SSH',
        stage: 'stable',
        requires: [],
        default: true,
        policy: true,
        enabled: false,
        reason: { by: 'policy' },
      },
    ],
  };

  it('says an area is unavailable rather than set by the organisation when the capability is missing', async () => {
    install(BROWSER, { app: { features: vi.fn().mockResolvedValue({ ok: true, value: areas }) } });
    render(<FeaturesSection preferences={DEFAULT_PREFERENCES_WIRE} update={vi.fn()} />);

    const note = await screen.findByTestId('area-note-ssh');
    expect(note.textContent).toMatch(/^Not available in the browser/);
    expect(note.textContent).not.toMatch(/organisation|host/i);
  });

  it('still says "Set by your organisation" for an area the policy switches off on the desktop', async () => {
    install(ALL_CAPABILITIES, { app: { features: vi.fn().mockResolvedValue({ ok: true, value: areas }) } });
    render(<FeaturesSection preferences={DEFAULT_PREFERENCES_WIRE} update={vi.fn()} />);

    expect((await screen.findByTestId('area-note-ssh')).textContent).toBe('Set by your organisation');
  });
});

describe('Team secrets by capability', () => {
  afterEach(() => {
    useTeamSecretsStore.setState({ status: TEAM_SECRETS_OFF_STATUS, busy: false });
  });

  it('says values are resolved on the agent where the host holds no team-secrets key', () => {
    install(BROWSER);
    useTeamSecretsStore.setState({ status: TEAM_SECRETS_OFF_STATUS });
    render(<TeamSecretsSection />);

    expect(screen.getByTestId('team-secrets-elsewhere').textContent).toContain('resolved on the agent');
    expect(screen.queryByTestId('team-secrets-turn-on')).toBeNull();
  });

  it('renders nothing for an off status with every capability, as before', () => {
    install(ALL_CAPABILITIES);
    useTeamSecretsStore.setState({ status: TEAM_SECRETS_OFF_STATUS });
    const { container } = render(<TeamSecretsSection />);

    expect(container.textContent).toBe('');
  });
});
