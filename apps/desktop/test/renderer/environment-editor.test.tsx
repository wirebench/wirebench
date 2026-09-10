import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { EnvironmentEditor } from '../../src/renderer/features/environments/environment-editor.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import type { EnvironmentWire, InterfaceWire } from '../../src/shared/wire-types.js';

const iface = {
  id: 'iface-1',
  name: 'Calculator',
  slug: 'calculator',
  endpoints: [{ id: 'ep-1', name: 'Soap', url: 'http://one.test/soap' }],
} as unknown as InterfaceWire;

const environment: EnvironmentWire = {
  id: 'e1',
  name: 'uat',
  slug: 'uat',
  order: 0,
  endpoints: { calculator: 'http://two.test/soap' },
  properties: { host: 'two.test' },
};

function setUp() {
  const updateEnvironment = vi.fn().mockResolvedValue(undefined);
  useProjectStore.setState({
    environments: [environment],
    interfaces: { 'iface-1': iface },
    order: ['iface-1'],
    updateEnvironment,
  });
  render(
    <TooltipPrimitive.Provider>
      <EnvironmentEditor environmentId="e1" />
    </TooltipPrimitive.Provider>,
  );
  return updateEnvironment;
}

describe('EnvironmentEditor', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
    useProjectStore.setState({ environments: [], interfaces: {}, order: [] });
  });

  it('saves the name once typing has settled', () => {
    const updateEnvironment = setUp();
    fireEvent.change(screen.getByLabelText('Environment name'), { target: { value: 'staging' } });
    expect(updateEnvironment).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(updateEnvironment).toHaveBeenCalledWith('e1', { name: 'staging' });
  });

  it('flushes a pending name edit on unmount instead of losing it', () => {
    const updateEnvironment = setUp();
    fireEvent.change(screen.getByLabelText('Environment name'), { target: { value: 'staging' } });
    expect(updateEnvironment).not.toHaveBeenCalled();

    cleanup();

    expect(updateEnvironment).toHaveBeenCalledWith('e1', { name: 'staging' });
  });

  it('builds each endpoint commit from the latest store state so two rapid edits both land', () => {
    const iface2 = {
      id: 'iface-2',
      name: 'Weather',
      slug: 'weather',
      endpoints: [{ id: 'ep-2', name: 'Soap', url: 'http://weather.test/soap' }],
    } as unknown as InterfaceWire;
    const updateEnvironment = vi.fn().mockResolvedValue(undefined);
    useProjectStore.setState({
      environments: [environment],
      interfaces: { 'iface-1': iface, 'iface-2': iface2 },
      order: ['iface-1', 'iface-2'],
      updateEnvironment,
    });
    render(
      <TooltipPrimitive.Provider>
        <EnvironmentEditor environmentId="e1" />
      </TooltipPrimitive.Provider>,
    );

    // First commit, for the Calculator override. Main has not answered yet — as the real
    // optimistic store would, the mirror is updated to reflect it right away.
    fireEvent.change(screen.getByLabelText('Endpoint override for Calculator'), {
      target: { value: 'http://three.test/soap' },
    });
    fireEvent.blur(screen.getByLabelText('Endpoint override for Calculator'));
    expect(updateEnvironment).toHaveBeenLastCalledWith('e1', { endpoints: { calculator: 'http://three.test/soap' } });
    useProjectStore.setState({
      environments: [{ ...environment, endpoints: { calculator: 'http://three.test/soap' } }],
    });

    // Second commit, for a different interface's override, fired before the first round trip
    // resolves. It must build on top of the first edit, not the map captured at render time.
    fireEvent.change(screen.getByLabelText('Endpoint override for Weather'), {
      target: { value: 'http://four.test/soap' },
    });
    fireEvent.blur(screen.getByLabelText('Endpoint override for Weather'));

    expect(updateEnvironment).toHaveBeenLastCalledWith('e1', {
      endpoints: { calculator: 'http://three.test/soap', weather: 'http://four.test/soap' },
    });
  });

  it('replaces the whole endpoint map when an override changes', () => {
    const updateEnvironment = setUp();
    const input = screen.getByLabelText('Endpoint override for Calculator');
    expect((input as HTMLInputElement).value).toBe('http://two.test/soap');
    fireEvent.change(input, { target: { value: 'http://three.test/soap' } });
    fireEvent.blur(input);

    expect(updateEnvironment).toHaveBeenCalledWith('e1', { endpoints: { calculator: 'http://three.test/soap' } });
  });

  it('drops the key when the override is cleared', () => {
    const updateEnvironment = setUp();
    fireEvent.click(screen.getByRole('button', { name: 'Clear override for Calculator' }));
    expect(updateEnvironment).toHaveBeenCalledWith('e1', { endpoints: {} });
  });

  it('offers the interface addresses as suggestions', () => {
    setUp();
    expect(screen.getByRole('option', { hidden: true }).getAttribute('value')).toBe('http://one.test/soap');
  });

  it('adds, edits, and removes properties through the whole map', () => {
    const updateEnvironment = setUp();

    fireEvent.change(screen.getByLabelText('New property name'), { target: { value: 'port' } });
    fireEvent.change(screen.getByLabelText('New property value'), { target: { value: '8080' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add property' }));
    expect(updateEnvironment).toHaveBeenLastCalledWith('e1', { properties: { host: 'two.test', port: '8080' } });

    const value = screen.getByLabelText('Value of host');
    fireEvent.change(value, { target: { value: 'edited' } });
    fireEvent.blur(value);
    expect(updateEnvironment).toHaveBeenLastCalledWith('e1', { properties: { host: 'edited' } });

    fireEvent.click(screen.getByRole('button', { name: 'Remove host' }));
    expect(updateEnvironment).toHaveBeenLastCalledWith('e1', { properties: {} });
  });
});
