/**
 * The *Server* page of Settings (hosted edition spec §22.13): the connected server's own settings, for its server
 * admins. Each nav entry is one page; a hosted team edits its sections here, a self-hosted server shows them
 * read-only from its environment, and only a hosted team has Billing and Delete team.
 */
import type { ReactNode } from 'react';
import { AuditForwardingSection } from './audit-forwarding-section.js';
import { BillingSection } from './billing-section.js';
import { DeleteTeamSection, DeletionBanner } from './delete-team-section.js';
import { EmailSection } from './email-section.js';
import { ExportSection } from './export-section.js';
import { ProvisioningSection } from './provisioning-section.js';
import { RetentionSection } from './retention-section.js';
import { isHosted, serverLabel, useServerSettingsStore, type ServerPageId } from './server-settings-store.js';
import { SignInSection } from './sign-in-section.js';

export const SERVER_PAGE_LABELS: Readonly<Record<ServerPageId, string>> = {
  'sign-in': 'Sign-in',
  provisioning: 'Provisioning',
  'audit-forwarding': 'Audit forwarding',
  email: 'Email',
  retention: 'Retention',
  billing: 'Billing',
  export: 'Export',
  delete: 'Delete team',
};

function subtitle(page: ServerPageId, team: string, hosted: boolean): string {
  switch (page) {
    case 'sign-in':
      return hosted
        ? `How people sign in to ${team}. Local passwords always work for server admins. Changes apply to the next sign-in.`
        : 'Read-only here: a self-hosted server takes these from its environment. Change them in the server’s environment and restart it.';
    case 'provisioning':
      return 'Tokens an identity provider uses to create, update and remove people and groups.';
    case 'audit-forwarding':
      return hosted
        ? 'Send every audit event to your own collector as well.'
        : 'Read-only here: set by the server’s environment.';
    case 'email':
      return hosted
        ? 'The mail server the team’s mail goes out through.'
        : 'Read-only here: set by the server’s environment.';
    case 'retention':
      return hosted ? 'How long the team’s records are kept.' : 'Read-only here: set by the server’s environment.';
    case 'billing':
      return 'The team’s plan and subscription.';
    case 'export':
      return 'A copy of the whole team, to keep or to move to another server.';
    case 'delete':
      return `Delete ${team} and everything in it.`;
  }
}

function body(page: ServerPageId): ReactNode {
  switch (page) {
    case 'sign-in':
      return <SignInSection />;
    case 'provisioning':
      return <ProvisioningSection />;
    case 'audit-forwarding':
      return <AuditForwardingSection />;
    case 'email':
      return <EmailSection />;
    case 'retention':
      return <RetentionSection />;
    case 'billing':
      return <BillingSection />;
    case 'export':
      return <ExportSection />;
    case 'delete':
      return <DeleteTeamSection />;
  }
}

export function ServerPage({ page }: { readonly page: ServerPageId }) {
  const url = useServerSettingsStore((s) => s.url) ?? '';
  const hosted = useServerSettingsStore((s) => isHosted(s.settings));
  const team = serverLabel(url, hosted);
  return (
    <div data-testid={`server-page-${page}`}>
      <h1 className="mb-1.5 text-[22px] leading-tight font-semibold text-fg-default">{SERVER_PAGE_LABELS[page]}</h1>
      <p className="mb-6 text-sm text-fg-subtle">{subtitle(page, team, hosted)}</p>
      {hosted && page !== 'delete' && <DeletionBanner />}
      {body(page)}
    </div>
  );
}
