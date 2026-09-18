/**
 * The gRPC editor's top strip: the method the request calls, where the call goes, and Send.
 *
 * The **method** is a select over the services the API's `.proto` set declares, grouped by
 * service, because a gRPC request is only ever one of the methods the definition names — there is
 * no "custom" entry, as there is for an HTTP method. An API imported without a definition (or one
 * created empty) gets a pair of plain fields instead, so the request can still be pointed at a
 * `package.Service/Method` by hand.
 *
 * The **target** is not editable here: it belongs to the API, and an environment may override it.
 * The strip shows the address the call would actually go to, and where that came from, which only
 * main knows.
 */
import { Radio, Send, Square } from 'lucide-react';
import { Button } from '../../components/button.js';
import type { GrpcMethodDescriptorWire, GrpcServiceDescriptorWire } from '../../../shared/wire-types.js';
import { methodKindLabel } from './method-kind-badge.js';

/** The value the select carries for one method: `service/method`, the path's own spelling. */
export function methodOptionValue(method: Pick<GrpcMethodDescriptorWire, 'service' | 'name'>): string {
  return `${method.service}/${method.name}`;
}

/** The method a select value names, or `undefined` for the empty entry. */
export function findMethod(
  services: readonly GrpcServiceDescriptorWire[],
  value: string,
): GrpcMethodDescriptorWire | undefined {
  for (const service of services) {
    const found = service.methods.find((method) => methodOptionValue(method) === value);
    if (found !== undefined) return found;
  }
  return undefined;
}

export interface CallBarProps {
  readonly service: string;
  readonly method: string;
  /** The services the API's definition declares; `undefined` while loading, empty when it has none. */
  readonly services: readonly GrpcServiceDescriptorWire[] | undefined;
  /** The address the call resolves to, and where it came from. Absent while unknown. */
  readonly target?: string | undefined;
  readonly targetSource?: string | undefined;
  readonly tls: boolean;
  readonly sending: boolean;
  readonly onMethodChange: (method: GrpcMethodDescriptorWire) => void;
  /** For an API without a definition: the service and method typed by hand. */
  readonly onManualChange: (service: string, method: string) => void;
  readonly onSend: () => void;
  readonly onCancel: () => void;
  readonly sendShortcut?: string | undefined;
  /**
   * Opens the call and leaves its request side open, for a method whose client streams. Absent for
   * every other method: there is nothing to push into a unary or server-streaming call once it has
   * started, so only Send is offered.
   */
  readonly onOpenStream?: (() => void) | undefined;
}

const FIELD_CLASS =
  'h-row rounded-md border border-hairline-strong bg-surface-raised px-2 font-mono text-sm text-fg-default focus:ring-1 focus:ring-accent focus:outline-none';

/** The method, target and Send strip. */
export function CallBar({
  service,
  method,
  services,
  target,
  targetSource,
  tls,
  sending,
  onMethodChange,
  onManualChange,
  onSend,
  onCancel,
  sendShortcut,
  onOpenStream,
}: CallBarProps) {
  const current = service === '' && method === '' ? '' : `${service}/${method}`;
  const hasDefinition = services !== undefined && services.length > 0;
  const known = hasDefinition && findMethod(services, current) !== undefined;

  return (
    <div className="flex h-title-bar shrink-0 items-center gap-2 border-b border-hairline bg-surface-base px-3">
      {hasDefinition ? (
        <select
          aria-label="Method"
          data-testid="grpc-method"
          value={known ? current : ''}
          className={`${FIELD_CLASS} min-w-0 flex-1`}
          onChange={(event) => {
            const chosen = findMethod(services, event.target.value);
            if (chosen !== undefined) onMethodChange(chosen);
          }}
        >
          <option value="" disabled>
            {current === '' ? 'Choose a method…' : `${current} (not in the definition)`}
          </option>
          {services.map((svc) => (
            <optgroup key={svc.fullName} label={svc.fullName}>
              {svc.methods.map((candidate) => (
                <option key={candidate.name} value={methodOptionValue(candidate)}>
                  {`${candidate.name} — ${methodKindLabel(candidate.kind).toLowerCase()}${candidate.deprecated === true ? ' (deprecated)' : ''}`}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-1">
          <input
            aria-label="Service"
            data-testid="grpc-service"
            spellCheck={false}
            value={service}
            placeholder="package.Service"
            className={`${FIELD_CLASS} min-w-0 flex-1`}
            onChange={(event) => onManualChange(event.target.value.trim(), method)}
          />
          <span className="text-fg-subtle">/</span>
          <input
            aria-label="Method name"
            data-testid="grpc-method-name"
            spellCheck={false}
            value={method}
            placeholder="Method"
            className={`${FIELD_CLASS} w-40 min-w-0`}
            onChange={(event) => onManualChange(service, event.target.value.trim())}
          />
        </div>
      )}

      <span
        data-testid="grpc-target"
        title={targetSource === undefined ? undefined : `From the ${targetSource}`}
        className="max-w-[40%] shrink-0 truncate font-mono text-xs text-fg-subtle"
      >
        {target === undefined || target === ''
          ? 'No target — set one on the API'
          : `${tls ? 'grpcs' : 'grpc'}://${target}`}
      </span>

      {sending ? (
        <Button variant="secondary" data-testid="grpc-send" onClick={onCancel} title="Cancel (Esc)">
          <Square size={12} aria-hidden="true" />
          Cancel
        </Button>
      ) : (
        <>
          {onOpenStream !== undefined && (
            <Button
              variant="secondary"
              data-testid="grpc-open-stream"
              onClick={onOpenStream}
              title="Open the call and keep sending messages into it"
            >
              <Radio size={12} aria-hidden="true" />
              Open stream
            </Button>
          )}
          <Button
            variant="primary"
            data-testid="grpc-send"
            onClick={onSend}
            {...(sendShortcut !== undefined ? { title: `Send (${sendShortcut})` } : {})}
          >
            <Send size={12} aria-hidden="true" />
            Send
          </Button>
        </>
      )}
    </div>
  );
}
