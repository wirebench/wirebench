import { describe, expect, it } from 'vitest';
import {
  renderEmail,
  renderSlack,
  renderTeams,
  renderWebhook,
  type AlertPayload,
} from '../../../src/schedules/alerts/render.js';

const failure: AlertPayload = {
  kind: 'failure',
  streak: 1,
  muted: false,
  schedule: { id: 'S1', name: 'Nightly <smoke>' },
  workspace: { id: 'W1', name: 'Payments & Co' },
  project: 'Billing',
  environment: 'prod',
  run: {
    id: 'R1',
    status: 'failed',
    reason: null,
    commit: 'abcdef0123456789abcdef0123456789abcdef01',
    total: 10,
    failed: 2,
    errored: 1,
    durationMs: 3240,
    url: 'https://wirebench.example.test/api/v1/workspaces/W1/schedules/S1/runs/R1',
  },
  failures: [
    { path: 'Api/Login', message: 'Expected status 200, got 500' },
    { path: 'Api/Orders', message: 'Expected $.total to equal 3' },
  ],
};
const muted: AlertPayload = { ...failure, streak: 3, muted: true };
const recovery: AlertPayload = {
  ...failure,
  kind: 'recovery',
  streak: 4,
  run: { ...failure.run!, status: 'passed', failed: 0, errored: 0 },
  failures: [],
};

describe('alert rendering (scheduled-runs spec §3.4)', () => {
  it('email: a subject that says what happened, a text part and an escaped HTML part', () => {
    const email = renderEmail(failure);
    expect(email.subject).toBe('[Wirebench] Failing: Nightly <smoke> (Billing, prod)');
    expect(email.text).toMatchInlineSnapshot(`
      "Nightly <smoke> failed in workspace Payments & Co.
      Project: Billing · Environment: prod
      Outcome: failed: 2 of 10 failed, 1 errored, in 3.2 s
      Commit: abcdef012345

      Failing:
        - Api/Login: Expected status 200, got 500
        - Api/Orders: Expected $.total to equal 3

      Run: https://wirebench.example.test/api/v1/workspaces/W1/schedules/S1/runs/R1
      "
    `);
    expect(email.html).toMatchInlineSnapshot(`
      "<!doctype html><html><body style="font-family: sans-serif">
      <p>Nightly &lt;smoke&gt; failed in workspace Payments &amp; Co.</p>
      <p>Project: Billing · Environment: prod</p>
      <p>Outcome: failed: 2 of 10 failed, 1 errored, in 3.2 s</p>
      <p>Commit: abcdef012345</p>
      <p>Failing:</p><ul>
      <li><code>Api/Login</code>: Expected status 200, got 500</li>
      <li><code>Api/Orders</code>: Expected $.total to equal 3</li>
      </ul>
      <p><a href="https://wirebench.example.test/api/v1/workspaces/W1/schedules/S1/runs/R1">Open the run</a></p>
      </body></html>
      "
    `);
    expect(email.html).not.toContain('<smoke>');
  });

  it('email: the muted notice on the last alert, and a recovery naming the streak it ended', () => {
    expect(renderEmail(muted).text).toContain('failed again in workspace Payments & Co (3 runs in a row).');
    expect(renderEmail(muted).text).toContain('Further failures are muted until it passes again.');
    const recovered = renderEmail(recovery);
    expect(recovered.subject).toBe('[Wirebench] Recovered: Nightly <smoke> (Billing, prod)');
    expect(recovered.text).toMatchInlineSnapshot(`
      "Nightly <smoke> passed again in workspace Payments & Co, after 4 failed runs.
      Project: Billing · Environment: prod
      Outcome: passed: 0 of 10 failed, in 3.2 s
      Commit: abcdef012345

      Run: https://wirebench.example.test/api/v1/workspaces/W1/schedules/S1/runs/R1
      "
    `);
  });

  it('a run that stopped before sending says why, and a test alert has no run', () => {
    const stopped = renderEmail({
      ...failure,
      run: { ...failure.run!, status: 'errored', reason: 'target-missing', total: 0, failed: 0, errored: 0 },
      failures: [],
    });
    expect(stopped.text).toContain('Outcome: errored (target-missing)\n');
    const { run, ...withoutRun } = failure;
    expect(run).toBeDefined();
    const test = renderEmail({ ...withoutRun, kind: 'test', failures: [] });
    expect(test.subject).toBe('[Wirebench] Test alert: Nightly <smoke> (Billing, prod)');
    expect(test.text).not.toContain('Run:');
  });

  it('Slack: header, escaped mrkdwn, failing requests, the run link and the muted context', () => {
    expect(renderSlack(muted)).toMatchInlineSnapshot(`
      {
        "blocks": [
          {
            "text": {
              "text": "Failing: Nightly <smoke> (Billing, prod)",
              "type": "plain_text",
            },
            "type": "header",
          },
          {
            "text": {
              "text": "Nightly &lt;smoke&gt; failed again in workspace Payments &amp; Co (3 runs in a row).
      Project: Billing · Environment: prod
      Outcome: failed: 2 of 10 failed, 1 errored, in 3.2 s
      Commit: abcdef012345",
              "type": "mrkdwn",
            },
            "type": "section",
          },
          {
            "text": {
              "text": "*Failing:*
      • \`Api/Login\`: Expected status 200, got 500
      • \`Api/Orders\`: Expected $.total to equal 3",
              "type": "mrkdwn",
            },
            "type": "section",
          },
          {
            "text": {
              "text": "<https://wirebench.example.test/api/v1/workspaces/W1/schedules/S1/runs/R1|Open the run>",
              "type": "mrkdwn",
            },
            "type": "section",
          },
          {
            "elements": [
              {
                "text": "Further failures are muted until it passes again.",
                "type": "mrkdwn",
              },
            ],
            "type": "context",
          },
        ],
        "text": "Failing: Nightly &lt;smoke&gt; (Billing, prod)",
      }
    `);
  });

  it('Slack: a long name is clipped in the header, which Slack caps at 150 characters', () => {
    const long = renderSlack({ ...failure, schedule: { id: 'S1', name: 'x'.repeat(200) } });
    const header = (long.blocks as { text: { text: string } }[])[0]!.text.text;
    expect(header).toHaveLength(150);
    expect(header.endsWith('…')).toBe(true);
  });

  it('Teams: an Adaptive Card with an action that opens the run', () => {
    expect(renderTeams(failure)).toMatchInlineSnapshot(`
      {
        "attachments": [
          {
            "content": {
              "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
              "actions": [
                {
                  "title": "Open the run",
                  "type": "Action.OpenUrl",
                  "url": "https://wirebench.example.test/api/v1/workspaces/W1/schedules/S1/runs/R1",
                },
              ],
              "body": [
                {
                  "size": "Medium",
                  "text": "Failing: Nightly <smoke> (Billing, prod)",
                  "type": "TextBlock",
                  "weight": "Bolder",
                  "wrap": true,
                },
                {
                  "text": "Nightly <smoke> failed in workspace Payments & Co.",
                  "type": "TextBlock",
                  "wrap": true,
                },
                {
                  "text": "Project: Billing · Environment: prod",
                  "type": "TextBlock",
                  "wrap": true,
                },
                {
                  "text": "Outcome: failed: 2 of 10 failed, 1 errored, in 3.2 s",
                  "type": "TextBlock",
                  "wrap": true,
                },
                {
                  "text": "Commit: abcdef012345",
                  "type": "TextBlock",
                  "wrap": true,
                },
                {
                  "text": "Failing:",
                  "type": "TextBlock",
                  "weight": "Bolder",
                  "wrap": true,
                },
                {
                  "text": "- Api/Login: Expected status 200, got 500",
                  "type": "TextBlock",
                  "wrap": true,
                },
                {
                  "text": "- Api/Orders: Expected $.total to equal 3",
                  "type": "TextBlock",
                  "wrap": true,
                },
              ],
              "type": "AdaptiveCard",
              "version": "1.4",
            },
            "contentType": "application/vnd.microsoft.card.adaptive",
          },
        ],
        "type": "message",
      }
    `);
  });

  it('webhook: the payload itself, versioned', () => {
    expect(renderWebhook(recovery)).toEqual({ event: 'schedule.alert', version: 1, ...recovery });
  });
});
