import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ProblemsView } from '../../src/renderer/features/problems/problems-view.js';
import { lintRestDefinition } from '../../src/renderer/features/rest-api/lint-actions.js';
import { lintGroupId, useProblemsStore } from '../../src/renderer/state/problems.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import { useUiStore } from '../../src/renderer/state/ui.js';
import type { LintFindingWire } from '../../src/shared/kinds/rest/wire.js';

const restLint = vi.fn();
const toasts = vi.hoisted(() => [] as string[]);

vi.mock('../../src/renderer/state/ipc-client.js', () => ({ ipc: () => ({ api: { restLint } }) }));
vi.mock('../../src/renderer/components/toast.js', () => ({
  showToast: (message: string) => {
    toasts.push(message);
  },
}));

const finding = (rule: string, severity: LintFindingWire['severity'], line = 2): LintFindingWire => ({
  rule,
  severity,
  message: `${rule} broke`,
  path: '/info',
  source: 'file:///p/openapi.yaml',
  range: { start: { line, column: 6 }, end: { line, column: 9 } },
});

function seedApi(cache: boolean): void {
  useProjectStore.setState({
    apis: { 'api-1': { id: 'api-1', name: 'Pets', ...(cache ? { definition: { cache: true } } : {}) } },
    projects: { 'proj-1': { name: 'Shop' } },
    projectOf: { 'api-1': 'proj-1' },
  } as unknown as Parameters<typeof useProjectStore.setState>[0]);
}

describe('lint findings in Problems', () => {
  beforeEach(() => {
    useProblemsStore.setState({ items: [] });
    restLint.mockReset();
    toasts.length = 0;
  });

  afterEach(() => {
    cleanup();
    useProjectStore.setState({ apis: {}, projects: {}, projectOf: {} } as unknown as Parameters<
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

  it('shows a lint row with its rule, position and the API it is in', () => {
    seedApi(true);
    useProblemsStore.getState().setLint('api-1', [finding('owasp-plain-http', 'error')]);
    render(<ProblemsView />);
    const row = screen.getByRole('row');
    expect(row.textContent).toContain('owasp-plain-http: owasp-plain-http broke');
    expect(row.textContent).toContain('Shop › Pets');
    expect(screen.getByTestId('problem-location').textContent).toBe('/info 2:6');
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
