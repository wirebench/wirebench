/**
 * The entry's message (hosted edition spec §21.4): plain text, so a tenant's name, which its admin writes, carries no
 * markup into it; links only, so it signs nobody in. Sent through the server's SMTP settings, as email alerts are.
 */
export interface EntryMail {
  readonly subject: string;
  readonly text: string;
}

export interface EntryMailInput {
  /** Each matching team: its name and `https://<slug>.<app-domain>`. */
  readonly teams: readonly { readonly name: string; readonly url: string }[];
  /** `app.<app-domain>`. */
  readonly entryHost: string;
  /** `https://<site-domain>/`. */
  readonly siteUrl: string;
}

/** Folds control characters and line breaks out of a name, so it stays one line of the list. */
function oneLine(name: string): string {
  return name.replace(/[\p{Cc}\u2028\u2029]+/gu, ' ').trim();
}

export function renderEntryMail(input: EntryMailInput): EntryMail {
  const lines = input.teams.map((team) => `${oneLine(team.name)}\n  ${team.url}/sign-in`);
  return {
    subject: 'Your Wirebench teams',
    text: [
      input.teams.length === 1 ? 'Your Wirebench team:' : 'Your Wirebench teams:',
      '',
      lines.join('\n\n'),
      '',
      `About Wirebench: ${input.siteUrl}`,
      '',
      `You asked for this at ${input.entryHost}. If you did not, ignore it: nothing has changed.`,
      '',
    ].join('\n'),
  };
}
