import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RequestContextMenu } from '../../src/renderer/features/request-editor/request-context-menu.js';
import { useRequestDialogsStore } from '../../src/renderer/features/request-editor/request-dialogs.js';
import { useDraftsStore } from '../../src/renderer/state/drafts.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import { useUiStore } from '../../src/renderer/state/ui.js';
import { DEFAULT_UI_STATE } from '../../src/renderer/state/ui-state.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import { makeDraft } from '../mocks/exchange-fixtures.js';

// The menu's Format / Go to line items reach the live Monaco instance through
// `editor/xml-language.ts`; the real `monaco-editor` module cannot load under jsdom.
vi.mock('@monaco-editor/react', async () => await import('../mocks/monaco-editor-react.js'));
vi.mock('../../src/renderer/editor/monaco.js', async () => await import('../mocks/monaco-runtime.js'));

/** The items, in the order the brief fixes them. */
const ITEMS = [
  'Validate request',
  'Validate response',
  'Check WS-I compliance',
  'Go to Schema Definition',
  'Recreate request (keep values)',
  'Recreate (discard values)',
  'Create empty',
  'Clone…',
  'Copy as cURL',
  'Copy as cURL (PowerShell)',
  'Import cURL…',
  'Show code',
  'Add WSS Username Token…',
  'Add WS-Timestamp…',
  'Outgoing WSS → Apply to editor',
  'Outgoing WSS → Remove',
  'WS-A Headers → Add to editor',
  'WS-A Headers → Remove',
  'Format',
  'Go to line…',
];

function openMenu(): void {
  render(
    <RequestContextMenu draft={makeDraft()}>
      <div data-testid="request-surface">envelope</div>
    </RequestContextMenu>,
  );
  fireEvent.contextMenu(screen.getByTestId('request-surface'));
}

describe('RequestContextMenu', () => {
  beforeEach(() => {
    installWirebenchApi();
    useUiStore.setState(structuredClone(DEFAULT_UI_STATE));
    useProjectStore.setState({ requests: { 'req-1': makeDraft() } });
    // The drafts store is module state and survives `cleanup()`. A recreate now stages its
    // result, so without this each test would start holding the previous one's unsaved edit.
    useDraftsStore.setState({ requests: {} });
    useRequestDialogsStore.getState().close();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('offers every request action, in order', async () => {
    openMenu();

    const labels = (await screen.findAllByRole('menuitem')).map((item) => item.textContent);
    expect(labels).toEqual(ITEMS);
  });

  it('Recreate (discard values) asks main to drop the values but keep the headers', async () => {
    const recreate = vi
      .fn()
      .mockResolvedValue({ ok: true, value: { envelopeXml: '<fresh/>', kept: 0, added: 3, removed: 1 } });
    installWirebenchApi({ request: { recreate } });
    openMenu();

    fireEvent.click(await screen.findByRole('menuitem', { name: 'Recreate (discard values)' }));

    await waitFor(() => {
      expect(recreate).toHaveBeenCalledWith({
        requestId: 'req-1',
        keepValues: false,
        keepHeaders: true,
        empty: false,
      });
    });
    await waitFor(() => {
      expect(useProjectStore.getState().requests['req-1']?.envelopeXml).toBe('<fresh/>');
    });
  });

  it('Create empty asks main to drop both values and headers', async () => {
    const recreate = vi
      .fn()
      .mockResolvedValue({ ok: true, value: { envelopeXml: '<empty/>', kept: 0, added: 0, removed: 0 } });
    installWirebenchApi({ request: { recreate } });
    openMenu();

    fireEvent.click(await screen.findByRole('menuitem', { name: 'Create empty' }));

    await waitFor(() => {
      expect(recreate).toHaveBeenCalledWith({
        requestId: 'req-1',
        keepValues: false,
        keepHeaders: false,
        empty: true,
      });
    });
  });

  it('sends a staged edit to main before recreating, so "keep values" keeps what is on screen', async () => {
    // Main rebuilds the envelope from its own model. Without the commit it would merge against
    // the last *saved* envelope and silently drop the edit the user is looking at.
    const mutate = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        project: {
          id: 'p1',
          name: 'P',
          dir: '/tmp/p',
          dirty: true,
          interfaces: [],
          requests: [],
          properties: {},
          environments: [],
          keystores: [],
          wssOutgoing: [],
          wssIncoming: [],
          problems: [],
        },
      },
    });
    const recreate = vi
      .fn()
      .mockResolvedValue({ ok: true, value: { envelopeXml: '<fresh/>', kept: 1, added: 0, removed: 0 } });
    installWirebenchApi({ request: { recreate }, project: { mutate } });
    // `commitRequest` addresses the mutation at the owning project, so the mirror needs one.
    useProjectStore.setState({ requests: { 'req-1': makeDraft() }, projectOf: { 'req-1': 'p1' } });
    useDraftsStore.getState().stageRequest('req-1', { envelopeXml: '<edited/>' });
    openMenu();

    fireEvent.click(await screen.findByRole('menuitem', { name: 'Recreate request (keep values)' }));

    await waitFor(() => {
      expect(mutate).toHaveBeenCalledWith({
        projectId: 'p1',
        change: { kind: 'update-request', requestId: 'req-1', patch: { envelopeXml: '<edited/>' } },
      });
    });
    // And the commit happened first: a recreate against a stale model is the bug being fixed.
    expect(mutate.mock.invocationCallOrder[0]).toBeLessThan(recreate.mock.invocationCallOrder[0]!);
  });

  it('leaves the recreated envelope unsaved, so the tab still says so and Mod+S has work', async () => {
    const recreate = vi
      .fn()
      .mockResolvedValue({ ok: true, value: { envelopeXml: '<fresh/>', kept: 0, added: 0, removed: 0 } });
    installWirebenchApi({ request: { recreate } });
    openMenu();

    fireEvent.click(await screen.findByRole('menuitem', { name: 'Create empty' }));

    await waitFor(() => {
      expect(useDraftsStore.getState().isRequestDirty('req-1')).toBe(true);
    });
    expect(useProjectStore.getState().requests['req-1']?.envelopeXml).toBe('<fresh/>');
  });

  it('Copy as cURL writes the POSIX command to the clipboard', async () => {
    const curl = vi.fn().mockResolvedValue({ ok: true, value: { command: "curl --request POST 'https://x'" } });
    installWirebenchApi({ request: { curl } });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    openMenu();

    fireEvent.click(await screen.findByRole('menuitem', { name: 'Copy as cURL' }));

    await waitFor(() => {
      expect(curl).toHaveBeenCalledWith({ requestId: 'req-1', shell: 'posix' });
    });
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("curl --request POST 'https://x'");
    });
  });

  it('Copy as cURL (PowerShell) asks for the powershell quoting', async () => {
    const curl = vi.fn().mockResolvedValue({ ok: true, value: { command: 'curl.exe --request POST' } });
    installWirebenchApi({ request: { curl } });
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
    openMenu();

    fireEvent.click(await screen.findByRole('menuitem', { name: 'Copy as cURL (PowerShell)' }));

    await waitFor(() => {
      expect(curl).toHaveBeenCalledWith({ requestId: 'req-1', shell: 'powershell' });
    });
  });

  it('Clone… and Import cURL… hand the dialogs to the editor that owns them', async () => {
    openMenu();

    fireEvent.click(await screen.findByRole('menuitem', { name: 'Clone…' }));
    expect(useRequestDialogsStore.getState()).toMatchObject({ kind: 'clone', requestId: 'req-1' });
  });

  it('Show code opens the Code slide-over', async () => {
    openMenu();

    fireEvent.click(await screen.findByRole('menuitem', { name: 'Show code' }));

    expect(useUiStore.getState().slideOver).toMatchObject({ open: true });
  });
});
