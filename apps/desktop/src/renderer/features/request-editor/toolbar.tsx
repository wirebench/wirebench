import { useState } from 'react';
import { Check, Code2, Columns2, PanelTop, Rows2, Send, Square, SquareSplitHorizontal } from 'lucide-react';
import { Button } from '../../components/button.js';
import { TrustInvalidBadge } from '../../components/trust-invalid-badge.js';
import type { RequestDraft } from '../../state/project.js';
import { useUiStore } from '../../state/ui.js';
import type { EndpointSourceWire, InterfaceSummary } from '../../../shared/wire-types.js';
import { EndpointSelect } from './endpoint-select.js';
import { EndpointsDialog } from './endpoints-dialog.js';
import { flipMode, flipOrientation, setEditorLayout, useEditorLayout } from './layout.js';

// The toolbar renders outside the shell's `TooltipProvider` in tests, so its icon controls are
// plain buttons with an accessible name and a native `title` rather than the tooltip-backed
// `IconButton`. Every icon-only control needs that `title`: an icon alone does not say what it does.
const ICON_BUTTON_CLASS =
  'inline-flex size-7 shrink-0 items-center justify-center rounded-md text-fg-subtle transition-colors hover:bg-surface-hover hover:text-fg-default';

export interface RequestToolbarProps {
  readonly draft: RequestDraft;
  readonly summary: InterfaceSummary | undefined;
  /** The URL the request resolves to today (see `selectRequestEndpoint`), if any. */
  readonly endpoint: string | undefined;
  /** Which rule chose {@link RequestToolbarProps.endpoint}; `environment` locks the field. */
  readonly endpointSource?: EndpointSourceWire;
  /** True when that endpoint has certificate verification turned off; shows the red badge. */
  readonly trustInvalid?: boolean;
  readonly sending: boolean;
  readonly onSend: () => void;
  readonly onCancel: () => void;
  readonly onEndpointChange: (endpoint: string) => void;
  /** The formatted `Mod+Enter` shortcut, shown on the Send button's title. */
  readonly sendShortcut?: string | undefined;
  readonly onValidate: () => void;
  /** The formatted `Mod+Shift+V` shortcut, shown on the Validate button's title. */
  readonly validateShortcut?: string | undefined;
  /** The formatted `editor.toggleLayoutMode` shortcut, shown on the split/tabs button's title. */
  readonly layoutModeShortcut?: string | undefined;
}

/**
 * The request editor's top strip: send/cancel, the endpoint, and the view toggles. The endpoint
 * is the only thing allowed to grow — everything that used to compete with it for width
 * (Recreate, cURL, Clone) now lives in the pane's context menu and the Details panel's Code tab.
 */
export function RequestToolbar({
  draft,
  summary,
  endpoint,
  endpointSource,
  trustInvalid = false,
  sending,
  onSend,
  onCancel,
  onEndpointChange,
  sendShortcut,
  onValidate,
  validateShortcut,
  layoutModeShortcut,
}: RequestToolbarProps) {
  const layout = useEditorLayout(draft.id);
  const openCode = useUiStore((state) => state.openCode);
  const [endpointsOpen, setEndpointsOpen] = useState(false);
  const orientationLabel =
    layout.orientation === 'side-by-side' ? 'Stack panes vertically' : 'Place panes side by side';
  const modeLabel = layout.mode === 'split' ? 'Show one pane at a time' : 'Show both panes';

  const soapAction = draft.soapAction !== undefined && draft.soapAction.length > 0 ? draft.soapAction : 'no SOAPAction';

  return (
    <div className="flex h-title-bar shrink-0 items-center gap-2 border-b border-hairline bg-surface-base px-3">
      {sending ? (
        <Button variant="secondary" onClick={onCancel} title="Cancel (Esc)">
          <Square size={12} aria-hidden="true" />
          Cancel
        </Button>
      ) : (
        <Button
          data-testid="request-send"
          variant="primary"
          onClick={onSend}
          disabled={endpoint === undefined || endpoint.length === 0}
          {...(sendShortcut !== undefined ? { title: `Send (${sendShortcut})` } : {})}
        >
          <Send size={12} aria-hidden="true" />
          Send
        </Button>
      )}

      {endpointSource === 'environment' || endpointSource === 'workspace-environment' ? (
        // The active environment overrides this interface's address, so the request's own
        // endpoint is not what will be used; show what will be, and where it came from. A
        // workspace environment and a project one are the same fact to the user.
        <div className="flex min-w-[16rem] flex-1 items-center gap-2">
          <span
            data-testid="endpoint-env-badge"
            title="Overridden by the active environment"
            className="shrink-0 rounded-sm bg-accent-muted px-1 text-xs text-fg-default"
          >
            env
          </span>
          <input
            readOnly
            aria-label="Endpoint (from the active environment)"
            data-testid="request-endpoint"
            value={endpoint ?? ''}
            className="h-row min-w-0 flex-1 rounded-md border border-hairline bg-surface-sunken px-2 font-mono text-sm text-fg-muted"
          />
        </div>
      ) : (
        <EndpointSelect
          summary={summary}
          bindingName={draft.bindingName}
          value={endpoint}
          onChange={onEndpointChange}
          onEditEndpoints={() => setEndpointsOpen(true)}
        />
      )}

      {trustInvalid && <TrustInvalidBadge testId="toolbar-trust-invalid" />}

      <button
        type="button"
        aria-label="Validate request"
        data-testid="request-validate"
        className={ICON_BUTTON_CLASS}
        title={validateShortcut === undefined ? 'Validate request' : `Validate request (${validateShortcut})`}
        onClick={onValidate}
      >
        <Check size={14} aria-hidden="true" />
      </button>

      <button
        type="button"
        aria-label="Show code"
        data-testid="request-code"
        title="Show code"
        className={ICON_BUTTON_CLASS}
        onClick={() => {
          openCode();
        }}
      >
        <Code2 size={14} aria-hidden="true" />
      </button>

      <button
        type="button"
        aria-label={orientationLabel}
        data-testid="layout-orientation"
        title={orientationLabel}
        className={ICON_BUTTON_CLASS}
        onClick={() => setEditorLayout(draft.id, flipOrientation)}
      >
        {layout.orientation === 'side-by-side' ? (
          <Columns2 size={14} aria-hidden="true" />
        ) : (
          <Rows2 size={14} aria-hidden="true" />
        )}
      </button>
      <button
        type="button"
        aria-label={modeLabel}
        data-testid="layout-mode"
        title={layoutModeShortcut === undefined ? modeLabel : `${modeLabel} (${layoutModeShortcut})`}
        className={ICON_BUTTON_CLASS}
        onClick={() => setEditorLayout(draft.id, flipMode)}
      >
        {/* Draws the layout you are in, like the orientation button: two panes, or one under tabs. */}
        {layout.mode === 'split' ? (
          <SquareSplitHorizontal size={14} aria-hidden="true" />
        ) : (
          <PanelTop size={14} aria-hidden="true" />
        )}
      </button>

      {/* The operation is context, not a control: it yields its width to the endpoint. */}
      <div
        data-testid="request-operation"
        title={`${draft.operationName} · SOAPAction: ${soapAction}`}
        className="flex max-w-[16rem] min-w-0 items-center gap-2 text-sm"
      >
        <span className="truncate font-mono text-fg-default">{draft.operationName}</span>
        <span className="shrink-0 rounded-sm border border-hairline px-1 text-xs text-fg-muted">
          SOAP {draft.soapVersion}
        </span>
      </div>

      <EndpointsDialog open={endpointsOpen} onOpenChange={setEndpointsOpen} interfaceId={draft.interfaceId} />
    </div>
  );
}
