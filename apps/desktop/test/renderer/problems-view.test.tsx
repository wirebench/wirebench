import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ProblemsView } from '../../src/renderer/features/problems/problems-view.js';
import { useEditorsStore } from '../../src/renderer/state/editors.js';
import { useProblemsStore } from '../../src/renderer/state/problems.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import type { RequestWire } from '../../src/shared/wire-types.js';

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
    useProblemsStore.setState({ items: [] });
    useEditorsStore.setState({ tabs: [], activeId: undefined });
    useProjectStore.setState({ requests: { 'req-1': request } });
  });

  afterEach(() => {
    cleanup();
    useProjectStore.setState({ requests: {} });
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
});
