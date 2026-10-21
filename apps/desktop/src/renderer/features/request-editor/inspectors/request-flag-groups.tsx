/**
 * The request properties that belong to another tab than Properties (#732 X08): the attachment and MTOM
 * flags sit under Attachments, and the WS-Security defaults under the WSS picker on Auth, so each is
 * found where it acts.
 */

import { BooleanSetting, EnumSetting, NumberSetting, SettingsGroup } from '../../../components/settings-grid.js';
import { useProjectStore } from '../../../state/project.js';

/**
 * One line per attachment flag, the hint on each row's label: the flags interact (Force MTOM only
 * means anything with MTOM enabled, Disable multiparts overrides both) and the label alone does not
 * say which way.
 */
export const ATTACHMENT_HINTS = {
  enableMtom: 'Send attachments as MTOM/XOP parts instead of SwA parts.',
  forceMtom: 'Use an XOP part even for a single inline value; only applies when MTOM is enabled.',
  inlineResponseAttachments: 'Inline response attachments into the envelope instead of listing them as parts.',
  expandMtomAttachments: 'Replace incoming xop:Include references with the referenced bytes when showing the response.',
  disableMultiparts: 'Never send a multipart body: attachments are dropped and the envelope goes on its own.',
  encodeAttachments: 'Base64-encode outgoing attachment content instead of sending it as raw bytes.',
  enableInlineFiles: 'Expand `cid:` and file references found in the envelope from the attached files.',
} as const;

/** The attachment and MTOM flags, shown under the Attachments tab's list. */
export function AttachmentFlagsGroup({ requestId }: { readonly requestId: string }) {
  const properties = useProjectStore((state) => state.requests[requestId]?.properties);
  const updateRequestProperties = useProjectStore((state) => state.updateRequestProperties);
  if (properties === undefined) return null;
  const set = (key: keyof typeof ATTACHMENT_HINTS) => (value: boolean) => {
    updateRequestProperties(requestId, { [key]: value });
  };
  return (
    <div data-testid="attachment-flags">
      <SettingsGroup title="Sending attachments">
        <BooleanSetting
          label="Enable MTOM"
          hint={ATTACHMENT_HINTS.enableMtom}
          value={properties.enableMtom}
          onChange={set('enableMtom')}
        />
        <BooleanSetting
          label="Force MTOM"
          hint={ATTACHMENT_HINTS.forceMtom}
          value={properties.forceMtom}
          onChange={set('forceMtom')}
        />
        <BooleanSetting
          label="Inline response attachments"
          hint={ATTACHMENT_HINTS.inlineResponseAttachments}
          value={properties.inlineResponseAttachments}
          onChange={set('inlineResponseAttachments')}
        />
        <BooleanSetting
          label="Expand MTOM attachments"
          hint={ATTACHMENT_HINTS.expandMtomAttachments}
          value={properties.expandMtomAttachments}
          onChange={set('expandMtomAttachments')}
        />
        <BooleanSetting
          label="Disable multiparts"
          hint={ATTACHMENT_HINTS.disableMultiparts}
          value={properties.disableMultiparts}
          onChange={set('disableMultiparts')}
        />
        <BooleanSetting
          label="Encode attachments"
          hint={ATTACHMENT_HINTS.encodeAttachments}
          value={properties.encodeAttachments}
          onChange={set('encodeAttachments')}
        />
        <BooleanSetting
          label="Enable inline files"
          hint={ATTACHMENT_HINTS.enableInlineFiles}
          value={properties.enableInlineFiles}
          onChange={set('enableInlineFiles')}
        />
      </SettingsGroup>
    </div>
  );
}

/** The request's WS-Security defaults, shown under the WSS picker on Auth. */
export function WssDefaultsGroup({ requestId }: { readonly requestId: string }) {
  const properties = useProjectStore((state) => state.requests[requestId]?.properties);
  const updateRequestProperties = useProjectStore((state) => state.updateRequestProperties);
  if (properties === undefined) return null;
  return (
    <div data-testid="wss-request-defaults">
      <SettingsGroup title="WS-Security defaults for this request">
        <EnumSetting
          label="WSS password type"
          hint="How this request's username token sends its password: as text, or as a digest."
          value={properties.wssPasswordType ?? ''}
          options={[
            { value: '', label: 'None' },
            { value: 'text', label: 'PasswordText' },
            { value: 'digest', label: 'PasswordDigest' },
          ]}
          onChange={(value) =>
            updateRequestProperties(requestId, {
              wssPasswordType: value === 'text' || value === 'digest' ? value : null,
            })
          }
        />
        <NumberSetting
          label="WSS time to live (s)"
          hint="How long, in seconds, this request's WS-Security timestamp stays valid; empty sets none."
          value={properties.wssTimeToLive}
          min={0}
          placeholder="none"
          onCommit={(wssTimeToLive) => updateRequestProperties(requestId, { wssTimeToLive: wssTimeToLive ?? null })}
        />
      </SettingsGroup>
    </div>
  );
}
