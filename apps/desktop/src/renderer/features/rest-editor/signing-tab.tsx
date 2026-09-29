/**
 * A webhook item's **Signing** tab (webhook-signatures §5.2); ordinary REST requests have none.
 *
 * Every change is staged like the other tabs' edits. A secret typed into the field but not saved on
 * its own would otherwise be lost to a Send or a save made meanwhile, so the tab registers a flush
 * with the send and save actions (`registerScriptEditFlush`) that stores it and stages its ref first.
 */
import { useCallback, useEffect, useRef } from 'react';
import { registerScriptEditFlush } from '../../state/script-edits.js';
import { SigningFields } from '../webhook-items/signing-fields.js';
import { signingSummary } from '../webhook-items/signing.js';
import type { InheritedSigning } from '../webhook-items/signing.js';
import type { RestRequestPatchWire, RestRequestWire } from '../../../shared/wire-types.js';

export function SigningTab({
  request,
  inherited,
  onChange,
}: {
  readonly request: RestRequestWire;
  readonly inherited: InheritedSigning;
  readonly onChange: (patch: RestRequestPatchWire) => void;
}) {
  const secretFlush = useRef<(() => Promise<string | undefined>) | undefined>(undefined);
  const registerSecretFlush = useCallback((flush: (() => Promise<string | undefined>) | undefined) => {
    secretFlush.current = flush;
  }, []);
  useEffect(
    () =>
      registerScriptEditFlush(async () => {
        await secretFlush.current?.();
      }),
    [],
  );

  return (
    <div data-testid="rest-signing" className="overflow-auto p-3">
      {request.signing === undefined && (
        <p data-testid="rest-signing-source" className="text-sm text-fg-subtle">
          {signingSummary(inherited)}
        </p>
      )}
      <SigningFields
        value={request.signing}
        inherit
        nodeName={request.name}
        registerFlush={registerSecretFlush}
        onChange={(signing) => onChange({ signing: signing ?? null })}
      />
    </div>
  );
}
