import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { WsiReport } from '../../src/renderer/features/console/wsi-report.js';
import { useWsiStore } from '../../src/renderer/state/wsi.js';
import { useExchangesStore } from '../../src/renderer/state/exchanges.js';
import { useUiStore } from '../../src/renderer/state/ui.js';
import { DEFAULT_UI_STATE } from '../../src/renderer/state/ui-state.js';
import { explorerActions } from '../../src/renderer/features/explorer/explorer-actions.js';
import { checkWsiForRequest, lastSendId } from '../../src/renderer/features/request-editor/wsi-actions.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import type { WsiReportWire } from '../../src/shared/wire-types.js';

const REPORT: WsiReportWire = {
  target: 'http://example.invalid/calc',
  profile: 'BP1.1',
  summary: { passed: 9, failed: 1, warning: 1, notApplicable: 3 },
  label: 'Add — last exchange',
  scope: 'message',
  assertions: [
    {
      id: 'R1109',
      title: 'The SOAPAction request header is a quoted string',
      level: 'REQUIRED',
      section: '3.4 Use of SOAP in HTTP',
      result: 'failed',
      findings: [{ message: 'SOAPAction: urn:x is not a quoted string', location: { document: 'request', line: 1 } }],
    },
    {
      id: 'R1124',
      title: 'A non-fault response carries HTTP status 200 or 202',
      level: 'RECOMMENDED',
      section: '3.4 Use of SOAP in HTTP',
      result: 'warning',
      findings: [{ message: 'the HTTP status is 418', location: { document: 'response' } }],
    },
    {
      id: 'R1141',
      title: 'Content-Type states a charset parameter',
      level: 'REQUIRED',
      section: '3.4 Use of SOAP in HTTP',
      result: 'passed',
      findings: [],
    },
  ],
};

describe('WS-I Report tab', () => {
  beforeEach(() => {
    installWirebenchApi();
    useWsiStore.setState({ status: 'idle', report: undefined, error: undefined, showAll: false });
    useUiStore.setState(DEFAULT_UI_STATE);
    useExchangesStore.setState({ byRequest: {}, log: [] });
  });

  afterEach(() => {
    cleanup();
  });

  it('shows the empty state before any run, and while one is in flight', () => {
    render(<WsiReport />);
    expect(screen.getByTestId('wsi-empty').textContent).toContain('Run a WS-I Basic Profile check');
    cleanup();

    useWsiStore.setState({ status: 'running' });
    render(<WsiReport />);
    expect(screen.getByTestId('wsi-empty').textContent).toContain('Running');
  });

  it('shows the failure message when a run fails', () => {
    useWsiStore.setState({ status: 'error', error: 'no such interface' });
    render(<WsiReport />);
    expect(screen.getByTestId('wsi-error').textContent).toBe('no such interface');
  });

  it('renders the label, summary chips, target and only the failing rows', () => {
    useWsiStore.setState({ status: 'ready', report: REPORT, showAll: false });
    render(<WsiReport />);
    expect(screen.getByTestId('wsi-label').textContent).toBe('Add — last exchange');
    expect(screen.getByTestId('wsi-summary-passed').textContent).toBe('Passed: 9');
    expect(screen.getByTestId('wsi-summary-n/a').textContent).toBe('N/A: 3');
    expect(screen.getByTestId('wsi-target').textContent).toBe('http://example.invalid/calc');
    expect(screen.getAllByTestId('wsi-row').map((row) => row.getAttribute('data-result'))).toEqual([
      'failed',
      'warning',
    ]);
    expect(screen.getAllByTestId('wsi-finding')[0]?.textContent).toContain('(request:1)');
    expect(screen.getAllByTestId('wsi-finding')[1]?.textContent).toContain('(response)');
  });

  it('the "failed only" chip toggles the passing rows in', () => {
    useWsiStore.setState({ status: 'ready', report: REPORT, showAll: false });
    render(<WsiReport />);
    fireEvent.click(screen.getByTestId('wsi-filter-failed'));
    expect(screen.getAllByTestId('wsi-row')).toHaveLength(3);
    expect(useWsiStore.getState().showAll).toBe(true);
    fireEvent.click(screen.getByTestId('wsi-filter-failed'));
    expect(screen.getAllByTestId('wsi-row')).toHaveLength(2);
  });

  it('says so when a clean report has nothing to list', () => {
    useWsiStore.setState({
      status: 'ready',
      report: { ...REPORT, assertions: [REPORT.assertions[2]!], summary: { ...REPORT.summary, failed: 0, warning: 0 } },
      showAll: false,
    });
    render(<WsiReport />);
    expect(screen.getByTestId('wsi-no-rows').textContent).toBe('No failures or warnings.');
  });

  it('Export HTML sends the report, the suggested name and the current filter', async () => {
    const exportHtml = vi.fn().mockResolvedValue({ ok: true, value: { path: '/tmp/r.html', cancelled: false } });
    installWirebenchApi({ wsi: { exportHtml } });
    useWsiStore.setState({ status: 'ready', report: REPORT, showAll: true });
    render(<WsiReport />);
    fireEvent.click(screen.getByTestId('wsi-export-html'));
    await waitFor(() => {
      expect(exportHtml).toHaveBeenCalledWith({
        report: REPORT,
        suggestedName: 'Add-last-exchange-ws-i-report.html',
        verbose: true,
      });
    });
  });
});

describe('WS-I store', () => {
  beforeEach(() => {
    useWsiStore.setState({ status: 'idle', report: undefined, error: undefined, showAll: false });
    useUiStore.setState(DEFAULT_UI_STATE);
    useExchangesStore.setState({ byRequest: {}, log: [] });
  });

  it('checkWsdl files the report and reveals the console tab', async () => {
    installWirebenchApi({
      wsi: { checkWsdl: vi.fn().mockResolvedValue({ ok: true, value: { ...REPORT, scope: 'wsdl' } }) },
    });
    explorerActions.checkWsiWsdl('iface-1');
    await waitFor(() => {
      expect(useWsiStore.getState().status).toBe('ready');
    });
    expect(useWsiStore.getState().report?.scope).toBe('wsdl');
    expect(useUiStore.getState().console.activeTab).toBe('ws-i-report');
    expect(useUiStore.getState().console.visible).toBe(true);
  });

  it('records the error when a run fails', async () => {
    installWirebenchApi({
      wsi: {
        checkWsdl: vi.fn().mockResolvedValue({ ok: false, error: { code: 'unknown-interface', message: 'gone' } }),
      },
    });
    await useWsiStore.getState().checkWsdl('iface-1');
    expect(useWsiStore.getState()).toMatchObject({ status: 'error', error: 'gone' });
  });

  it('exportHtml does nothing without a report, and reports cancellation', async () => {
    const exportHtml = vi.fn().mockResolvedValue({ ok: true, value: { cancelled: true } });
    installWirebenchApi({ wsi: { exportHtml } });
    await useWsiStore.getState().exportHtml();
    expect(exportHtml).not.toHaveBeenCalled();

    useWsiStore.setState({ status: 'ready', report: REPORT });
    await useWsiStore.getState().exportHtml();
    expect(exportHtml).toHaveBeenCalledTimes(1);
  });

  it('clear resets the tab', () => {
    useWsiStore.setState({ status: 'ready', report: REPORT });
    useWsiStore.getState().clear();
    expect(useWsiStore.getState()).toMatchObject({ status: 'idle', report: undefined });
  });
});

describe('checkWsiForRequest', () => {
  beforeEach(() => {
    useWsiStore.setState({ status: 'idle', report: undefined, error: undefined, showAll: false });
    useExchangesStore.setState({ byRequest: {}, log: [] });
  });

  it('refuses when the request has never been sent', async () => {
    installWirebenchApi();
    expect(lastSendId('req-1')).toBeUndefined();
    await checkWsiForRequest('req-1');
    expect(useWsiStore.getState().status).toBe('idle');
  });

  it('runs the message catalogue over the last exchange', async () => {
    const checkExchange = vi.fn().mockResolvedValue({ ok: true, value: REPORT });
    installWirebenchApi({ wsi: { checkExchange } });
    useExchangesStore.setState({
      byRequest: { 'req-1': { status: 'done', sendId: 'send-9', exchange: { sendId: 'send-9' } as never } },
      log: [],
    });
    await checkWsiForRequest('req-1');
    expect(checkExchange).toHaveBeenCalledWith({ sendId: 'send-9' });
    expect(useWsiStore.getState().report?.label).toBe('Add — last exchange');
  });
});
