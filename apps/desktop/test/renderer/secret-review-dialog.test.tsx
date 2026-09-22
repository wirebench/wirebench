import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SecretReviewDialog } from '../../src/renderer/components/secret-review-dialog.js';
import { reviewSecrets, useSecretReviewStore } from '../../src/renderer/state/secret-review.js';
import type { SecretReviewOutcome } from '../../src/renderer/state/secret-review.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import type { SecretFindingWire } from '../../src/shared/wire-types.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';

const showToast = vi.hoisted(() => vi.fn());
vi.mock('../../src/renderer/components/toast.js', () => ({ showToast }));

/**
 * What these fixtures stand for, and what must never appear on screen: the renderer is only ever
 * handed a preview. Nothing here is a real credential.
 */
const FAKE_VALUE = 'fake-token-for-tests-only';

function finding(id: string, label: string, overrides: Partial<SecretFindingWire> = {}): SecretFindingWire {
  return {
    id,
    location: { kind: 'rest-header', requestId: 'rr-1', name: 'Authorization', index: 0 },
    rule: 'bearer',
    label,
    preview: 'fak… (25 chars)',
    ...overrides,
  };
}

interface MoveItem {
  readonly id: string;
  readonly name: string;
  readonly replace?: boolean;
}

/**
 * Main's side of the review, in memory: a scan answers with what is left, a keep hides ids and a
 * move takes them out — unless the test says a name is taken or an id went stale.
 */
function fakeMain(initial: readonly SecretFindingWire[], options: { storedNames?: string[] } = {}) {
  let findings = [...initial];
  const proposedNames: Record<string, string> = {};
  for (const f of initial) {
    proposedNames[f.id] = `${f.id}_token`;
  }
  const storedNames = [...(options.storedNames ?? [])];
  const takenNames = new Set(storedNames);
  const staleIds = new Set<string>();
  const scan = vi
    .fn()
    .mockImplementation(() => Promise.resolve({ ok: true, value: { findings, proposedNames, storedNames } }));
  const keep = vi.fn().mockImplementation((request: { ids: string[] }) => {
    findings = findings.filter((f) => !request.ids.includes(f.id));
    return Promise.resolve({ ok: true, value: {} });
  });
  const move = vi.fn().mockImplementation((request: { items: MoveItem[] }) => {
    const moved: string[] = [];
    const stale: string[] = [];
    const nameTaken: string[] = [];
    for (const item of request.items) {
      if (staleIds.has(item.id)) {
        stale.push(item.id);
      } else if (takenNames.has(item.name) && item.replace !== true) {
        nameTaken.push(item.id);
      } else {
        moved.push(item.id);
      }
    }
    findings = findings.filter((f) => !moved.includes(f.id));
    return Promise.resolve({ ok: true, value: { moved, stale, nameTaken } });
  });
  const api = installWirebenchApi({ secretScan: { scan, keep, move } });
  return {
    api,
    scan,
    keep,
    move,
    /** Makes Move report `name` as already stored, as main does for a name another value holds. */
    takeName: (name: string) => takenNames.add(name),
    /** Makes Move report `id` as stale, as main does for a value edited since the scan. */
    staleId: (id: string) => staleIds.add(id),
  };
}

/** Starts a review and waits for its dialog; the promise is what the save would await. */
async function openReview(mode: 'save' | 'commit' = 'save'): Promise<{ outcome: Promise<SecretReviewOutcome> }> {
  let outcome!: Promise<SecretReviewOutcome>;
  act(() => {
    outcome = reviewSecrets(mode, ['p1']);
  });
  await screen.findByRole('alertdialog');
  return { outcome };
}

function rowFor(label: string): HTMLElement {
  const row = screen.getAllByTestId('secret-review-row').find((candidate) => candidate.textContent?.includes(label));
  if (row === undefined) {
    throw new Error(`no row for ${label}`);
  }
  return row;
}

beforeEach(() => {
  showToast.mockClear();
  useProjectStore.setState({ projects: {} });
  render(<SecretReviewDialog />);
});

afterEach(async () => {
  // A test that leaves its review open must not leak it into the next one.
  act(() => {
    useSecretReviewStore.getState().cancel();
  });
  await Promise.resolve();
  cleanup();
});

describe('reviewSecrets', () => {
  it('goes ahead without showing anything when nothing is found', async () => {
    const main = fakeMain([]);

    await expect(reviewSecrets('save', ['p1'])).resolves.toBe('proceed');

    expect(main.scan).toHaveBeenCalledWith({ projectId: 'p1' });
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('lists each finding with its label, rule and preview — never a value', async () => {
    fakeMain([
      finding('a', 'Billing API › GET /invoices › header Authorization'),
      finding('b', 'Project property api_password', {
        rule: 'sensitive-name',
        location: { kind: 'project-property', name: 'api_password' },
        preview: 'hun… (7 chars)',
      }),
    ]);
    await openReview();

    const rows = screen.getAllByTestId('secret-review-row');
    expect(rows).toHaveLength(2);
    const first = rowFor('header Authorization');
    expect(within(first).getByText('Bearer token')).toBeTruthy();
    expect(within(first).getByText('fak… (25 chars)')).toBeTruthy();
    expect(within(first).getByRole<HTMLInputElement>('textbox').value).toBe('a_token');
    expect(within(rowFor('api_password')).getByText('Sensitive name')).toBeTruthy();
    expect(document.body.textContent).not.toContain(FAKE_VALUE);
    expect(screen.getByRole('button', { name: 'Save anyway' })).toBeTruthy();
  });

  it('says "Commit anyway" when it runs before a commit', async () => {
    fakeMain([finding('a', 'header Authorization')]);
    const { outcome } = await openReview('commit');

    await userEvent.click(screen.getByRole('button', { name: 'Commit anyway' }));

    await expect(outcome).resolves.toBe('proceed');
  });

  it('moves a finding under the name typed, by id and name only, and goes ahead once none is left', async () => {
    const main = fakeMain([finding('a', 'header Authorization')]);
    const { outcome } = await openReview();

    const name = within(rowFor('header Authorization')).getByRole('textbox');
    await userEvent.clear(name);
    await userEvent.type(name, 'billing_token');
    await userEvent.click(within(rowFor('header Authorization')).getByRole('button', { name: 'Move to secret' }));

    await expect(outcome).resolves.toBe('proceed');
    expect(main.move).toHaveBeenCalledWith({ projectId: 'p1', items: [{ id: 'a', name: 'billing_token' }] });
    const items = (main.move.mock.calls[0]?.[0] as { items: MoveItem[] }).items;
    expect(Object.keys(items[0]!).sort()).toEqual(['id', 'name']);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('blocks Move with a message while a name is not a valid secret name', async () => {
    const main = fakeMain([finding('a', 'header Authorization'), finding('b', 'header X-Api-Key')]);
    await openReview();
    const row = rowFor('header Authorization');
    const name = within(row).getByRole('textbox');

    await userEvent.clear(name);
    await userEvent.type(name, '9 lives');

    expect(within(row).getByText(/letters, digits and underscores/i)).toBeTruthy();
    expect(name.getAttribute('aria-invalid')).toBe('true');
    const move = within(row).getByRole<HTMLButtonElement>('button', { name: 'Move to secret' });
    expect(move.disabled).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Move all' }).disabled).toBe(true);
    await userEvent.click(move);
    expect(main.move).not.toHaveBeenCalled();

    await userEvent.clear(name);
    expect(within(row).getByText(/enter a name/i)).toBeTruthy();
    await userEvent.type(name, 'lives_9');
    expect(within(row).queryByText(/letters, digits and underscores/i)).toBeNull();
    expect(move.disabled).toBe(false);
  });

  it('moves every finding at once with Move all', async () => {
    const main = fakeMain([finding('a', 'header Authorization'), finding('b', 'header X-Api-Key')]);
    const { outcome } = await openReview();

    await userEvent.click(screen.getByRole('button', { name: 'Move all' }));

    await expect(outcome).resolves.toBe('proceed');
    expect(main.move).toHaveBeenCalledTimes(1);
    expect(main.move).toHaveBeenCalledWith({
      projectId: 'p1',
      items: [
        { id: 'a', name: 'a_token' },
        { id: 'b', name: 'b_token' },
      ],
    });
  });

  it('offers to replace a stored value when Move reports the name taken, and replaces on retry', async () => {
    const main = fakeMain([finding('a', 'header Authorization')]);
    main.takeName('a_token');
    const { outcome } = await openReview();
    const row = rowFor('header Authorization');
    expect(within(row).queryByRole('checkbox')).toBeNull();

    await userEvent.click(within(row).getByRole('button', { name: 'Move to secret' }));

    const replace = await within(rowFor('header Authorization')).findByRole('checkbox', {
      name: 'Replace the stored value',
    });
    expect(within(rowFor('header Authorization')).getByText(/already has a stored value/i)).toBeTruthy();
    expect(screen.getByRole('alertdialog')).toBeTruthy();

    await userEvent.click(replace);
    await userEvent.click(within(rowFor('header Authorization')).getByRole('button', { name: 'Move to secret' }));

    await expect(outcome).resolves.toBe('proceed');
    expect(main.move).toHaveBeenLastCalledWith({
      projectId: 'p1',
      items: [{ id: 'a', name: 'a_token', replace: true }],
    });
  });

  it('shows the replace option up front for a name this project already stores', async () => {
    fakeMain([finding('a', 'header Authorization')], { storedNames: ['a_token'] });
    await openReview();

    expect(
      within(rowFor('header Authorization')).getByRole('checkbox', { name: 'Replace the stored value' }),
    ).toBeTruthy();

    // A name nobody stores yet needs no such choice.
    const name = within(rowFor('header Authorization')).getByRole('textbox');
    await userEvent.clear(name);
    await userEvent.type(name, 'fresh_name');
    expect(within(rowFor('header Authorization')).queryByRole('checkbox')).toBeNull();
  });

  it('says so on the row when a finding changed before it could be moved', async () => {
    const main = fakeMain([finding('a', 'header Authorization'), finding('b', 'header X-Api-Key')]);
    main.staleId('a');
    await openReview();

    await userEvent.click(within(rowFor('header Authorization')).getByRole('button', { name: 'Move to secret' }));

    expect(await within(rowFor('header Authorization')).findByText(/changed since it was found/i)).toBeTruthy();
  });

  it('keeps a finding: the row goes, the others stay, and nothing is moved', async () => {
    const main = fakeMain([finding('a', 'header Authorization'), finding('b', 'header X-Api-Key')]);
    const { outcome } = await openReview();

    await userEvent.click(within(rowFor('header Authorization')).getByRole('button', { name: 'Keep' }));

    await waitFor(() => {
      expect(screen.getAllByTestId('secret-review-row')).toHaveLength(1);
    });
    expect(main.keep).toHaveBeenCalledWith({ projectId: 'p1', ids: ['a'] });
    expect(main.move).not.toHaveBeenCalled();
    expect(rowFor('header X-Api-Key')).toBeTruthy();

    await userEvent.click(within(rowFor('header X-Api-Key')).getByRole('button', { name: 'Keep' }));
    await expect(outcome).resolves.toBe('proceed');
  });

  it('goes ahead on Save anyway without keeping or moving anything', async () => {
    const main = fakeMain([finding('a', 'header Authorization')]);
    const { outcome } = await openReview();

    await userEvent.click(screen.getByRole('button', { name: 'Save anyway' }));

    await expect(outcome).resolves.toBe('proceed');
    expect(main.keep).not.toHaveBeenCalled();
    expect(main.move).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('cancels on Cancel', async () => {
    fakeMain([finding('a', 'header Authorization')]);
    const { outcome } = await openReview();

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    await expect(outcome).resolves.toBe('cancel');
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('cancels on Escape', async () => {
    fakeMain([finding('a', 'header Authorization')]);
    const { outcome } = await openReview();

    await userEvent.keyboard('{Escape}');

    await expect(outcome).resolves.toBe('cancel');
  });

  it('keeps focus inside the dialog while it is open', async () => {
    fakeMain([finding('a', 'header Authorization'), finding('b', 'header X-Api-Key')]);
    await openReview();
    const dialog = screen.getByRole('alertdialog');
    expect(dialog.contains(document.activeElement)).toBe(true);

    // More presses than the dialog has controls, both ways round: focus wraps, it never leaves.
    for (let i = 0; i < 16; i += 1) {
      await userEvent.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
    for (let i = 0; i < 16; i += 1) {
      await userEvent.tab({ shift: true });
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
  });

  it('refuses a second review while one is open, leaving the first to its answer', async () => {
    const main = fakeMain([finding('a', 'header Authorization')]);
    const { outcome } = await openReview();

    await expect(reviewSecrets('commit', ['p1'])).resolves.toBe('cancel');

    expect(main.scan).toHaveBeenCalledTimes(1);
    expect(screen.getAllByRole('alertdialog')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Save anyway' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Save anyway' }));
    await expect(outcome).resolves.toBe('proceed');
  });

  it('refuses a second review while the first is still scanning', async () => {
    const main = fakeMain([]);
    const first = reviewSecrets('save', ['p1']);
    const second = reviewSecrets('save', ['p1']);

    await expect(second).resolves.toBe('cancel');
    await expect(first).resolves.toBe('proceed');
    expect(main.scan).toHaveBeenCalledTimes(1);
  });

  it('cancels, and says why, when the scan fails', async () => {
    installWirebenchApi({
      secretScan: {
        scan: vi.fn().mockResolvedValue({ ok: false, error: { code: 'internal', message: 'scan broke' } }),
      },
    });

    await expect(reviewSecrets('save', ['p1'])).resolves.toBe('cancel');

    expect(showToast).toHaveBeenCalledWith('Could not check for secrets: scan broke');
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('reviews every project it is given, and names the project on each row when there are several', async () => {
    const scan = vi.fn().mockImplementation((request: { projectId: string }) =>
      Promise.resolve({
        ok: true,
        value: {
          findings: [finding(`${request.projectId}-a`, `header Authorization in ${request.projectId}`)],
          proposedNames: { [`${request.projectId}-a`]: 'token' },
          storedNames: [],
        },
      }),
    );
    const keep = vi.fn().mockResolvedValue({ ok: true, value: {} });
    installWirebenchApi({ secretScan: { scan, keep } });
    useProjectStore.setState({
      projects: {
        p1: { id: 'p1', name: 'Billing' },
        p2: { id: 'p2', name: 'Payments' },
      } as unknown as ReturnType<typeof useProjectStore.getState>['projects'],
    });

    act(() => {
      void reviewSecrets('save', ['p1', 'p2']);
    });
    await screen.findByRole('alertdialog');

    expect(scan).toHaveBeenCalledWith({ projectId: 'p1' });
    expect(scan).toHaveBeenCalledWith({ projectId: 'p2' });
    expect(within(rowFor('in p1')).getByText('Billing')).toBeTruthy();
    expect(within(rowFor('in p2')).getByText('Payments')).toBeTruthy();

    await userEvent.click(within(rowFor('in p2')).getByRole('button', { name: 'Keep' }));
    expect(keep).toHaveBeenCalledWith({ projectId: 'p2', ids: ['p2-a'] });
  });
});
