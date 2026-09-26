/**
 * Update Definition for an OpenAPI-imported REST API: the dialog shows what the source would change,
 * per operation, and applies exactly the plan it showed — the fingerprint goes back, a source that
 * changed in between is said so with a way to look again, and an API with no source to read again
 * asks for a file or URL. The entry points (API tab, palette command, action) exist only for an API
 * that records a definition.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/renderer/editor/monaco.js', async () => await import('../mocks/monaco-runtime.js'));
const { showToast } = vi.hoisted(() => ({ showToast: vi.fn() }));
vi.mock('../../src/renderer/components/toast.js', () => ({ showToast }));

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { RestUpdateDialog } from '../../src/renderer/features/rest-api/rest-update-dialog.js';
import { ApiTab } from '../../src/renderer/features/rest-api/api-tab.js';
import { updateRestDefinition } from '../../src/renderer/features/rest-api/api-actions.js';
import { useRestUpdateStore } from '../../src/renderer/features/rest-api/rest-update-state.js';
import { registerShellCommands } from '../../src/renderer/commands/register-shell-commands.js';
import { getCommand, type CommandContext } from '../../src/renderer/lib/commands.js';
import { useEditorsStore } from '../../src/renderer/state/editors.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import { restApiWire } from '../helpers/wire-defaults.js';
import type { RestApiWire } from '../../src/shared/wire-types.js';

const FP1 = 'a'.repeat(64);
const FP2 = 'b'.repeat(64);

const RECORDED_SOURCE = 'https://pets.example.test/openapi.yaml';

const PLAN = {
  added: [{ method: 'post', path: '/pets' }],
  removed: [{ method: 'delete', path: '/pets/{id}' }],
  changed: [{ op: { method: 'get', path: '/pets/{id}' }, reasons: ['parameters' as const, 'responses' as const] }],
  api: ['version' as const],
  source: RECORDED_SOURCE,
  fingerprint: FP1,
};

const APPLIED = {
  project: { id: 'p1' },
  plan: PLAN,
  applied: {
    requestsAdded: 1,
    requestsAlreadyPresent: 0,
    requestsOrphaned: 1,
    requestsRestored: 0,
    requestsRewritten: 2,
    rowsAdded: 0,
    rowsRemoved: 0,
  },
};

const DEFINED = restApiWire({ definition: { source: 'https://api.test/openapi.yaml', cache: true, version: '1.0.0' } });
/** Imported with definition caching off: a source, but no cached document to compare against. */
const UNCACHED = restApiWire({
  id: 'uncached',
  definition: { source: 'https://api.test/openapi.yaml', cache: false, version: '1.0.0' },
});

function seed(api: RestApiWire, applySnapshot = vi.fn()): void {
  useProjectStore.setState({
    apis: { [api.id]: api },
    projectOf: { [api.id]: 'p1' },
    applySnapshot,
  } as never);
}

beforeEach(() => {
  showToast.mockReset();
  useRestUpdateStore.getState().close();
  useEditorsStore.setState({ tabs: [], activeId: undefined });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** Imported by URL behind Basic: the credentials Update Definition reuses without asking. */
const PROTECTED = restApiWire({
  id: 'protected',
  definition: {
    source: 'https://api.test/openapi.yaml',
    cache: true,
    version: '1.0.0',
    auth: { type: 'basic', username: 'ada', passwordRef: 'ref-p' },
  },
});

describe('RestUpdateDialog', () => {
  it('is a labelled dialog that lists added, removed and changed operations, and applies with the fingerprint', async () => {
    const plan = vi.fn().mockResolvedValue({ ok: true, value: PLAN });
    const apply = vi.fn().mockResolvedValue({ ok: true, value: APPLIED });
    installWirebenchApi({ api: { restPlanUpdate: plan, restApplyUpdate: apply } });
    const applySnapshot = vi.fn();
    seed(DEFINED, applySnapshot);
    const onOpenChange = vi.fn();

    render(<RestUpdateDialog apiId={DEFINED.id} open onOpenChange={onOpenChange} />);

    expect(screen.getByRole('dialog', { name: 'Update definition' })).toBeTruthy();
    await waitFor(() => expect(plan).toHaveBeenCalledWith({ apiId: DEFINED.id }));
    expect((await screen.findByTestId('rest-update-added')).textContent).toContain('POST /pets');
    expect(screen.getByTestId('rest-update-removed').textContent).toContain('DELETE /pets/{id}');
    const changed = within(screen.getByTestId('rest-update-changed')).getAllByRole('listitem');
    expect(changed[0]!.textContent).toBe('GET /pets/{id}: parameters, responses');
    expect(screen.getByTestId('rest-update-api').textContent).toContain('version');
    // Nothing was chosen here, so the header names the recorded source the preview reported.
    expect(screen.getByTestId('rest-update-source').textContent).toContain(RECORDED_SOURCE);

    fireEvent.click(screen.getByTestId('rest-update-apply'));
    await waitFor(() => expect(apply).toHaveBeenCalledWith({ apiId: DEFINED.id, fingerprint: FP1 }));
    await waitFor(() => expect(applySnapshot).toHaveBeenCalledWith('p1', APPLIED.project));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(showToast).toHaveBeenCalledWith('Definition updated — 1 added, 2 rewritten, 1 orphaned, 0 restored');
  });

  it('shows it is reading the source, with Apply disabled, until the plan arrives', async () => {
    let answer: (value: unknown) => void = () => undefined;
    installWirebenchApi({
      api: { restPlanUpdate: vi.fn().mockReturnValue(new Promise((resolve) => (answer = resolve))) },
    });
    seed(DEFINED);
    render(<RestUpdateDialog apiId={DEFINED.id} open onOpenChange={vi.fn()} />);
    expect(screen.getByRole('status').textContent).toContain('Reading the source');
    expect(screen.getByTestId<HTMLButtonElement>('rest-update-apply').disabled).toBe(true);
    answer({ ok: true, value: PLAN });
    await waitFor(() => expect(screen.getByTestId<HTMLButtonElement>('rest-update-apply').disabled).toBe(false));
  });

  it('says nothing would change when the plan is empty', async () => {
    installWirebenchApi({
      api: {
        restPlanUpdate: vi.fn().mockResolvedValue({
          ok: true,
          value: { added: [], removed: [], changed: [], api: [], source: RECORDED_SOURCE, fingerprint: FP1 },
        }),
      },
    });
    seed(DEFINED);
    render(<RestUpdateDialog apiId={DEFINED.id} open onOpenChange={vi.fn()} />);
    expect((await screen.findByTestId('rest-update-empty')).textContent).toContain('already matches its source');
  });

  it('says so when the source changed since the preview, and previews again on request', async () => {
    const plan = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, value: PLAN })
      .mockResolvedValueOnce({ ok: true, value: { ...PLAN, fingerprint: FP2 } });
    const apply = vi.fn().mockResolvedValueOnce({
      ok: false,
      error: { code: 'definition-changed', message: 'The definition changed since it was previewed' },
    });
    installWirebenchApi({ api: { restPlanUpdate: plan, restApplyUpdate: apply } });
    seed(DEFINED);
    render(<RestUpdateDialog apiId={DEFINED.id} open onOpenChange={vi.fn()} />);
    await screen.findByTestId('rest-update-added');
    fireEvent.click(screen.getByTestId('rest-update-apply'));

    expect((await screen.findByTestId('rest-update-changed-since')).textContent).toContain('changed since');
    expect(screen.getByTestId<HTMLButtonElement>('rest-update-apply').disabled).toBe(true);
    fireEvent.click(screen.getByTestId('rest-update-replan'));
    await waitFor(() => expect(plan).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByTestId('rest-update-changed-since')).toBeNull());

    apply.mockResolvedValueOnce({ ok: true, value: APPLIED });
    fireEvent.click(await screen.findByTestId('rest-update-apply'));
    await waitFor(() => expect(apply).toHaveBeenLastCalledWith({ apiId: DEFINED.id, fingerprint: FP2 }));
  });

  it('shows main’s message for any other refusal, such as a definition that was not cached', async () => {
    installWirebenchApi({
      api: {
        restPlanUpdate: vi.fn().mockResolvedValue({
          ok: false,
          error: { code: 'definition-not-cached', message: 'This API has no cached definition; import it again.' },
        }),
      },
    });
    seed(DEFINED);
    render(<RestUpdateDialog apiId={DEFINED.id} open onOpenChange={vi.fn()} />);
    expect((await screen.findByTestId('rest-update-error')).textContent).toContain('no cached definition');
    expect(screen.getByTestId<HTMLButtonElement>('rest-update-apply').disabled).toBe(true);
  });

  it('asks for a URL when there is no source to read again, and sends that source to plan and apply', async () => {
    const plan = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: { code: 'definition-source-unavailable', message: 'no source' } })
      .mockResolvedValueOnce({ ok: true, value: PLAN });
    const apply = vi.fn().mockResolvedValue({ ok: true, value: APPLIED });
    installWirebenchApi({ api: { restPlanUpdate: plan, restApplyUpdate: apply } });
    seed(DEFINED);
    render(<RestUpdateDialog apiId={DEFINED.id} open onOpenChange={vi.fn()} />);

    expect((await screen.findByTestId('rest-update-error')).textContent).toContain('pasted text');
    const input = screen.getByLabelText('URL');
    fireEvent.change(input, { target: { value: ' https://new.test/o.yaml ' } });
    fireEvent.click(screen.getByTestId('rest-update-url-preview'));
    const source = { kind: 'url', url: 'https://new.test/o.yaml' };
    await waitFor(() => expect(plan).toHaveBeenLastCalledWith({ apiId: DEFINED.id, source }));
    expect((await screen.findByTestId('rest-update-source')).textContent).toContain('https://new.test/o.yaml');

    fireEvent.click(await screen.findByTestId('rest-update-apply'));
    await waitFor(() => expect(apply).toHaveBeenCalledWith({ apiId: DEFINED.id, source, fingerprint: FP1 }));
  });

  it('says in the toast when the update was saved but the stored definition could not be refreshed', async () => {
    const warning = 'The update was saved, but the stored copy of the definition could not be refreshed: disk full';
    const apply = vi.fn().mockResolvedValue({ ok: true, value: { ...APPLIED, warning } });
    installWirebenchApi({
      api: { restPlanUpdate: vi.fn().mockResolvedValue({ ok: true, value: PLAN }), restApplyUpdate: apply },
    });
    seed(DEFINED);
    render(<RestUpdateDialog apiId={DEFINED.id} open onOpenChange={vi.fn()} />);
    fireEvent.click(await screen.findByTestId('rest-update-apply'));
    await waitFor(() => expect(showToast).toHaveBeenCalled());
    expect(showToast.mock.calls[0]![0]).toContain('Definition updated — 1 added');
    expect(showToast.mock.calls[0]![0]).toContain(warning);
  });

  it('refuses a file: URL in the field itself rather than showing a raw validation failure', async () => {
    const plan = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: { code: 'definition-source-unavailable', message: 'no source' } });
    installWirebenchApi({ api: { restPlanUpdate: plan } });
    seed(DEFINED);
    render(<RestUpdateDialog apiId={DEFINED.id} open onOpenChange={vi.fn()} />);
    await screen.findByTestId('rest-update-error');

    const input = screen.getByLabelText('URL');
    fireEvent.change(input, { target: { value: 'file:///Users/me/.ssh/id_rsa' } });
    fireEvent.click(screen.getByTestId('rest-update-url-preview'));
    expect(screen.getByTestId('rest-update-url-error').textContent).toContain('Only http and https URLs');
    // Never sent: the first call was the automatic preview, and no second one followed.
    expect(plan).toHaveBeenCalledTimes(1);

    fireEvent.change(input, { target: { value: 'https://ok.test/o.yaml' } });
    expect(screen.queryByTestId('rest-update-url-error')).toBeNull();
  });

  it('lets only the newest preview set the plan, so a slow answer cannot pair with a later header', async () => {
    let answerA: (value: unknown) => void = () => undefined;
    let answerB: (value: unknown) => void = () => undefined;
    const plan = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: { code: 'definition-source-unavailable', message: 'no source' } })
      .mockReturnValueOnce(new Promise((resolve) => (answerA = resolve)))
      .mockReturnValueOnce(new Promise((resolve) => (answerB = resolve)));
    installWirebenchApi({ api: { restPlanUpdate: plan } });
    seed(DEFINED);
    render(<RestUpdateDialog apiId={DEFINED.id} open onOpenChange={vi.fn()} />);
    await screen.findByTestId('rest-update-error');

    const input = screen.getByLabelText('URL');
    fireEvent.change(input, { target: { value: 'https://a.test/o.yaml' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.change(input, { target: { value: 'https://b.test/o.yaml' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    // B answers first, then the slower A: A must not overwrite what B showed.
    answerB({ ok: true, value: { ...PLAN, added: [{ method: 'post', path: '/from-b' }], fingerprint: FP2 } });
    await waitFor(() => expect(screen.getByTestId('rest-update-added').textContent).toContain('POST /from-b'));
    answerA({ ok: true, value: { ...PLAN, added: [{ method: 'post', path: '/from-a' }] } });
    await Promise.resolve();
    expect(screen.getByTestId('rest-update-added').textContent).toContain('POST /from-b');
    expect(screen.getByTestId('rest-update-source').textContent).toContain('https://b.test/o.yaml');
  });

  it('offers another file on request, and previews the file picked', async () => {
    const plan = vi.fn().mockResolvedValue({ ok: true, value: PLAN });
    const openFile = vi.fn().mockResolvedValue({ ok: true, value: { path: '/defs/next.yaml' } });
    installWirebenchApi({ api: { restPlanUpdate: plan }, dialogs: { openFile } });
    seed(DEFINED);
    render(<RestUpdateDialog apiId={DEFINED.id} open onOpenChange={vi.fn()} />);
    await screen.findByTestId('rest-update-added');

    fireEvent.click(screen.getByTestId('rest-update-choose'));
    fireEvent.click(screen.getByTestId('rest-update-browse'));
    await waitFor(() =>
      expect(plan).toHaveBeenLastCalledWith({ apiId: DEFINED.id, source: { kind: 'file', path: '/defs/next.yaml' } }),
    );
  });

  it('shows an error and lets the user try again when the plan call itself fails', async () => {
    const plan = vi
      .fn()
      .mockRejectedValueOnce(new Error('bridge is gone'))
      .mockResolvedValueOnce({ ok: true, value: PLAN });
    installWirebenchApi({ api: { restPlanUpdate: plan } });
    seed(DEFINED);
    render(<RestUpdateDialog apiId={DEFINED.id} open onOpenChange={vi.fn()} />);

    expect((await screen.findByTestId('rest-update-error')).textContent).toContain('bridge is gone');
    expect(screen.queryByRole('status')).toBeNull();

    fireEvent.click(screen.getByTestId('rest-update-choose'));
    fireEvent.change(screen.getByLabelText('URL'), { target: { value: 'https://new.test/o.yaml' } });
    fireEvent.click(screen.getByTestId('rest-update-url-preview'));
    expect(await screen.findByTestId('rest-update-added')).toBeTruthy();
  });

  it('shows an error and leaves Apply usable when the apply call itself fails', async () => {
    const apply = vi
      .fn()
      .mockRejectedValueOnce(new Error('bridge is gone'))
      .mockResolvedValueOnce({ ok: true, value: APPLIED });
    installWirebenchApi({
      api: { restPlanUpdate: vi.fn().mockResolvedValue({ ok: true, value: PLAN }), restApplyUpdate: apply },
    });
    seed(DEFINED);
    render(<RestUpdateDialog apiId={DEFINED.id} open onOpenChange={vi.fn()} />);
    fireEvent.click(await screen.findByTestId('rest-update-apply'));

    expect((await screen.findByTestId('rest-update-error')).textContent).toContain('bridge is gone');
    await waitFor(() => expect(screen.getByTestId<HTMLButtonElement>('rest-update-apply').disabled).toBe(false));
    fireEvent.click(screen.getByTestId('rest-update-apply'));
    await waitFor(() => expect(apply).toHaveBeenCalledTimes(2));
  });

  it('previews again against the source the user chose, not the recorded one', async () => {
    const plan = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, value: PLAN })
      .mockResolvedValueOnce({ ok: true, value: PLAN })
      .mockResolvedValueOnce({ ok: true, value: { ...PLAN, fingerprint: FP2 } });
    const apply = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: { code: 'definition-changed', message: 'changed' } });
    installWirebenchApi({ api: { restPlanUpdate: plan, restApplyUpdate: apply } });
    seed(DEFINED);
    render(<RestUpdateDialog apiId={DEFINED.id} open onOpenChange={vi.fn()} />);
    await screen.findByTestId('rest-update-added');

    const source = { kind: 'url', url: 'https://new.test/o.yaml' };
    fireEvent.click(screen.getByTestId('rest-update-choose'));
    fireEvent.change(screen.getByLabelText('URL'), { target: { value: source.url } });
    fireEvent.click(screen.getByTestId('rest-update-url-preview'));
    await waitFor(() => expect(plan).toHaveBeenLastCalledWith({ apiId: DEFINED.id, source }));

    fireEvent.click(await screen.findByTestId('rest-update-apply'));
    fireEvent.click(await screen.findByTestId('rest-update-replan'));
    await waitFor(() => expect(plan).toHaveBeenCalledTimes(3));
    expect(plan).toHaveBeenLastCalledWith({ apiId: DEFINED.id, source });
  });

  it('asks for nothing when the API records credentials: main reads the source with them', async () => {
    const plan = vi.fn().mockResolvedValue({ ok: true, value: PLAN });
    installWirebenchApi({ api: { restPlanUpdate: plan } });
    seed(PROTECTED);
    render(<RestUpdateDialog apiId={PROTECTED.id} open onOpenChange={vi.fn()} />);

    await waitFor(() => expect(plan).toHaveBeenCalledWith({ apiId: PROTECTED.id }));
    await screen.findByTestId('rest-update-added');
    expect(screen.queryByTestId('definition-auth')).toBeNull();
  });

  it('offers the stored credentials for another URL on the same origin only', async () => {
    const plan = vi.fn().mockResolvedValue({ ok: true, value: PLAN });
    installWirebenchApi({ api: { restPlanUpdate: plan } });
    seed(PROTECTED);
    render(<RestUpdateDialog apiId={PROTECTED.id} open onOpenChange={vi.fn()} />);
    await screen.findByTestId('rest-update-added');
    fireEvent.click(screen.getByTestId('rest-update-choose'));
    const type = () => screen.getByLabelText<HTMLSelectElement>('Definition authentication type').value;
    expect(type()).toBe('none');

    fireEvent.change(screen.getByLabelText('URL'), { target: { value: 'https://api.test/v2/openapi.yaml' } });
    expect(type()).toBe('basic');
    expect(screen.getByLabelText<HTMLInputElement>('Definition username').value).toBe('ada');
    fireEvent.click(screen.getByTestId('rest-update-url-preview'));
    await waitFor(() =>
      expect(plan).toHaveBeenLastCalledWith({
        apiId: PROTECTED.id,
        source: {
          kind: 'url',
          url: 'https://api.test/v2/openapi.yaml',
          auth: { type: 'basic', username: 'ada', passwordRef: 'ref-p' },
        },
      }),
    );

    fireEvent.change(screen.getByLabelText('URL'), { target: { value: 'https://mirror.test/openapi.yaml' } });
    expect(type()).toBe('none');
    fireEvent.click(screen.getByTestId('rest-update-url-preview'));
    await waitFor(() =>
      expect(plan).toHaveBeenLastCalledWith({
        apiId: PROTECTED.id,
        source: { kind: 'url', url: 'https://mirror.test/openapi.yaml' },
      }),
    );
  });

  it('stores an edit to the offered password under a new reference, never over the stored one', async () => {
    const plan = vi.fn().mockResolvedValue({ ok: true, value: PLAN });
    const set = vi.fn().mockResolvedValue({ ok: true, value: { ref: 'ref-new' } });
    const replace = vi.fn().mockResolvedValue({ ok: true, value: { ref: 'ref-p' } });
    installWirebenchApi({
      api: { restPlanUpdate: plan },
      secrets: { set, replace, exists: vi.fn().mockResolvedValue({ ok: true, value: { exists: true } }) },
    });
    seed(PROTECTED);
    const onOpenChange = vi.fn();
    render(<RestUpdateDialog apiId={PROTECTED.id} open onOpenChange={onOpenChange} />);
    await screen.findByTestId('rest-update-added');
    fireEvent.click(screen.getByTestId('rest-update-choose'));
    fireEvent.change(screen.getByLabelText('URL'), { target: { value: 'https://api.test/v2/openapi.yaml' } });

    fireEvent.click(screen.getByRole('button', { name: 'Replace…' }));
    fireEvent.change(screen.getByLabelText('Definition password'), { target: { value: 'typed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(set).toHaveBeenCalledTimes(1));
    expect(set.mock.calls[0]?.[0]).toMatchObject({ value: 'typed' });

    fireEvent.click(screen.getByTestId('rest-update-url-preview'));
    await waitFor(() =>
      expect(plan).toHaveBeenLastCalledWith({
        apiId: PROTECTED.id,
        source: {
          kind: 'url',
          url: 'https://api.test/v2/openapi.yaml',
          auth: { type: 'basic', username: 'ada', passwordRef: 'ref-new' },
        },
      }),
    );

    // Cancelling leaves the API's stored credential exactly as it was.
    fireEvent.click(screen.getByTestId('rest-update-cancel'));
    expect(replace).not.toHaveBeenCalled();
  });

  it('opens the chooser on the recorded URL when it needs authentication, with the message', async () => {
    const message = 'The definition at https://api.test/openapi.yaml refused the credentials given (HTTP 401).';
    const plan = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: { code: 'definition-auth-required', message } })
      .mockResolvedValueOnce({ ok: true, value: PLAN });
    installWirebenchApi({ api: { restPlanUpdate: plan } });
    seed(PROTECTED);
    render(<RestUpdateDialog apiId={PROTECTED.id} open onOpenChange={vi.fn()} />);

    expect((await screen.findByTestId('rest-update-error')).textContent).toBe(message);
    expect(screen.getByTestId('rest-update-chooser')).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>('URL').value).toBe('https://api.test/openapi.yaml');
    expect(screen.getByLabelText<HTMLSelectElement>('Definition authentication type').value).toBe('basic');

    fireEvent.click(screen.getByTestId('rest-update-url-preview'));
    await waitFor(() => expect(plan).toHaveBeenCalledTimes(2));
    expect(plan).toHaveBeenLastCalledWith({
      apiId: PROTECTED.id,
      source: {
        kind: 'url',
        url: 'https://api.test/openapi.yaml',
        auth: { type: 'basic', username: 'ada', passwordRef: 'ref-p' },
      },
    });
  });

  it('applies once however often Apply is clicked', async () => {
    let answer: (value: unknown) => void = () => undefined;
    const apply = vi.fn().mockReturnValue(new Promise((resolve) => (answer = resolve)));
    installWirebenchApi({
      api: { restPlanUpdate: vi.fn().mockResolvedValue({ ok: true, value: PLAN }), restApplyUpdate: apply },
    });
    seed(DEFINED);
    render(<RestUpdateDialog apiId={DEFINED.id} open onOpenChange={vi.fn()} />);
    const button = await screen.findByTestId('rest-update-apply');
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(button);

    await waitFor(() => expect(screen.getByTestId<HTMLButtonElement>('rest-update-apply').disabled).toBe(true));
    expect(apply).toHaveBeenCalledTimes(1);
    answer({ ok: true, value: APPLIED });
  });

  it('still records an apply that lands after the dialog unmounted, but no longer drives the dialog', async () => {
    let answer: (value: unknown) => void = () => undefined;
    const apply = vi.fn().mockReturnValue(new Promise((resolve) => (answer = resolve)));
    installWirebenchApi({
      api: { restPlanUpdate: vi.fn().mockResolvedValue({ ok: true, value: PLAN }), restApplyUpdate: apply },
    });
    const applySnapshot = vi.fn();
    seed(DEFINED, applySnapshot);
    const onOpenChange = vi.fn();
    const view = render(<RestUpdateDialog apiId={DEFINED.id} open onOpenChange={onOpenChange} />);
    fireEvent.click(await screen.findByTestId('rest-update-apply'));
    await waitFor(() => expect(apply).toHaveBeenCalled());
    view.unmount();
    answer({ ok: true, value: APPLIED });
    await waitFor(() => expect(applySnapshot).toHaveBeenCalledWith('p1', APPLIED.project));
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalled();
  });
});

describe('REST Update Definition entry points', () => {
  beforeAll(() => {
    installWirebenchApi();
    registerShellCommands(() => undefined);
  });

  function mountTab(api: RestApiWire): void {
    useProjectStore.setState({
      projects: {},
      apis: { [api.id]: api },
      projectOf: { [api.id]: 'p1' },
      updateApi: vi.fn(),
    } as never);
    render(
      <TooltipPrimitive.Provider>
        <ApiTab apiId={api.id} />
      </TooltipPrimitive.Provider>,
    );
  }

  it('the API tab offers Update definition… for an imported API, and it opens the dialog', async () => {
    installWirebenchApi({ api: { restPlanUpdate: vi.fn().mockResolvedValue({ ok: true, value: PLAN }) } });
    mountTab(DEFINED);
    fireEvent.click(screen.getByTestId('rest-definition-update'));
    expect(await screen.findByRole('dialog', { name: 'Update definition' })).toBeTruthy();
    fireEvent.click(screen.getByTestId('rest-update-cancel'));
    await waitFor(() => expect(screen.queryByTestId('rest-update-dialog')).toBeNull());
    expect(useRestUpdateStore.getState().apiId).toBeUndefined();
  });

  it('a tab that goes away forgets the request to open the dialog', async () => {
    installWirebenchApi({ api: { restPlanUpdate: vi.fn().mockResolvedValue({ ok: true, value: PLAN }) } });
    mountTab(DEFINED);
    fireEvent.click(screen.getByTestId('rest-definition-update'));
    expect(await screen.findByTestId('rest-update-dialog')).toBeTruthy();

    cleanup();
    expect(useRestUpdateStore.getState().apiId).toBeUndefined();

    mountTab(DEFINED);
    expect(screen.queryByTestId('rest-update-dialog')).toBeNull();
  });

  it('the API tab has no Update definition… for an API made by hand', () => {
    installWirebenchApi();
    mountTab(restApiWire());
    expect(screen.queryByTestId('rest-definition-update')).toBeNull();
  });

  it('every entry point stays shut for an API that did not cache its definition', () => {
    installWirebenchApi();
    mountTab(UNCACHED);
    expect(screen.queryByTestId('rest-definition-update')).toBeNull();
    cleanup();

    seed(UNCACHED);
    updateRestDefinition(UNCACHED.id);
    expect(useRestUpdateStore.getState().apiId).toBeUndefined();
    expect(useEditorsStore.getState().tabs).toHaveLength(0);

    useProjectStore.setState({
      apis: { [UNCACHED.id]: UNCACHED },
      projectOf: { [UNCACHED.id]: 'p1' },
      grpcApis: {},
      wsApis: {},
    } as never);
    const command = getCommand('rest.updateDefinition');
    const ctx = {
      selection: { kind: 'api', id: `api:${UNCACHED.id}`, apiId: UNCACHED.id },
    } as unknown as CommandContext;
    expect(command?.when?.(ctx)).toBe(false);
  });

  it('the action opens the API tab and the dialog, and ignores an API with no definition', () => {
    seed(restApiWire({ id: 'plain' }));
    updateRestDefinition('plain');
    expect(useRestUpdateStore.getState().apiId).toBeUndefined();
    expect(useEditorsStore.getState().tabs).toHaveLength(0);

    seed(DEFINED);
    updateRestDefinition(DEFINED.id);
    expect(useRestUpdateStore.getState().apiId).toBe(DEFINED.id);
    expect(useEditorsStore.getState().tabs.map((tab) => tab.id)).toEqual([`api:${DEFINED.id}`]);
  });

  it('the palette command is available only inside an API that records a definition', () => {
    const command = getCommand('rest.updateDefinition');
    const ctx = (apiId: string): CommandContext =>
      ({ selection: { kind: 'api', id: `api:${apiId}`, apiId } }) as unknown as CommandContext;

    useProjectStore.setState({
      apis: { [DEFINED.id]: DEFINED, plain: restApiWire({ id: 'plain' }) },
      projectOf: { [DEFINED.id]: 'p1', plain: 'p1' },
      grpcApis: {},
      wsApis: {},
    } as never);
    expect(command?.when?.(ctx(DEFINED.id))).toBe(true);
    expect(command?.when?.(ctx('plain'))).toBe(false);

    void command?.run(ctx(DEFINED.id));
    expect(useRestUpdateStore.getState().apiId).toBe(DEFINED.id);
  });
});
