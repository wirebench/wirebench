import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ProblemsView } from '../../src/renderer/features/problems/problems-view.js';
import { lintRestDefinition } from '../../src/renderer/features/rest-api/lint-actions.js';
import { lintGroupId, useProblemsStore } from '../../src/renderer/state/problems.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import { useUiStore } from '../../src/renderer/state/ui.js';
import type { LintFindingWire } from '../../src/shared/kinds/rest/wire.js';

const restLint = vi.fn();
const toasts = vi.hoisted(() => [] as string[]);

vi.mock('../../src/renderer/state/ipc-client.js', () => ({ ipc: () => ({ api: { restLint } }) }));
const opened = vi.hoisted(() => [] as string[]);
vi.mock('../../src/renderer/features/rest-editor/rest-actions.js', () => ({
  openRestRequestTab: (id: string) => {
    opened.push(`request:${id}`);
  },
}));
vi.mock('../../src/renderer/features/rest-api/api-actions.js', () => ({
  openApiTab: (id: string) => {
    opened.push(`api:${id}`);
  },
}));
vi.mock('../../src/renderer/components/toast.js', () => ({
  showToast: (message: string) => {
    toasts.push(message);
  },
}));

const finding = (rule: string, severity: LintFindingWire['severity'], line = 2, path = '/info'): LintFindingWire => ({
  rule,
  severity,
  message: `${rule} broke`,
  path,
  source: 'file:///p/openapi.yaml',
  range: { start: { line, column: 6 }, end: { line, column: 9 } },
});

function seedApi(cache: boolean): void {
  useProjectStore.setState({
    apis: {
      'api-1': {
        id: 'api-1',
        name: 'Pets',
        baseUrl: 'http://pets.test/v1',
        servers: [],
        ...(cache ? { definition: { cache: true } } : {}),
      },
    },
    restRequests: {
      'req-list': { id: 'req-list', apiId: 'api-1', order: 0, method: 'GET', url: '/json' },
      'req-get': { id: 'req-get', apiId: 'api-1', order: 1, method: 'GET', url: '${baseUrl}/pets/{id}' },
    },
    projects: { 'proj-1': { name: 'Shop' } },
    projectOf: { 'api-1': 'proj-1' },
  } as unknown as Parameters<typeof useProjectStore.setState>[0]);
}

describe('lint findings in Problems', () => {
  beforeEach(() => {
    useProblemsStore.setState({ items: [] });
    restLint.mockReset();
    toasts.length = 0;
    opened.length = 0;
  });

  afterEach(() => {
    cleanup();
    useProjectStore.setState({ apis: {}, restRequests: {}, projects: {}, projectOf: {} } as unknown as Parameters<
      typeof useProjectStore.setState
    >[0]);
  });

  it("files an API's findings under its own group, replacing only that group", () => {
    const store = useProblemsStore.getState();
    store.add([{ groupId: 'iface-1', source: 'import', severity: 'error', problem: { code: 'x', message: 'x' } }]);
    store.setLint('api-1', [finding('owasp-plain-http', 'error'), finding('info-description', 'hint')]);
    store.setLint('api-1', [finding('info-description', 'info', 3)]);
    const items = useProblemsStore.getState().items;
    expect(items.map((item) => item.groupId)).toEqual(['iface-1', lintGroupId('api-1')]);
    expect(items[1]).toMatchObject({
      source: 'lint',
      severity: 'warning',
      problem: { code: 'info-description', source: 'lint', location: '/info', line: 3, column: 6 },
    });
  });

  it('shows a lint row with its message, rule, readable place and the API it is in', () => {
    seedApi(true);
    useProblemsStore
      .getState()
      .setLint('api-1', [
        finding('media-example', 'warning', 15, '/paths/~1json/get/responses/200/content/application~1json'),
      ]);
    render(<ProblemsView />);
    const row = screen.getByRole('row');
    expect(row.textContent).toContain('media-example broke');
    expect(row.textContent).not.toContain('media-example: ');
    expect(screen.getByTestId('problem-rule').textContent).toBe('media-example');
    expect(row.textContent).toContain('Shop › Pets');
    const location = screen.getByTestId('problem-location');
    expect(location.textContent).toBe('GET /json › 200 › application/json');
    expect(location.getAttribute('title')).toBe('/paths/~1json/get/responses/200/content/application~1json 15:6');
  });

  it("opens the request for a finding's operation, and the API for anything else", () => {
    seedApi(true);
    useProblemsStore
      .getState()
      .setLint('api-1', [
        finding('operation-operationId', 'warning', 19, '/paths/~1pets~1{id}/get'),
        finding('info-description', 'warning', 2, '/info'),
        finding('operation-operationId', 'warning', 30, '/paths/~1pets/delete'),
      ]);
    render(<ProblemsView />);
    for (const row of screen.getAllByTestId('problem-row')) fireEvent.click(row);
    expect(opened).toEqual(['request:req-get', 'api:api-1', 'api:api-1']);
  });

  it('lints a cached API on demand and opens Problems', async () => {
    seedApi(true);
    restLint.mockResolvedValue({ ok: true, value: { findings: [finding('info-description', 'warning')] } });
    await lintRestDefinition('api-1', { reveal: true });
    expect(restLint).toHaveBeenCalledWith({ apiId: 'api-1' });
    expect(useProblemsStore.getState().items).toHaveLength(1);
    expect(useUiStore.getState().console.activeTab).toBe('problems');
  });

  it('says so when a lint the user asked for finds nothing or fails, and stays quiet otherwise', async () => {
    seedApi(true);
    restLint.mockResolvedValue({ ok: true, value: { findings: [] } });
    await lintRestDefinition('api-1', { reveal: true });
    restLint.mockResolvedValue({ ok: false, error: { code: 'x', message: 'cache unreadable' } });
    await lintRestDefinition('api-1', { reveal: false });
    await lintRestDefinition('api-1', { reveal: true });
    expect(toasts).toEqual(['Lint found no problems.', 'Lint failed: cache unreadable']);
  });

  it('does nothing for an API that did not cache its definition', async () => {
    seedApi(false);
    await lintRestDefinition('api-1', { reveal: true });
    expect(restLint).not.toHaveBeenCalled();
  });
});
