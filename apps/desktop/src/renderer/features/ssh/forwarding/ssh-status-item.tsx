import { showForwarding } from './forward-actions.js';
import { forwardCounts, useForwardsStore } from './forwards-store.js';

/**
 * The SSH area's status bar item: `⇄ N` while N forwards run, `⇄ N · M failed` (red) while any has failed; it opens the Port
 * forwarding view. Nothing shows while none runs and none failed.
 */
export function SshStatusItem() {
  const running = useForwardsStore((s) => forwardCounts(s.byKey).running);
  const failed = useForwardsStore((s) => forwardCounts(s.byKey).failed);
  if (running === 0 && failed === 0) return null;
  const label = `${String(running)} ${running === 1 ? 'forward' : 'forwards'} running${
    failed > 0 ? `, ${String(failed)} failed` : ''
  }. Show port forwarding`;
  return (
    <>
      <span aria-hidden="true" className="text-fg-faint">
        ·
      </span>
      <button
        type="button"
        data-testid="status-bar-forwards"
        data-failed={failed > 0 || undefined}
        title={label}
        aria-label={label}
        className={`rounded-sm px-1 font-mono hover:bg-surface-hover hover:text-fg-default ${
          failed > 0 ? 'text-status-danger' : ''
        }`}
        onClick={() => {
          showForwarding();
        }}
      >
        ⇄ {running}
        {failed > 0 && ` · ${String(failed)} failed`}
      </button>
    </>
  );
}
