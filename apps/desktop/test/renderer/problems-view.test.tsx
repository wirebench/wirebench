import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ProblemsView } from '../../src/renderer/features/problems/problems-view.js';
import { useEditorsStore } from '../../src/renderer/state/editors.js';
import { useProblemsStore } from '../../src/renderer/state/problems.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import type { ProjectWire } from '../../src/shared/wire-types.js';
import type { InterfaceWire, RequestWire } from '../../src/shared/kinds/soap/wire.js';

const request = {
  id: 'req-1',
  interfaceId: 'iface-1',
  bindingName: '{tns}B',
  operationName: 'Add',
  name: 'Request 1',
  envelopeXml: '<Envelope/>',
  soapVersion: '1.1',
  headers: [],
  order: 0,
} as unknown as RequestWire;

describe('ProblemsView', () => {
  beforeEach(() => {
    useProblemsStore.setState({ items: [], filter: 'all' });
    useEditorsStore.setState({ tabs: [], activeId: undefined });
    useProjectStore.setState({ requests: { 'req-1': request } });
  });

  afterEach(() => {
    cleanup();
    useProjectStore.setState({ requests: {}, interfaces: {}, projects: {}, projectOf: {} });
  });

  it('says so when there is nothing to report', () => {
    render(<ProblemsView />);
    expect(screen.getByText('No problems found.')).toBeDefined();
  });

  it('badges each problem with its source and severity', () => {
    useProblemsStore.setState({
      items: [
        {
          groupId: 'iface-1',
          source: 'import',
          severity: 'error',
          problem: { code: 'x', message: 'Schema not found' },
        },
        {
          groupId: 'expansion:req-1',
          source: 'expansion',
          severity: 'warning',
          requestId: 'req-1',
          problem: { code: 'expansion-unknown', message: 'Unresolved property ${#Env#missing} in envelopeXml' },
        },
      ],
    });
    render(<ProblemsView />);

    const rows = screen.getAllByTestId('problem-row');
    expect(rows[0]?.textContent).toContain('import');
    expect(rows[1]?.textContent).toContain('expansion');
    expect(rows[1]?.textContent).toContain('${#Env#missing}');
    expect(screen.getByLabelText('warning')).toBeDefined();
    expect(screen.getByLabelText('error')).toBeDefined();
  });

  it('opens the offending request when an expansion problem is clicked', () => {
    useProblemsStore.setState({
      items: [
        {
          groupId: 'expansion:req-1',
          source: 'expansion',
          severity: 'warning',
          requestId: 'req-1',
          problem: { code: 'expansion-unknown', message: 'Unresolved property ${#Env#missing} in envelopeXml' },
        },
      ],
    });
    render(<ProblemsView />);

    fireEvent.click(screen.getByTestId('problem-row'));
    expect(useEditorsStore.getState().tabs).toEqual([
      { id: 'request:req-1', kind: 'request', title: 'Request 1', requestId: 'req-1' },
    ]);
  });
  it('shows a validation problem with its location and request name, and filters by severity', () => {
    useProblemsStore.setState({
      items: [
        {
          groupId: 'validation:req-1:request',
          source: 'validation',
          severity: 'error',
          requestId: 'req-1',
          problem: { code: 'schema-invalid', message: "'abc' is not a valid xs:int", source: 'schema', line: 6 },
        },
        {
          groupId: 'validation:req-1:request',
          source: 'validation',
          severity: 'warning',
          requestId: 'req-1',
          problem: { code: 'content-type-mismatch', message: 'Content-Type disagrees', source: 'structure' },
        },
      ],
    });
    render(<ProblemsView />);

    expect(screen.getByTestId('problem-location').textContent).toBe('6');
    expect(screen.getAllByText('Request 1').length).toBeGreaterThan(0);
    expect(screen.getAllByTestId('problem-row')).toHaveLength(2);

    fireEvent.click(screen.getByTestId('problems-filter-error'));
    const rows = screen.getAllByTestId('problem-row');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toContain('is not a valid xs:int');

    fireEvent.click(screen.getByTestId('problems-filter-warning'));
    expect(screen.getAllByTestId('problem-row')[0]?.textContent).toContain('Content-Type disagrees');
  });

  it('keeps lint findings behind their own chip, with counts that leave them out (#745)', () => {
    useProblemsStore.setState({
      items: [
        {
          groupId: 'validation:req-1:request',
          source: 'validation',
          severity: 'warning',
          requestId: 'req-1',
          problem: { code: 'content-type-mismatch', message: 'Content-Type disagrees', source: 'structure' },
        },
      ],
    });
    useProblemsStore.getState().setLint('api-1', [
      { rule: 'info-description', severity: 'warning', message: 'Add a description', path: '/info', source: 's' },
      { rule: 'oas3-schema', severity: 'error', message: 'Not a schema', path: '/paths', source: 's' },
    ]);
    render(<ProblemsView />);

    // All, Errors and Warnings count and list the one problem; Lint counts the two findings.
    expect(screen.getByTestId('problems-filter-error').textContent).toBe('Errors');
    expect(screen.getByTestId('problems-filter-warning').textContent).toBe('Warnings (1)');
    expect(screen.getByTestId('problems-filter-lint').textContent).toBe('Lint (2)');
    expect(screen.getAllByTestId('problem-row')).toHaveLength(1);
    expect(screen.queryByText('Add a description')).toBeNull();

    fireEvent.click(screen.getByTestId('problems-filter-lint'));
    expect(screen.getByTestId('problems-filter-lint').getAttribute('aria-pressed')).toBe('true');
    const rows = screen.getAllByTestId('problem-row');
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining('Add a description'),
      expect.stringContaining('Not a schema'),
    ]);

    // An empty lint list says so, instead of the blanket "No problems found."
    act(() => {
      useProblemsStore.getState().setLint('api-1', []);
    });
    expect(screen.getByTestId('problems-empty').textContent).toBe('No lint findings.');
  });

  it('opens the request a validation problem belongs to when its row is clicked', () => {
    useProblemsStore.setState({
      items: [
        {
          groupId: 'validation:req-1:request',
          source: 'validation',
          severity: 'error',
          requestId: 'req-1',
          direction: 'request',
          problem: { code: 'schema-invalid', message: 'bad', source: 'schema', line: 6 },
        },
      ],
    });
    render(<ProblemsView />);

    fireEvent.click(screen.getByTestId('problem-row'));
    expect(useEditorsStore.getState().tabs).toEqual([
      { id: 'request:req-1', kind: 'request', title: 'Request 1', requestId: 'req-1' },
    ]);
  });

  it('switches the response pane to its XML view when a response validation problem is clicked', () => {
    useProblemsStore.setState({
      items: [
        {
          groupId: 'validation:req-1:response',
          source: 'validation',
          severity: 'error',
          requestId: 'req-1',
          direction: 'response',
          problem: { code: 'schema-invalid', message: 'bad response', source: 'schema', line: 4 },
        },
      ],
    });
    render(<ProblemsView />);

    fireEvent.click(screen.getByTestId('problem-row'));
    expect(useEditorsStore.getState().tabs).toEqual([
      { id: 'request:req-1', kind: 'request', title: 'Request 1', requestId: 'req-1' },
    ]);
    expect(useEditorsStore.getState().responseViewFor('req-1')).toBe('xml');
  });

  it('labels rows `<project> › <interface> › ...` with two projects open', () => {
    const requestB = {
      id: 'req-2',
      interfaceId: 'iface-2',
      bindingName: '{tns}B',
      operationName: 'Sub',
      name: 'Request 2',
      envelopeXml: '<Envelope/>',
      soapVersion: '1.1',
      headers: [],
      order: 0,
    } as unknown as RequestWire;
    useProjectStore.setState({
      requests: { 'req-1': request, 'req-2': requestB },
      interfaces: {
        'iface-1': { id: 'iface-1', name: 'Calculator' } as InterfaceWire,
        'iface-2': { id: 'iface-2', name: 'Weather' } as InterfaceWire,
      },
      projects: {
        p1: { id: 'p1', name: 'Calc Project' } as ProjectWire,
        p2: { id: 'p2', name: 'Weather Project' } as ProjectWire,
      },
      projectOf: { 'req-1': 'p1', 'iface-1': 'p1', 'req-2': 'p2', 'iface-2': 'p2' },
    });
    useProblemsStore.setState({
      items: [
        {
          groupId: 'expansion:req-1',
          source: 'expansion',
          severity: 'warning',
          requestId: 'req-1',
          problem: { code: 'x', message: 'From project one' },
        },
        {
          groupId: 'expansion:req-2',
          source: 'expansion',
          severity: 'warning',
          requestId: 'req-2',
          problem: { code: 'x', message: 'From project two' },
        },
        {
          groupId: 'iface-2',
          source: 'import',
          severity: 'error',
          problem: { code: 'x', message: 'Import problem, no request' },
        },
      ],
    });
    render(<ProblemsView />);

    const rows = screen.getAllByTestId('problem-row');
    expect(rows[0]?.textContent).toContain('Calc Project › Calculator');
    expect(rows[1]?.textContent).toContain('Weather Project › Weather');
    expect(rows[2]?.textContent).toContain('Weather Project › Weather');
  });

  it("opens the right project's request when clicking a row in a multi-project list", () => {
    const requestB = {
      id: 'req-2',
      interfaceId: 'iface-2',
      bindingName: '{tns}B',
      operationName: 'Sub',
      name: 'Request 2',
      envelopeXml: '<Envelope/>',
      soapVersion: '1.1',
      headers: [],
      order: 0,
    } as unknown as RequestWire;
    useProjectStore.setState({
      requests: { 'req-1': request, 'req-2': requestB },
      projectOf: { 'req-1': 'p1', 'req-2': 'p2' },
    });
    useProblemsStore.setState({
      items: [
        {
          groupId: 'expansion:req-2',
          source: 'expansion',
          severity: 'warning',
          requestId: 'req-2',
          problem: { code: 'x', message: 'From project two' },
        },
      ],
    });
    render(<ProblemsView />);

    fireEvent.click(screen.getByTestId('problem-row'));
    expect(useEditorsStore.getState().tabs).toEqual([
      { id: 'request:req-2', kind: 'request', title: 'Request 2', requestId: 'req-2' },
    ]);
  });
});
