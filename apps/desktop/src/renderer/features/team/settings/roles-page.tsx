/**
 * Team settings › What roles can do (settings split spec §3.4): a read-only table built from `roles.ts`, so the
 * table and the renderer's own checks share one source.
 */
import { Check } from 'lucide-react';
import { ABILITY_LABELS, ROLE_LABELS, WORKSPACE_ABILITIES, WORKSPACE_ROLES, roleCan } from '../roles.js';

export function RolesPage() {
  return (
    <div data-testid="roles-page" className="flex flex-col gap-4">
      <table data-testid="roles-table" className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-hairline text-left text-xs text-fg-subtle">
            <th scope="col" className="py-2 font-medium">
              In a workspace
            </th>
            {WORKSPACE_ROLES.map((role) => (
              <th key={role} scope="col" className="w-24 py-2 text-center font-medium">
                {ROLE_LABELS[role]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {WORKSPACE_ABILITIES.map((ability) => (
            <tr key={ability} data-ability={ability} className="border-b border-hairline">
              <th scope="row" className="py-2 text-left font-normal text-fg-default">
                {ABILITY_LABELS[ability]}
              </th>
              {WORKSPACE_ROLES.map((role) => {
                const allowed = roleCan(role, ability);
                return (
                  <td
                    key={role}
                    data-testid={`roles-cell-${ability}-${role}`}
                    data-allowed={allowed ? 'true' : 'false'}
                    className="py-2 text-center"
                  >
                    {allowed ? (
                      <Check size={14} aria-label="Yes" className="inline text-status-success" />
                    ) : (
                      <span className="text-fg-faint" aria-label="No">
                        –
                      </span>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-sm text-fg-muted">Manage people: team admins.</p>
      <p className="text-sm text-fg-muted">Server admins are Admin on every workspace and manage every team.</p>
    </div>
  );
}
