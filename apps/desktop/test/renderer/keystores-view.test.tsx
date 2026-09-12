import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { KeystoresView } from '../../src/renderer/features/wss/keystores-view.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import type { KeystoreWire, ProjectWire } from '../../src/shared/wire-types.js';

const corp: KeystoreWire = {
  id: 'k1',
  name: 'corp',
  path: '/tmp/demo/certs/corp.p12',
  type: 'pkcs12',
  passwordSecretRef: 'secret:1',
};

const project = { id: 'p1', name: 'Demo', dir: '/tmp/demo' } as unknown as ProjectWire;

const ALIAS = {
  alias: 'client',
  subject: 'CN=wirebench-client, O=Wirebench Tests',
  issuer: 'CN=Wirebench Test CA',
  notAfter: '2030-01-02T03:04:05.000Z',
  fingerprintSha256: 'AB:CD:EF',
  hasPrivateKey: true,
};

type Stub = ReturnType<typeof vi.fn<(request: never) => Promise<unknown>>>;

function setUp(
  options: {
    readonly keystores?: readonly KeystoreWire[];
    readonly inspect?: Stub;
    readonly pickFile?: Stub;
    readonly replaceSecret?: Stub;
  } = {},
) {
  const inspect = options.inspect ?? vi.fn().mockResolvedValue({ ok: true, value: { status: 'ok', aliases: [ALIAS] } });
  const pickFile = options.pickFile ?? vi.fn().mockResolvedValue({ ok: true, value: { path: '/picked/corp.p12' } });
  const replace = options.replaceSecret ?? vi.fn().mockResolvedValue({ ok: true, value: { ref: 'secret:1' } });
  installWirebenchApi({ keystores: { inspect, pickFile }, secrets: { replace } });
  const actions = {
    addKeystore: vi.fn().mockResolvedValue('k2'),
    updateKeystore: vi.fn().mockResolvedValue(undefined),
    removeKeystore: vi.fn().mockResolvedValue(undefined),
  };
  useProjectStore.setState({
    projects: { p1: project },
    keystores: (options.keystores ?? [corp]).map((keystore) => ({ ...keystore, projectId: 'p1' })),
    ...actions,
  });
  render(
    <TooltipPrimitive.Provider>
      <KeystoresView />
    </TooltipPrimitive.Provider>,
  );
  return { ...actions, inspect, pickFile, replace };
}

afterEach(() => {
  cleanup();
  useProjectStore.getState().reset();
});

describe('KeystoresView', () => {
  it('lists a row per keystore with its type badge and load status', async () => {
    setUp();

    const row = await screen.findByTestId('keystore-row');
    expect(row.textContent).toContain('corp');
    expect(row.textContent).toContain('p12');
    await waitFor(() => {
      expect(screen.getByTestId('keystore-status').textContent).toBe('Loaded');
    });
  });

  it('renders the failure status a bad password produces', async () => {
    setUp({
      inspect: vi.fn().mockResolvedValue({ ok: true, value: { status: 'bad-password', aliases: [] } }),
    });

    await waitFor(() => {
      expect(screen.getByTestId('keystore-status').textContent).toBe('Wrong password');
    });
  });

  it('shows the aliases when the row is expanded, and sets one as the default', async () => {
    const { updateKeystore } = setUp();
    await waitFor(() => {
      expect(screen.getByTestId('keystore-status').textContent).toBe('Loaded');
    });

    fireEvent.click(screen.getByRole('button', { expanded: false }));

    const alias = await screen.findByTestId('keystore-alias-row');
    expect(alias.textContent).toContain('client');
    expect(alias.textContent).toContain('CN=wirebench-client');
    expect(alias.textContent).toContain('AB:CD:EF');

    fireEvent.click(screen.getByRole('button', { name: 'Set as default' }));
    expect(updateKeystore).toHaveBeenCalledWith('k1', { defaultAlias: 'client' });
  });

  it('adds a keystore through the picker, defaulting the name to the file stem', async () => {
    const { addKeystore, pickFile } = setUp({ keystores: [] });

    fireEvent.click(screen.getByLabelText('Add keystore'));
    fireEvent.click(await screen.findByTestId('keystore-browse'));

    await waitFor(() => {
      expect(pickFile).toHaveBeenCalled();
      expect(screen.getByTestId<HTMLInputElement>('keystore-path').value).toBe('/picked/corp.p12');
      expect(screen.getByTestId<HTMLInputElement>('keystore-name').value).toBe('corp');
    });

    fireEvent.click(screen.getByTestId('keystore-add-submit'));
    await waitFor(() => {
      expect(addKeystore).toHaveBeenCalledWith('p1', { path: '/picked/corp.p12', name: 'corp' });
    });
  });

  it('cannot submit before a file has been chosen', async () => {
    setUp({ keystores: [] });

    fireEvent.click(screen.getByLabelText('Add keystore'));

    expect((await screen.findByTestId('keystore-add-submit')).hasAttribute('disabled')).toBe(true);
  });

  it('removes a keystore only after the confirmation', async () => {
    const { removeKeystore } = setUp();

    fireEvent.click(await screen.findByLabelText('Remove corp'));
    expect(removeKeystore).not.toHaveBeenCalled();

    fireEvent.click(await screen.findByTestId('keystore-remove-confirm'));
    expect(removeKeystore).toHaveBeenCalledWith('k1');
  });

  it('replaces a keystore password in place and re-inspects with it', async () => {
    // The wrong-password cure must not be "remove and add again": the row itself takes a new
    // password, and the row's status is re-read afterwards even though the ref never changed.
    const inspect = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, value: { status: 'bad-password', aliases: [] } })
      .mockResolvedValue({ ok: true, value: { status: 'ok', aliases: [ALIAS] } });
    const { updateKeystore, replace } = setUp({ inspect });

    await waitFor(() => {
      expect(screen.getByTestId('keystore-status').textContent).toBe('Wrong password');
    });
    fireEvent.click(screen.getByRole('button', { expanded: false }));

    const field = await screen.findByTestId('keystore-password');
    fireEvent.click(within(field).getByRole('button', { name: 'Replace…' }));
    fireEvent.change(within(field).getByPlaceholderText('Enter password'), { target: { value: 'correct' } });
    fireEvent.click(within(field).getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith({ ref: 'secret:1', value: 'correct' });
      expect(updateKeystore).toHaveBeenCalledWith('k1', { passwordSecretRef: 'secret:1' });
    });
    await waitFor(() => {
      expect(screen.getByTestId('keystore-status').textContent).toBe('Loaded');
    });
    expect(inspect).toHaveBeenCalledTimes(2);
  });

  it('exposes the list as a grid of rows and cells, one tab stop, arrow-navigable', async () => {
    setUp({ keystores: [corp, { ...corp, id: 'k2', name: 'partner' }] });

    const grid = screen.getByRole('grid', { name: 'Keystores' });
    expect(grid.getAttribute('aria-rowcount')).toBe('2');
    const rows = await screen.findAllByRole('row');
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.tabIndex)).toEqual([0, -1]);
    expect(rows.every((row) => within(row).getAllByRole('gridcell').length > 0)).toBe(true);

    fireEvent.keyDown(rows[0] as HTMLElement, { key: 'ArrowDown' });
    expect(screen.getAllByRole('row').map((row) => row.tabIndex)).toEqual([-1, 0]);
  });

  it('invites the user to pick a project when none is open', () => {
    installWirebenchApi({});
    useProjectStore.getState().reset();
    render(
      <TooltipPrimitive.Provider>
        <KeystoresView />
      </TooltipPrimitive.Provider>,
    );

    expect(screen.getByText('Select a project to add keystores.')).toBeTruthy();
    expect(screen.getByLabelText('Add keystore').hasAttribute('disabled')).toBe(true);
  });
});
