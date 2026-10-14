/**
 * What an alert says (scheduled-runs spec §3.4), for each kind of target: an email (subject, text and
 * HTML), Slack blocks, a Teams Adaptive Card and the webhook's JSON. Every one is built from an
 * {@link AlertPayload}, which the outbox stores already masked: names, counts, the first three failing
 * requests with their first failing assertion, the commit and a link to the run. Never a body.
 */

/** At most this many failing requests are named in an alert. */
export const ALERT_MAX_FAILURES = 3;

export interface AlertPayload {
  readonly kind: 'failure' | 'recovery' | 'test';
  /** The failure streak this alert reports; for a recovery, the streak that ended. */
  readonly streak: number;
  /** Set on the failure alert at `muteAfter`: later failures are not alerted until it recovers. */
  readonly muted: boolean;
  readonly schedule: { readonly id: string; readonly name: string };
  readonly workspace: { readonly id: string; readonly name: string };
  readonly project: string;
  readonly environment: string | null;
  /** Absent for a test alert. */
  readonly run?: {
    readonly id: string;
    readonly status: string;
    readonly reason: string | null;
    readonly commit: string | null;
    readonly total: number;
    readonly failed: number;
    readonly errored: number;
    readonly durationMs: number;
    /** The run's API resource under the server's public URL. */
    readonly url: string;
  };
  /** At most {@link ALERT_MAX_FAILURES}, in run order. */
  readonly failures: readonly { readonly path: string; readonly message: string }[];
}

export interface RenderedEmail {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

const MUTED_NOTE = 'Further failures are muted until it passes again.';

const where = (p: AlertPayload): string => (p.environment === null ? p.project : `${p.project}, ${p.environment}`);

function headline(p: AlertPayload): string {
  switch (p.kind) {
    case 'failure':
      return `Failing: ${p.schedule.name} (${where(p)})`;
    case 'recovery':
      return `Recovered: ${p.schedule.name} (${where(p)})`;
    default:
      return `Test alert: ${p.schedule.name} (${where(p)})`;
  }
}

/** The run in one line: `failed: 2 of 10 failed, 1 errored, in 3.2 s`, or the reason it stopped. */
function outcomeLine(run: NonNullable<AlertPayload['run']>): string {
  const reason = run.reason === null ? '' : ` (${run.reason})`;
  if (run.total === 0) return `${run.status}${reason}`;
  const errored = run.errored > 0 ? `, ${run.errored} errored` : '';
  return `${run.status}${reason}: ${run.failed} of ${run.total} failed${errored}, in ${(run.durationMs / 1000).toFixed(1)} s`;
}

/** The lines every form shares, in order. */
function lines(p: AlertPayload): string[] {
  const out: string[] = [];
  if (p.kind === 'failure') {
    out.push(
      p.streak === 1
        ? `${p.schedule.name} failed in workspace ${p.workspace.name}.`
        : `${p.schedule.name} failed again in workspace ${p.workspace.name} (${p.streak} runs in a row).`,
    );
  } else if (p.kind === 'recovery') {
    out.push(`${p.schedule.name} passed again in workspace ${p.workspace.name}, after ${p.streak} failed runs.`);
  } else {
    out.push(`This is a test alert for ${p.schedule.name} in workspace ${p.workspace.name}.`);
  }
  out.push(`Project: ${p.project}${p.environment === null ? '' : ` · Environment: ${p.environment}`}`);
  if (p.run !== undefined) {
    out.push(`Outcome: ${outcomeLine(p.run)}`);
    if (p.run.commit !== null) out.push(`Commit: ${p.run.commit.slice(0, 12)}`);
  }
  return out;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Slack's `mrkdwn` treats `&`, `<` and `>` as control characters. */
function escapeSlack(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function renderEmail(p: AlertPayload): RenderedEmail {
  const body = lines(p);
  const text = [
    ...body,
    ...(p.failures.length > 0 ? ['', 'Failing:', ...p.failures.map((f) => `  - ${f.path}: ${f.message}`)] : []),
    ...(p.run !== undefined ? ['', `Run: ${p.run.url}`] : []),
    ...(p.muted ? ['', MUTED_NOTE] : []),
    '',
  ].join('\n');
  const paragraph = (line: string): string => `<p>${escapeHtml(line)}</p>`;
  const html = [
    '<!doctype html><html><body style="font-family: sans-serif">',
    ...body.map(paragraph),
    ...(p.failures.length > 0
      ? [
          '<p>Failing:</p><ul>',
          ...p.failures.map((f) => `<li><code>${escapeHtml(f.path)}</code>: ${escapeHtml(f.message)}</li>`),
          '</ul>',
        ]
      : []),
    ...(p.run !== undefined ? [`<p><a href="${escapeHtml(p.run.url)}">Open the run</a></p>`] : []),
    ...(p.muted ? [paragraph(MUTED_NOTE)] : []),
    '</body></html>',
    '',
  ].join('\n');
  return { subject: `[Wirebench] ${headline(p)}`, text, html };
}

/** Slack refuses a header longer than this. */
const SLACK_HEADER_MAX = 150;

const clip = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

export function renderSlack(p: AlertPayload): Record<string, unknown> {
  const section = (text: string): Record<string, unknown> => ({ type: 'section', text: { type: 'mrkdwn', text } });
  const blocks: Record<string, unknown>[] = [
    { type: 'header', text: { type: 'plain_text', text: clip(headline(p), SLACK_HEADER_MAX) } },
    section(lines(p).map(escapeSlack).join('\n')),
  ];
  if (p.failures.length > 0) {
    const failing = p.failures.map((f) => `• \`${escapeSlack(f.path)}\`: ${escapeSlack(f.message)}`);
    blocks.push(section(['*Failing:*', ...failing].join('\n')));
  }
  if (p.run !== undefined) blocks.push(section(`<${p.run.url}|Open the run>`));
  if (p.muted) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: MUTED_NOTE }] });
  // `text` is the notification's fallback, read as mrkdwn.
  return { text: escapeSlack(headline(p)), blocks };
}

export function renderTeams(p: AlertPayload): Record<string, unknown> {
  const block = (text: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    type: 'TextBlock',
    text,
    wrap: true,
    ...extra,
  });
  const body: Record<string, unknown>[] = [
    block(headline(p), { size: 'Medium', weight: 'Bolder' }),
    ...lines(p).map((line) => block(line)),
  ];
  if (p.failures.length > 0) {
    body.push(block('Failing:', { weight: 'Bolder' }));
    for (const f of p.failures) body.push(block(`- ${f.path}: ${f.message}`));
  }
  if (p.muted) body.push(block(MUTED_NOTE, { isSubtle: true }));
  const actions =
    p.run === undefined ? {} : { actions: [{ type: 'Action.OpenUrl', title: 'Open the run', url: p.run.url }] };
  return {
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        content: {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          type: 'AdaptiveCard',
          version: '1.4',
          body,
          ...actions,
        },
      },
    ],
  };
}

/** The webhook's JSON: the payload itself, versioned, for a receiver to branch on. */
export function renderWebhook(p: AlertPayload): Record<string, unknown> {
  return { event: 'schedule.alert', version: 1, ...p };
}
