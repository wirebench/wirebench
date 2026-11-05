/**
 * Server › Retention (hosted edition spec §22.12): how long the tenant keeps its audit events, captured callbacks,
 * schedule runs and session logs. Each is at most the operator's maximum, which the server enforces; a field left
 * empty takes the operator's value.
 */
import {
  CardError,
  Chip,
  EnvironmentCard,
  FieldGrid,
  FieldLabel,
  INPUT,
  SaveFooter,
  ServerCard,
  fieldText,
} from './server-card.js';
import { compact, useSection, wholeNumber } from './use-section.js';

interface Field {
  readonly key: 'auditMaxAgeDays' | 'hooksMaxAgeDays' | 'hooksKeep' | 'schedulesMaxAgeDays' | 'sessionLogMaxMb';
  readonly label: string;
  readonly unit: string;
  readonly variable: string;
  readonly max: number;
}

const FIELDS: readonly Field[] = [
  {
    key: 'auditMaxAgeDays',
    label: 'Audit events',
    unit: 'days',
    variable: 'WIREBENCH_SERVER_AUDIT_MAX_AGE_DAYS',
    max: 3650,
  },
  {
    key: 'hooksMaxAgeDays',
    label: 'Captured callbacks',
    unit: 'days',
    variable: 'WIREBENCH_SERVER_HOOKS_MAX_AGE_DAYS',
    max: 365,
  },
  {
    key: 'hooksKeep',
    label: 'Callbacks kept per URL',
    unit: 'captures',
    variable: 'WIREBENCH_SERVER_HOOKS_KEEP',
    max: 10_000,
  },
  {
    key: 'schedulesMaxAgeDays',
    label: 'Schedule runs',
    unit: 'days',
    variable: 'WIREBENCH_SERVER_SCHEDULES_MAX_AGE_DAYS',
    max: 3650,
  },
  {
    key: 'sessionLogMaxMb',
    label: 'Session logs',
    unit: 'MB',
    variable: 'WIREBENCH_SERVER_SESSION_LOG_MAX_MB',
    max: 1024,
  },
];

type RetentionDraft = Readonly<Record<Field['key'], string>>;

const retentionDraft = (value: Readonly<Record<string, unknown>> | null): RetentionDraft =>
  Object.fromEntries(FIELDS.map((field) => [field.key, fieldText(value, field.key) ?? ''])) as RetentionDraft;

export function RetentionSection() {
  const card = useSection('retention', 'Retention', retentionDraft);
  const { draft, value } = card;
  if (card.state?.source === 'environment') {
    return (
      <EnvironmentCard
        title="Retention"
        testId="server-retention"
        set={value !== null}
        rows={FIELDS.map((field) => {
          const text = fieldText(value, field.key);
          return {
            label: field.label,
            variable: field.variable,
            value: text === undefined ? undefined : `${text} ${field.unit}`,
          };
        })}
      />
    );
  }
  const save = (): void => {
    const numbers = FIELDS.map((field) => [field, wholeNumber(draft[field.key])] as const);
    const bad = numbers.find(([field, n]) => n !== undefined && (Number.isNaN(n) || n < 1 || n > field.max));
    void card.save(
      compact(Object.fromEntries(numbers.map(([field, n]) => [field.key, n]))),
      bad === undefined
        ? undefined
        : `${bad[0].label} is a whole number from 1 to ${bad[0].max.toLocaleString()} ${bad[0].unit}.`,
    );
  };
  return (
    <div data-testid="server-retention-page">
      <ServerCard
        title="Retention"
        testId="server-retention"
        chip={<Chip testId="server-retention-state">{value === null ? 'The operator’s defaults' : 'Your own'}</Chip>}
        footer={
          <SaveFooter
            testId="server-retention"
            busy={card.busy}
            canRemove={value !== null}
            onRemove={() => void card.remove()}
            onSave={save}
          />
        }
      >
        <p className="mb-4 text-sm text-fg-subtle">
          Older records are removed by the nightly sweep. Each value is held to the service’s maximum; leave one empty
          for the service’s default.
        </p>
        <FieldGrid>
          {FIELDS.map((field) => (
            <RetentionRow
              key={field.key}
              field={field}
              value={draft[field.key]}
              onChange={(text) => card.setDraft({ [field.key]: text })}
            />
          ))}
        </FieldGrid>
        <CardError error={card.error} testId="server-retention-error" />
      </ServerCard>
    </div>
  );
}

function RetentionRow({
  field,
  value,
  onChange,
}: {
  readonly field: Field;
  readonly value: string;
  readonly onChange: (text: string) => void;
}) {
  const id = `server-retention-${field.key}`;
  return (
    <>
      <FieldLabel htmlFor={id}>{field.label}</FieldLabel>
      <div className="flex items-center gap-2">
        <input
          id={id}
          data-testid={id}
          inputMode="numeric"
          value={value}
          placeholder="Default"
          onChange={(event) => onChange(event.target.value)}
          className={`${INPUT} max-w-32`}
        />
        <span className="text-xs text-fg-subtle">{field.unit}</span>
      </div>
    </>
  );
}
