import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { RequestBreadcrumb } from '../../src/renderer/features/request-editor/request-breadcrumb.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import type { InterfaceWire, ProjectWire } from '../../src/shared/wire-types.js';
import { makeDraft } from '../mocks/exchange-fixtures.js';

/** The visible path segments, separators left out. */
function segments(): string[] {
  const nav = screen.getByRole('navigation', { name: 'Request path' });
  return within(nav)
    .getAllByRole('listitem')
    .filter((item) => item.getAttribute('aria-hidden') !== 'true')
    .map((item) => item.textContent ?? '');
}

describe('RequestBreadcrumb', () => {
  beforeEach(() => {
    useProjectStore.setState({
      requests: { 'req-1': makeDraft() },
      projectOf: { 'req-1': 'p1' },
      projects: { p1: { id: 'p1', name: 'Snapsim API' } as ProjectWire },
      interfaces: { 'if-1': { id: 'if-1', name: 'AUTH-SERVICE' } as InterfaceWire },
    });
  });

  afterEach(() => {
    cleanup();
    useProjectStore.setState({ requests: {}, projectOf: {}, projects: {}, interfaces: {} });
  });

  it('shows Project / Interface / Operation / Request, with the request as the current page', () => {
    render(<RequestBreadcrumb requestId="req-1" />);

    expect(segments()).toEqual(['Snapsim API', 'AUTH-SERVICE', 'Add', 'Request 1']);
    expect(screen.getByText('Request 1').closest('li')?.getAttribute('aria-current')).toBe('page');
  });

  it('shows the SOAP version at the right, naming the operation and its SOAPAction on hover', () => {
    render(<RequestBreadcrumb requestId="req-1" />);

    const badge = screen.getByTestId('request-operation');
    expect(badge.textContent).toBe('SOAP 1.1');
    expect(badge.getAttribute('title')).toBe('Add · SOAPAction: http://tempuri.org/Add');
    // After the path, not inside it: the list holds only the path's own segments.
    expect(badge.closest('ol')).toBeNull();
  });

  it('leaves out a segment the mirror does not hold', () => {
    useProjectStore.setState({ projectOf: {}, interfaces: {} });
    render(<RequestBreadcrumb requestId="req-1" />);

    expect(segments()).toEqual(['Add', 'Request 1']);
  });

  it('follows a rename at once', () => {
    render(<RequestBreadcrumb requestId="req-1" />);

    act(() => {
      useProjectStore.setState({ requests: { 'req-1': makeDraft({ name: 'change-password [admin]' }) } });
    });

    expect(segments()).toEqual(['Snapsim API', 'AUTH-SERVICE', 'Add', 'change-password [admin]']);
  });

  it('renders nothing for a request that is gone', () => {
    const { container } = render(<RequestBreadcrumb requestId="missing" />);

    expect(container.firstChild).toBeNull();
  });

  describe('renaming the request in place', () => {
    function startRename(): { updateRequest: ReturnType<typeof vi.fn>; input: HTMLInputElement } {
      const updateRequest = vi.fn();
      useProjectStore.setState({ updateRequest });
      render(<RequestBreadcrumb requestId="req-1" />);
      fireEvent.doubleClick(screen.getByTestId('request-breadcrumb-name'));
      return { updateRequest, input: screen.getByRole('textbox', { name: 'Request name' }) };
    }

    it('opens on a double-click, prefilled with the current name', () => {
      const { input } = startRename();

      expect(input.value).toBe('Request 1');
      expect(document.activeElement).toBe(input);
    });

    it('keeps the new, trimmed name on Enter', () => {
      const { updateRequest, input } = startRename();

      fireEvent.change(input, { target: { value: '  request1  ' } });
      fireEvent.keyDown(input, { key: 'Enter' });

      expect(updateRequest).toHaveBeenCalledWith('req-1', { name: 'request1' });
      expect(screen.queryByRole('textbox', { name: 'Request name' })).toBeNull();
    });

    it('keeps the new name when the field loses focus', () => {
      const { updateRequest, input } = startRename();

      fireEvent.change(input, { target: { value: 'request1' } });
      fireEvent.blur(input);

      expect(updateRequest).toHaveBeenCalledWith('req-1', { name: 'request1' });
    });

    it('drops the edit on Escape', () => {
      const { updateRequest, input } = startRename();

      fireEvent.change(input, { target: { value: 'request1' } });
      fireEvent.keyDown(input, { key: 'Escape' });

      expect(updateRequest).not.toHaveBeenCalled();
      expect(screen.getByTestId('request-breadcrumb-name').textContent).toBe('Request 1');
    });

    it('changes nothing for a blank or unchanged name', () => {
      const { updateRequest, input } = startRename();

      fireEvent.change(input, { target: { value: '   ' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      fireEvent.doubleClick(screen.getByTestId('request-breadcrumb-name'));
      fireEvent.keyDown(screen.getByRole('textbox', { name: 'Request name' }), { key: 'Enter' });

      expect(updateRequest).not.toHaveBeenCalled();
    });
  });
});
