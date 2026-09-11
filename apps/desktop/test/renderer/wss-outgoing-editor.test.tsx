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
  useProjectStore.setState({ project, keystores: [], wssOutgoing: configs, ...actions });
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
  useProjectStore.setState({ project: null, keystores: [], wssOutgoing: [] });
});

describe('OutgoingConfigEditor', () => {
  it('lists configurations and adds one', () => {
    const { addWssOutgoing } = setUp();
    expect(screen.getAllByTestId('wss-outgoing-row')).toHaveLength(1);
    expect(screen.getByText('2 entries')).toBeTruthy();
    fireEvent.click(screen.getByTestId('wss-outgoing-add'));
    expect(addWssOutgoing).toHaveBeenCalled();
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

  it('shows an unsupported entry as such and never offers to add one', () => {
    setUp([{ ...config, entries: [{ kind: 'encryption' }] }]);
    expand();
    expect(screen.getByText('Not supported by this build yet.')).toBeTruthy();
    const add = screen.getByLabelText('Add entry');
    expect(
      within(add)
        .getByRole('option', { name: /Encryption/ })
        .hasAttribute('disabled'),
    ).toBe(true);
  });

  it('removes a configuration after confirmation', () => {
    const { removeWssOutgoing } = setUp();
    fireEvent.click(screen.getByLabelText('Remove Gateway'));
    fireEvent.click(screen.getByTestId('wss-outgoing-remove-confirm'));
    expect(removeWssOutgoing).toHaveBeenCalledWith('w1');
  });
});
