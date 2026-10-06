import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { OutgoingConfigEditor } from '../../src/renderer/features/wss/outgoing-config-editor.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import type { ProjectWire, WssEntryWire, WssOutgoingWire } from '../../src/shared/wire-types.js';

const project = { id: 'p1', name: 'Demo', dir: '/tmp/demo' } as unknown as ProjectWire;

const config: WssOutgoingWire = {
  id: 'w1',
  name: 'Gateway',
  mustUnderstand: false,
  entries: [
    { kind: 'timestamp', timeToLiveSeconds: 300, millisecondPrecision: false },
    { kind: 'username-token', username: 'bob', passwordType: 'digest', addNonce: true, addCreated: true },
  ],
};

function setUp(configs: readonly WssOutgoingWire[] = [config]) {
  installWirebenchApi({});
  const actions = {
    addWssOutgoing: vi.fn().mockResolvedValue('w2'),
    updateWssOutgoing: vi.fn().mockResolvedValue(undefined),
    removeWssOutgoing: vi.fn().mockResolvedValue(undefined),
  };
  useProjectStore.setState({
    projects: { p1: project },
    keystores: [],
    wssOutgoing: configs.map((entry) => ({ ...entry, projectId: 'p1' })),
    ...actions,
  });
  render(
    <TooltipPrimitive.Provider>
      <OutgoingConfigEditor />
    </TooltipPrimitive.Provider>,
  );
  return actions;
}

function expand(): void {
  fireEvent.click(screen.getByRole('button', { expanded: false }));
}

afterEach(() => {
  cleanup();
  useProjectStore.getState().reset();
});

describe('OutgoingConfigEditor', () => {
  it('lists configurations and adds one', () => {
    const { addWssOutgoing } = setUp();
    expect(screen.getAllByTestId('wss-outgoing-row')).toHaveLength(1);
    expect(screen.getByText('2 entries')).toBeTruthy();
    fireEvent.click(screen.getByTestId('wss-outgoing-add'));
    expect(addWssOutgoing).toHaveBeenCalledWith('p1');
  });

  it('says so when there is nothing yet', () => {
    setUp([]);
    expect(screen.getByText('No outgoing configurations yet.')).toBeTruthy();
  });

  it('edits the header fields', () => {
    const { updateWssOutgoing } = setUp();
    expand();
    fireEvent.click(screen.getByLabelText('Must understand'));
    expect(updateWssOutgoing).toHaveBeenCalledWith('w1', { mustUnderstand: true });

    const actor = screen.getByLabelText('Actor');
    fireEvent.change(actor, { target: { value: 'gw' } });
    fireEvent.blur(actor);
    expect(updateWssOutgoing).toHaveBeenCalledWith('w1', { actor: 'gw' });
  });

  it('adds, edits, reorders and removes entries', () => {
    const { updateWssOutgoing } = setUp();
    expand();
    fireEvent.change(screen.getByLabelText('Add entry'), { target: { value: 'timestamp' } });
    expect(updateWssOutgoing).toHaveBeenLastCalledWith('w1', {
      entries: [...config.entries, { kind: 'timestamp', timeToLiveSeconds: 300, millisecondPrecision: false }],
    });

    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'alice' } });
    expect(updateWssOutgoing).toHaveBeenLastCalledWith('w1', {
      entries: [config.entries[0], { ...config.entries[1], username: 'alice' }],
    });

    fireEvent.click(screen.getByLabelText('Move Username Token up'));
    expect(updateWssOutgoing).toHaveBeenLastCalledWith('w1', {
      entries: [config.entries[1], config.entries[0]],
    });

    fireEvent.click(screen.getByLabelText('Remove Timestamp'));
    expect(updateWssOutgoing).toHaveBeenLastCalledWith('w1', { entries: [config.entries[1]] });
  });

  it('lists an entry of a newer kind as read-only, and still lets it move and go', () => {
    const opaque: WssEntryWire = {
      kind: 'unknown',
      originalKind: 'x509-binding',
      index: 1,
      fingerprint: 'f',
      unreadable: false,
    };
    const { updateWssOutgoing } = setUp([{ ...config, entries: [config.entries[0] as WssEntryWire, opaque] }]);
    expand();
    const rows = screen.getAllByTestId('wss-entry-row');
    const row = rows[1] as HTMLElement;
    expect(within(row).getByText('x509-binding (needs a newer version)')).toBeTruthy();
    expect(within(row).queryAllByRole('textbox')).toHaveLength(0);
    expect(within(row).queryAllByRole('checkbox')).toHaveLength(0);
    expect(within(row).queryAllByRole('combobox')).toHaveLength(0);

    fireEvent.click(within(row).getByLabelText('Move x509-binding (needs a newer version) up'));
    expect(updateWssOutgoing).toHaveBeenLastCalledWith('w1', { entries: [opaque, config.entries[0]] });
    fireEvent.click(within(row).getByLabelText('Remove x509-binding (needs a newer version)'));
    expect(updateWssOutgoing).toHaveBeenLastCalledWith('w1', { entries: [config.entries[0]] });
  });

  it('labels an entry of a known kind this build cannot read as unreadable', () => {
    setUp([
      {
        ...config,
        entries: [{ kind: 'unknown', originalKind: 'saml-token', index: 0, fingerprint: 'f', unreadable: true }],
      },
    ]);
    expand();
    expect(screen.getByText('saml-token (unreadable)')).toBeTruthy();
  });

  it("adds a signature entry with this build's defaults", () => {
    const { updateWssOutgoing } = setUp([{ ...config, entries: [] }]);
    expand();
    fireEvent.change(screen.getByLabelText('Add entry'), { target: { value: 'signature' } });
    expect(updateWssOutgoing).toHaveBeenLastCalledWith('w1', {
      entries: [
        {
          kind: 'signature',
          keystoreRef: '',
          keyIdentifierType: 'BinarySecurityToken',
          signatureAlgorithm: 'rsa-sha256',
          digestAlgorithm: 'sha256',
          canonicalization: 'exc-c14n',
          useSingleCertificate: true,
          parts: [
            { name: 'Body', namespace: 'http://schemas.xmlsoap.org/soap/envelope/', encode: 'Content' },
            {
              name: 'Timestamp',
              namespace: 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd',
              encode: 'Content',
            },
          ],
        },
      ],
    });
  });

  it('edits a signature entry and its parts', () => {
    const signature: WssEntryWire = {
      kind: 'signature',
      keystoreRef: 'ks1',
      keyIdentifierType: 'BinarySecurityToken',
      signatureAlgorithm: 'rsa-sha256',
      digestAlgorithm: 'sha256',
      canonicalization: 'exc-c14n',
      useSingleCertificate: true,
      parts: [{ name: 'Body', namespace: 'http://schemas.xmlsoap.org/soap/envelope/', encode: 'Content' }],
    };
    const { updateWssOutgoing } = setUp([{ ...config, entries: [signature] }]);
    expand();

    fireEvent.change(screen.getByLabelText('Key identifier type'), { target: { value: 'Thumbprint' } });
    expect(updateWssOutgoing).toHaveBeenLastCalledWith('w1', {
      entries: [{ ...signature, keyIdentifierType: 'Thumbprint' }],
    });

    fireEvent.change(screen.getByLabelText('Signature algorithm'), { target: { value: 'rsa-sha1' } });
    expect(updateWssOutgoing).toHaveBeenLastCalledWith('w1', {
      entries: [{ ...signature, signatureAlgorithm: 'rsa-sha1' }],
    });

    fireEvent.click(screen.getByLabelText('Use single certificate'));
    expect(updateWssOutgoing).toHaveBeenLastCalledWith('w1', {
      entries: [{ ...signature, useSingleCertificate: false }],
    });

    fireEvent.change(screen.getByLabelText('Part 1 name'), { target: { value: 'Echo' } });
    expect(updateWssOutgoing).toHaveBeenLastCalledWith('w1', {
      entries: [{ ...signature, parts: [{ ...signature.parts[0], name: 'Echo' }] }],
    });

    fireEvent.click(screen.getByTestId('wss-part-add'));
    expect(updateWssOutgoing).toHaveBeenLastCalledWith('w1', {
      entries: [{ ...signature, parts: [...signature.parts, { name: '', namespace: '', encode: 'Content' }] }],
    });

    fireEvent.click(screen.getByLabelText('Remove part 1'));
    expect(updateWssOutgoing).toHaveBeenLastCalledWith('w1', { entries: [{ ...signature, parts: [] }] });
  });

  it('refers to a SAML token and covers it without listing the token part', () => {
    const signature: WssEntryWire = {
      kind: 'signature',
      keystoreRef: 'ks1',
      keyIdentifierType: 'BinarySecurityToken',
      signatureAlgorithm: 'rsa-sha256',
      digestAlgorithm: 'sha256',
      canonicalization: 'exc-c14n',
      useSingleCertificate: true,
      parts: [{ name: 'Body', namespace: 'http://schemas.xmlsoap.org/soap/envelope/', encode: 'Content' }],
    };
    const tokenPart = { name: 'SamlToken', namespace: '', encode: 'Element', token: true } as const;
    const { updateWssOutgoing } = setUp([{ ...config, entries: [signature] }]);
    expand();

    fireEvent.change(screen.getByLabelText('Key identifier type'), { target: { value: 'saml-token' } });
    expect(updateWssOutgoing).toHaveBeenLastCalledWith('w1', {
      entries: [{ ...signature, keyIdentifierType: 'saml-token' }],
    });

    fireEvent.click(screen.getByLabelText('Cover the SAML token (STR-Transform)'));
    expect(updateWssOutgoing).toHaveBeenLastCalledWith('w1', {
      entries: [{ ...signature, parts: [...signature.parts, tokenPart] }],
    });
  });

  it('keeps the token part out of the parts table and in what it writes back', () => {
    const tokenPart = { name: 'SamlToken', namespace: '', encode: 'Element', token: true } as const;
    const signature: WssEntryWire = {
      kind: 'signature',
      keystoreRef: 'ks1',
      keyIdentifierType: 'saml-token',
      signatureAlgorithm: 'rsa-sha256',
      digestAlgorithm: 'sha256',
      canonicalization: 'exc-c14n',
      useSingleCertificate: true,
      parts: [tokenPart, { name: 'Body', namespace: 'http://schemas.xmlsoap.org/soap/envelope/', encode: 'Content' }],
    };
    const { updateWssOutgoing } = setUp([{ ...config, entries: [signature] }]);
    expand();

    expect(screen.getAllByTestId('wss-part-row')).toHaveLength(1);
    expect(screen.getByLabelText<HTMLInputElement>('Part 1 name').value).toBe('Body');
    expect(screen.getByLabelText<HTMLInputElement>('Cover the SAML token (STR-Transform)').checked).toBe(true);

    fireEvent.change(screen.getByLabelText('Part 1 name'), { target: { value: 'Echo' } });
    expect(updateWssOutgoing).toHaveBeenLastCalledWith('w1', {
      entries: [{ ...signature, parts: [{ ...signature.parts[1], name: 'Echo' }, tokenPart] }],
    });

    fireEvent.click(screen.getByLabelText('Cover the SAML token (STR-Transform)'));
    expect(updateWssOutgoing).toHaveBeenLastCalledWith('w1', {
      entries: [{ ...signature, parts: [signature.parts[1]] }],
    });
  });

  it('edits an encryption entry and its parts', () => {
    const encryption: WssEntryWire = {
      kind: 'encryption',
      keystoreRef: 'ks1',
      keyIdentifierType: 'BinarySecurityToken',
      symmetricAlgorithm: 'aes256-gcm',
      keyTransportAlgorithm: 'rsa-oaep',
      embedKey: false,
      encryptSymmetricKey: true,
      parts: [{ name: 'Body', namespace: 'http://schemas.xmlsoap.org/soap/envelope/', encode: 'Content' }],
    };
    const { updateWssOutgoing } = setUp([{ ...config, entries: [encryption] }]);
    expand();

    expect(screen.getByTestId('wss-encryption-fields')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Encryption algorithm'), { target: { value: 'aes128-cbc' } });
    expect(updateWssOutgoing).toHaveBeenLastCalledWith('w1', {
      entries: [{ ...encryption, symmetricAlgorithm: 'aes128-cbc' }],
    });

    fireEvent.change(screen.getByLabelText('Key transport algorithm'), { target: { value: 'rsa-1_5' } });
    expect(updateWssOutgoing).toHaveBeenLastCalledWith('w1', {
      entries: [{ ...encryption, keyTransportAlgorithm: 'rsa-1_5' }],
    });

    fireEvent.click(screen.getByLabelText('Embed key'));
    expect(updateWssOutgoing).toHaveBeenLastCalledWith('w1', { entries: [{ ...encryption, embedKey: true }] });

    // Out-of-band symmetric keys are not supported (the engine rejects them), so there is no
    // control that could ask for one.
    expect(screen.queryByLabelText('Encrypt symmetric key')).toBeNull();
    expect(screen.getByTestId('wss-encryption-fields').textContent).toContain('always encrypted');

    fireEvent.change(screen.getByLabelText('Part 1 encode'), { target: { value: 'Element' } });
    expect(updateWssOutgoing).toHaveBeenLastCalledWith('w1', {
      entries: [{ ...encryption, parts: [{ ...encryption.parts[0], encode: 'Element' }] }],
    });
  });

  it('offers Encryption in the Add menu', () => {
    const { updateWssOutgoing } = setUp();
    expand();
    const add = screen.getByLabelText('Add entry');
    expect(
      within(add)
        .getByRole('option', { name: /Encryption/ })
        .hasAttribute('disabled'),
    ).toBe(false);

    fireEvent.change(add, { target: { value: 'encryption' } });
    expect(updateWssOutgoing).toHaveBeenLastCalledWith('w1', {
      entries: [
        ...config.entries,
        {
          kind: 'encryption',
          keystoreRef: '',
          keyIdentifierType: 'BinarySecurityToken',
          symmetricAlgorithm: 'aes256-gcm',
          keyTransportAlgorithm: 'rsa-oaep',
          embedKey: false,
          encryptSymmetricKey: true,
          parts: [{ name: 'Body', namespace: 'http://schemas.xmlsoap.org/soap/envelope/', encode: 'Content' }],
        },
      ],
    });
  });

  it('removes a configuration after confirmation', () => {
    const { removeWssOutgoing } = setUp();
    fireEvent.click(screen.getByLabelText('Remove Gateway'));
    fireEvent.click(screen.getByTestId('wss-outgoing-remove-confirm'));
    expect(removeWssOutgoing).toHaveBeenCalledWith('w1');
  });
});
