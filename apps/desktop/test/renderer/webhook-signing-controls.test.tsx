/**
 * The signing controls (webhook-signatures §5.2): what a webhook node inherits, the CI name it is
 * offered, the staged signing laid over a request, and the **Signing** tab.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SigningTab } from '../../src/renderer/features/rest-editor/signing-tab.js';
import {
  ciNameOf,
  ciNameProblemOf,
  inheritedSigningOf,
  signingSummary,
} from '../../src/renderer/features/webhook-items/signing.js';
import { layerRestEdits } from '../../src/renderer/state/project.js';
import { flushScriptEdits, hasScriptEditors } from '../../src/renderer/state/script-edits.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import { restFolderWire, restRequestWire } from '../helpers/wire-defaults.js';
import type { WebhookSigningWire } from '../../src/shared/wire-types.js';

const HMAC: WebhookSigningWire = {
  mode: 'sign',
  scheme: { kind: 'hmac', algorithm: 'sha256', encoding: 'hex', header: 'X-Signature' },
  secretRef: 'ref-orders',
  secretEnv: 'ORDERS_SIGNING',
};
const HMAC_UNSET: WebhookSigningWire = {
  mode: 'sign',
  scheme: { kind: 'hmac', algorithm: 'sha256', encoding: 'hex', header: 'X-Signature' },
  secretEnv: 'ORDERS_SIGNING',
};

afterEach(() => cleanup());

describe('signing helpers (§5.2)', () => {
  it('finds what an item inherits: nearest folder, then the collection, then none', () => {
    const folders = {
      g1: restFolderWire({ id: 'g1', name: 'Orders', signing: HMAC }),
      g2: restFolderWire({ id: 'g2', name: 'Refunds', parentId: 'g1' }),
    };
    expect(inheritedSigningOf(folders, 'g2', { signing: { mode: 'none' } })).toEqual({
      signing: HMAC,
      from: 'folder',
      fromName: 'Orders',
    });
    expect(inheritedSigningOf({}, undefined, { signing: HMAC })).toEqual({ signing: HMAC, from: 'collection' });
    expect(inheritedSigningOf({}, undefined, {})).toEqual({ signing: { mode: 'none' }, from: 'default' });
    expect(signingSummary({ signing: HMAC, from: 'folder', fromName: 'Orders' })).toBe(
      'Inherits HMAC of body · SHA-256 · hex · X-Signature from the folder “Orders”',
    );
    expect(signingSummary({ signing: { mode: 'none' }, from: 'default' })).toBe(
      'Inherits None (nothing above sets signing)',
    );
  });

  it('pre-fills the CI name from the node name in upper snake case', () => {
    expect(ciNameOf('Order paid')).toBe('ORDER_PAID');
    expect(ciNameOf('  refund.v2 — sent ')).toBe('REFUND_V2_SENT');
    expect(ciNameOf('2fa code')).toBe('WEBHOOK_2FA_CODE');
    expect(ciNameOf('')).toBe('WEBHOOK');
  });

  it('checks a CI name against the project file’s envName rule', () => {
    expect(ciNameProblemOf('ORDER_PAID')).toBeUndefined();
    expect(ciNameProblemOf('')).toBeUndefined();
    expect(ciNameProblemOf('2FA')).toBe('A CI name is upper-case letters, digits and _, starting with a letter.');
    expect(ciNameProblemOf('ORDER-PAID')).toBe(
      'A CI name is upper-case letters, digits and _, starting with a letter.',
    );
  });

  it('lays a staged signing over the request, and null back to inherit', () => {
    const request = restRequestWire({ id: 'w1', signing: HMAC });
    expect(layerRestEdits(request, { signing: { mode: 'none' } }).signing).toEqual({ mode: 'none' });
    expect(layerRestEdits(request, { signing: null })).not.toHaveProperty('signing');
    expect(layerRestEdits(request, { name: 'Renamed' }).signing).toEqual(HMAC);
  });
});

describe('the Signing tab (§5.2)', () => {
  it('shows where the inherited signing comes from, and stages a scheme with a CI name', () => {
    installWirebenchApi();
    const onChange = vi.fn();
    render(
      <SigningTab
        request={restRequestWire({ id: 'w1', name: 'Order paid' })}
        inherited={{ signing: HMAC, from: 'collection' }}
        onChange={onChange}
      />,
    );
    expect(screen.getByTestId('rest-signing-source').textContent).toBe(
      'Inherits HMAC of body · SHA-256 · hex · X-Signature from the Webhooks collection',
    );
    fireEvent.change(screen.getByTestId('signing-mode'), { target: { value: 'standard' } });
    expect(onChange).toHaveBeenLastCalledWith({
      signing: { mode: 'sign', scheme: { kind: 'standard', toleranceSec: 300 }, secretEnv: 'ORDER_PAID' },
    });
    fireEvent.change(screen.getByTestId('signing-mode'), { target: { value: 'none' } });
    expect(onChange).toHaveBeenLastCalledWith({ signing: { mode: 'none' } });
    fireEvent.change(screen.getByTestId('signing-mode'), { target: { value: 'inherit' } });
    expect(onChange).toHaveBeenLastCalledWith({ signing: null });
  });

  it('shows the item’s own scheme with its secret and CI name', () => {
    installWirebenchApi();
    render(
      <SigningTab
        request={restRequestWire({ id: 'w1', name: 'Order paid', signing: HMAC })}
        inherited={{ signing: { mode: 'none' }, from: 'default' }}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByTestId<HTMLSelectElement>('signing-mode').value).toBe('hmac');
    expect(screen.getByTestId<HTMLInputElement>('signing-ci-name').value).toBe('ORDERS_SIGNING');
    expect(screen.getByRole('group', { name: 'Signing secret' }).textContent).toContain('Replace…');
    expect(screen.queryByTestId('rest-signing-source')).toBeNull();
  });

  it('upper-cases a typed CI name, and holds back one the envName rule refuses with an inline error', () => {
    installWirebenchApi();
    const onChange = vi.fn();
    render(
      <SigningTab
        request={restRequestWire({ id: 'w1', name: 'Order paid', signing: HMAC })}
        inherited={{ signing: { mode: 'none' }, from: 'default' }}
        onChange={onChange}
      />,
    );
    const ciName = screen.getByTestId<HTMLInputElement>('signing-ci-name');
    fireEvent.change(ciName, { target: { value: 'orders_v2' } });
    expect(onChange).toHaveBeenLastCalledWith({ signing: { ...HMAC, secretEnv: 'ORDERS_V2' } });
    expect(screen.queryByTestId('signing-ci-name-problem')).toBeNull();

    onChange.mockClear();
    fireEvent.change(ciName, { target: { value: '2-orders' } });
    expect(onChange).not.toHaveBeenCalled();
    expect(ciName.value).toBe('2-ORDERS');
    expect(screen.getByTestId('signing-ci-name-problem').textContent).toBe(
      'A CI name is upper-case letters, digits and _, starting with a letter.',
    );
  });

  it('reports a refused CI name as a problem, and clears it when fixed or when the tab goes', () => {
    installWirebenchApi();
    const onProblemChange = vi.fn();
    const { unmount } = render(
      <SigningTab
        request={restRequestWire({ id: 'w1', name: 'Order paid', signing: HMAC })}
        inherited={{ signing: { mode: 'none' }, from: 'default' }}
        onChange={vi.fn()}
        onProblemChange={onProblemChange}
      />,
    );
    const ciName = screen.getByTestId<HTMLInputElement>('signing-ci-name');
    fireEvent.change(ciName, { target: { value: '2-orders' } });
    expect(onProblemChange).toHaveBeenLastCalledWith(
      'A CI name is upper-case letters, digits and _, starting with a letter.',
    );
    fireEvent.change(ciName, { target: { value: 'orders' } });
    expect(onProblemChange).toHaveBeenLastCalledWith(undefined);

    fireEvent.change(ciName, { target: { value: '2-orders' } });
    onProblemChange.mockClear();
    unmount();
    expect(onProblemChange).toHaveBeenLastCalledWith(undefined);
  });

  it('registers a flush, so a typed but unsaved secret is stored and staged before a send', async () => {
    const replace = vi.fn().mockResolvedValue({ ok: true, value: { ref: 'ref-orders' } });
    const set = vi.fn().mockResolvedValue({ ok: true, value: { ref: 'ref-new' } });
    installWirebenchApi({ secrets: { replace, set } });
    const onChange = vi.fn();
    render(
      <SigningTab
        request={restRequestWire({ id: 'w1', name: 'Order paid', signing: HMAC_UNSET })}
        inherited={{ signing: { mode: 'none' }, from: 'default' }}
        onChange={onChange}
      />,
    );
    expect(hasScriptEditors()).toBe(true);

    await userEvent.click(screen.getByRole('button', { name: 'Set…' }));
    await userEvent.type(screen.getByLabelText('Signing secret', { selector: 'input' }), 'abc123def456ghi789');
    await act(async () => {
      await flushScriptEdits();
    });

    expect(set).toHaveBeenCalledWith({ value: 'abc123def456ghi789', label: 'Signing secret' });
    expect(onChange).toHaveBeenLastCalledWith({ signing: { ...HMAC, secretRef: 'ref-new' } });

    cleanup();
    expect(hasScriptEditors()).toBe(false);
  });

  it('holds back a scheme field main would refuse, reports it, and stages it once fixed', () => {
    installWirebenchApi();
    const onChange = vi.fn();
    const onProblemChange = vi.fn();
    render(
      <SigningTab
        request={restRequestWire({ id: 'w1', name: 'Order paid', signing: HMAC })}
        inherited={{ signing: { mode: 'none' }, from: 'default' }}
        onChange={onChange}
        onProblemChange={onProblemChange}
      />,
    );
    const header = screen.getByTestId<HTMLInputElement>('signing-header');
    fireEvent.change(header, { target: { value: 'X Sig' } });
    expect(onChange).not.toHaveBeenCalled();
    expect(header.value).toBe('X Sig');
    expect(screen.getByTestId('signing-scheme-problem').textContent).toBe(
      'The header name has a character a header name cannot have.',
    );
    expect(onProblemChange).toHaveBeenLastCalledWith('The header name has a character a header name cannot have.');
    fireEvent.change(header, { target: { value: 'X-Sig' } });
    expect(onChange).toHaveBeenLastCalledWith({
      signing: { ...HMAC, scheme: { ...(HMAC.mode === 'sign' ? HMAC.scheme : {}), header: 'X-Sig' } },
    });
    expect(onProblemChange).toHaveBeenLastCalledWith(undefined);
  });

  it('shows a cleared tolerance as empty and stages nothing until it is valid', () => {
    installWirebenchApi();
    const onChange = vi.fn();
    const standard: WebhookSigningWire = { mode: 'sign', scheme: { kind: 'standard', toleranceSec: 300 } };
    render(
      <SigningTab
        request={restRequestWire({ id: 'w1', name: 'Order paid', signing: standard })}
        inherited={{ signing: { mode: 'none' }, from: 'default' }}
        onChange={onChange}
      />,
    );
    const tolerance = screen.getByTestId<HTMLInputElement>('signing-tolerance');
    fireEvent.change(tolerance, { target: { value: '' } });
    expect(tolerance.value).toBe('');
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByTestId('signing-scheme-problem').textContent).toBe('The tolerance is 1 to 86400 seconds.');
    fireEvent.change(tolerance, { target: { value: '60' } });
    expect(onChange).toHaveBeenLastCalledWith({
      signing: { mode: 'sign', scheme: { kind: 'standard', toleranceSec: 60 } },
    });
  });
});
