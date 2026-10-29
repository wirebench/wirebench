import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
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
import {
  listAllCommands,
  listCommands,
  listPaletteCommands,
  registerCommand,
  resetCommands,
} from '../../src/renderer/lib/commands.js';
import { secretKeptHint } from '../../src/renderer/lib/capabilities.js';
import { useKeystoreAliases } from '../../src/renderer/components/use-keystore-aliases.js';
import { offeredImportFormats } from '../../src/renderer/features/explorer/import-formats.js';
import { useKerberosAvailability } from '../../src/renderer/lib/use-kerberos-availability.js';
import type { CommandContext } from '../../src/renderer/lib/commands.js';
import { resetKerberosAvailability } from '../../src/renderer/lib/use-kerberos-availability.js';
import { useAccountStore } from '../../src/renderer/state/account.js';
import { DEFAULT_PREFERENCES_WIRE } from '../../src/renderer/state/preferences-defaults.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import { TEAM_SECRETS_OFF_STATUS, useTeamSecretsStore } from '../../src/renderer/state/team-secrets.js';
import { useWorkspaceStore } from '../../src/renderer/state/workspace.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import { syncAppMenu } from '../../src/renderer/shell/app-menu.js';
import { subscribeToMocks } from '../../src/renderer/state/mock-runs.js';

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

  it('says nothing of Folder… for a folder format without dialogs', () => {
    install(BROWSER, stubs);
    render(<ImportDialog open onOpenChange={vi.fn()} initialFormat="postman-v3" />);
    fireEvent.click(screen.getByRole('tab', { name: 'File' }));
    expect(screen.queryByTestId('import-postman-v3-help')).toBeNull();
  });

  it('says how to pick a folder format with every capability', () => {
    install(ALL_CAPABILITIES, stubs);
    render(<ImportDialog open onOpenChange={vi.fn()} initialFormat="postman-v3" />);
    fireEvent.click(screen.getByRole('tab', { name: 'File' }));
    expect(screen.getByTestId('import-postman-v3-help')).toBeTruthy();
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

describe('the explorer mock entries by capability', () => {
  const mock: ExplorerNode = { id: 'mock:m1', label: 'Orders mock', kind: 'mock', mockId: 'm1' };

  it('offers no Start for a mock where the host cannot listen', () => {
    install(BROWSER);
    const labels = explorerMenuItems(mock).map((item) => item.label);
    expect(labels).toContain('Open');
    expect(labels).not.toContain('Start');
  });

  it('offers Start with every capability', () => {
    install(ALL_CAPABILITIES);
    expect(explorerMenuItems(mock).map((item) => item.label)).toContain('Start');
  });
});

describe('keystores and import formats by capability', () => {
  it('asks the host about no keystore without files', async () => {
    const inspect = vi.fn().mockResolvedValue({ ok: true, value: { aliases: [{ alias: 'k' }] } });
    install(BROWSER, { keystores: { inspect } });
    const { result } = renderHook(() => useKeystoreAliases('ks-1'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(inspect).not.toHaveBeenCalled();
    expect(result.current).toEqual([]);
  });

  it('asks with every capability', async () => {
    const inspect = vi.fn().mockResolvedValue({ ok: true, value: { aliases: [{ alias: 'k' }] } });
    install(ALL_CAPABILITIES, { keystores: { inspect } });
    const { result } = renderHook(() => useKeystoreAliases('ks-1'));
    await waitFor(() => {
      expect(result.current).toHaveLength(1);
    });
  });

  it('offers no format that is read only from a picked file without files', () => {
    install(BROWSER);
    expect(offeredImportFormats(['soap', 'rest']).map((row) => row.kind)).not.toContain('legacy-soap-project');
    install(ALL_CAPABILITIES);
    expect(offeredImportFormats(['soap', 'rest']).map((row) => row.kind)).toContain('legacy-soap-project');
  });
});

describe('secret hints and Kerberos by capability', () => {
  beforeEach(() => {
    resetKerberosAvailability();
  });

  it('says the OS keychain only where there is one', () => {
    install(ALL_CAPABILITIES);
    expect(secretKeptHint('Kept in the OS keychain.')).toBe('Kept in the OS keychain.');
    install(BROWSER);
    expect(secretKeptHint('Kept in the OS keychain.')).toBe('Sealed on the server and never shown again.');
  });

  it('answers Kerberos unavailable without asking where the host has none', async () => {
    const kerberosAvailability = vi.fn().mockResolvedValue({ ok: true, value: { available: true, platform: 'linux' } });
    install(BROWSER, { auth: { kerberosAvailability } });
    const { result } = renderHook(() => useKerberosAvailability());
    await waitFor(() => {
      expect(result.current?.available).toBe(false);
    });
    expect(result.current?.reason).toMatch(/^Kerberos is not available here/);
    expect(kerberosAvailability).not.toHaveBeenCalled();
  });

  it('asks the host with every capability', async () => {
    const kerberosAvailability = vi.fn().mockResolvedValue({ ok: true, value: { available: true, platform: 'linux' } });
    install(ALL_CAPABILITIES, { auth: { kerberosAvailability } });
    const { result } = renderHook(() => useKerberosAvailability());
    await waitFor(() => {
      expect(result.current?.available).toBe(true);
    });
    expect(kerberosAvailability).toHaveBeenCalledTimes(1);
  });
});

describe('commands by capability', () => {
  const context = {} as CommandContext;

  beforeEach(() => {
    resetCommands();
    for (const id of [
      'workspace.create',
      'app.checkForUpdates',
      'workspace.manage',
      'mock.start',
      'workspace.newWindow',
      'secrets.toggleShowSecrets',
      'account.signIn',
    ] as const) {
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
    // Nor in the menu and shortcuts table: no click could run them.
    expect(listAllCommands().map((command) => command.id)).toEqual(['workspace.manage']);
  });

  it('lists them all with every capability', () => {
    install(ALL_CAPABILITIES);
    expect(listCommands(context)).toHaveLength(7);
    expect(listAllCommands()).toHaveLength(7);
  });

  it('declares listen, windows, accounts and reveal-secrets, which the desktop has and the browser does not', () => {
    const local: readonly Capability[] = ['listen', 'windows', 'accounts', 'reveal-secrets'];
    expect(ALL_CAPABILITIES).toEqual(expect.arrayContaining([...local]));
    for (const capability of local) expect(BROWSER).not.toContain(capability);
  });
});

describe('Settings by capability', () => {
  const sectionIds = (): string[] => availableNav().flatMap((group) => group.sections.map((section) => section.id));

  it('leaves out the sections the browser cannot use, and opens on the default instead of one', () => {
    install(BROWSER);
    const ids = sectionIds();
    for (const id of ['updates', 'git', 'plugins', 'terminal', 'ssh', 'secrets', 'mocks']) {
      expect(ids).not.toContain(id);
    }
    expect(ids).toContain('appearance');
    expect(resolveSection('updates')).toBe('appearance');
  });

  it('lists every section with every capability', () => {
    install(ALL_CAPABILITIES);
    expect(sectionIds()).toEqual(
      expect.arrayContaining(['updates', 'git', 'plugins', 'terminal', 'ssh', 'secrets', 'mocks']),
    );
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
    expect(note.textContent).toMatch(/^Not available here: /);
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

describe('start-up calls by capability', () => {
  it('pushes no native menu without windows, and does with it', async () => {
    const registerMenu = vi.fn().mockResolvedValue({ ok: true, value: {} });
    install(BROWSER, { app: { registerMenu } });
    await syncAppMenu();
    expect(registerMenu).not.toHaveBeenCalled();
    install(ALL_CAPABILITIES, { app: { registerMenu } });
    await syncAppMenu();
    expect(registerMenu).toHaveBeenCalledTimes(1);
  });

  it('asks for no mock states without listen, and does with it', () => {
    const states = vi.fn().mockResolvedValue({ ok: true, value: { states: [] } });
    install(BROWSER, { mock: { states } });
    subscribeToMocks()();
    expect(states).not.toHaveBeenCalled();
    install(ALL_CAPABILITIES, { mock: { states } });
    subscribeToMocks()();
    expect(states).toHaveBeenCalledTimes(1);
  });
});
