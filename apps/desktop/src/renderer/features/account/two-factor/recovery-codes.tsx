import { useEffect, useState } from 'react';
import { Button } from '../../../components/button.js';
import { showToast } from '../../../components/toast.js';

/** The file *Download as text* saves (two-step sign-in spec §5.3). */
export const RECOVERY_CODES_FILE = 'wirebench-recovery-codes.txt';

/**
 * The recovery codes, shown once (two-step sign-in spec §5.3): a grid of ten, *Copy all*, *Download as text* and
 * *I've saved them*, which is the only way on. The codes live in the caller's state and nowhere else; the server keeps
 * only their hashes and never answers them again.
 */
export function RecoveryCodes(props: {
  readonly codes: readonly string[];
  readonly server: string;
  readonly onSaved: () => void;
}) {
  const [href, setHref] = useState<string | undefined>(undefined);
  const text = `Wirebench recovery codes for ${props.server}\nEach code works once.\n\n${props.codes.join('\n')}\n`;

  useEffect(() => {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    setHref(url);
    return () => {
      URL.revokeObjectURL(url);
    };
  }, [text]);

  const copy = (): void => {
    void navigator.clipboard.writeText(props.codes.join('\n')).then(
      () => showToast('Recovery codes copied'),
      () => showToast('Could not copy the codes'),
    );
  };

  return (
    <div data-testid="recovery-codes">
      <p className="mt-3 text-sm text-fg-default">Save these recovery codes somewhere safe.</p>
      <p className="mt-1 text-xs text-fg-subtle">
        Each code signs you in once if you lose your authenticator or passkey. They will not be shown again.
      </p>
      <ol
        data-testid="recovery-codes-list"
        className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 rounded border border-hairline bg-surface-base p-3 font-mono text-sm text-fg-default"
      >
        {props.codes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ol>
      <div className="mt-3 flex items-center justify-between">
        <div className="flex gap-2">
          <Button data-testid="recovery-codes-copy" onClick={copy}>
            Copy all
          </Button>
          {href !== undefined && (
            <a
              data-testid="recovery-codes-download"
              href={href}
              download={RECOVERY_CODES_FILE}
              className="inline-flex items-center rounded border border-hairline-strong px-3 py-1 text-sm text-fg-default hover:bg-surface-hover"
            >
              Download as text
            </a>
          )}
        </div>
        <Button variant="primary" data-testid="recovery-codes-saved" onClick={props.onSaved}>
          I’ve saved them
        </Button>
      </div>
    </div>
  );
}
