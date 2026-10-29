/**
 * The small *Server* or *Agent* tag on a History entry that says which host sent it (hosted edition spec
 * §18.4). Only an entry with `sentFrom` gets one: the desktop writes none, so its History looks as before.
 */
export function SentFromTag({ sentFrom }: { readonly sentFrom: 'server' | 'agent' | undefined }) {
  if (sentFrom === undefined) return null;
  return (
    <span
      data-testid="history-origin"
      data-origin={sentFrom}
      title={sentFrom === 'agent' ? 'Sent from your machine, through the paired agent' : 'Sent from the server'}
      className="shrink-0 rounded-sm border border-hairline px-1 text-2xs text-fg-subtle"
    >
      {sentFrom === 'agent' ? 'Agent' : 'Server'}
    </span>
  );
}
