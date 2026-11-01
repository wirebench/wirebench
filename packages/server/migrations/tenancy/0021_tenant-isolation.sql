-- Wirebench Server 0021: tenant isolation (hosted edition spec §19.3 rule 1, §19.4, §19.10). Forced row-level
-- security on the 36 scoped tables, so a query sees and writes only the rows of the tenant its unit set in
-- `wirebench.tenant_id`, whichever role runs it: `force` puts the owner under the policy too.
--
-- After this file:
-- - every `tenant_id` defaults to the setting, so an insert outside a tenant unit has a null tenant and fails
--   (and `with check` refuses it as well), where it used to land in the default tenant;
-- - every scoped table has `tenant_isolation`, from 0020's `tenant_scope()`;
-- - `for_each_tenant(sql)` runs one statement once per tenant, for the data migrations from 0022 on;
-- - only the owner may run either function;
-- - the `_0019` copies 0020 kept are gone: the policy makes `tenant_id` an equality in every query, so the
--   indexes led by it serve every lookup;
-- - the audit forward queue has a lease, so the forwarder holds no unit while a sink takes its time.
--
-- Catalog-only, like 0020: no row is rewritten, and no sealed audit row changes (0012's rule).

-- Rule 1 and the policy, table by table. A table someone forgot is caught by the migration test, not scoped by
-- accident.
do $tenancy$
declare
  t text;
begin
  for t in select unnest(array[
    'workspaces',
    'users', 'local_credentials', 'oidc_identities', 'invitations', 'device_tokens', 'oidc_flows', 'browser_flows',
    'teams', 'team_members', 'team_invitations', 'workspace_grants',
    'license',
    'ci_tokens',
    'catch_urls', 'captures',
    'schedules', 'schedule_runs', 'schedule_results', 'schedule_alert_outbox',
    'audit_events', 'audit_forward_queue', 'audit_chain_anchor',
    'saml_identities', 'saml_flows', 'scim_tokens', 'scim_users', 'scim_groups', 'scim_group_members',
    'provisioned_memberships',
    'session_logs', 'session_log_chunks',
    'agent_pairings', 'agent_pairing_codes', 'agent_nonces',
    'host_leases'
  ])
  loop
    execute format(
      'alter table %I alter column tenant_id set default nullif(current_setting(''wirebench.tenant_id'', true), '''')::uuid',
      t
    );
    perform tenant_scope(t::regclass);
  end loop;
end
$tenancy$;

-- Runs `sql` once in each tenant, with `wirebench.tenant_id` set to it, so a data migration's statement reaches
-- every tenant's rows under the forced policy (§19.4). The setting is the transaction's, as `withTenant` sets
-- it, and goes back to what it was afterwards. For migrations only: the app role may not call it, and
-- `check:tenant-scope` refuses it in the server's source.
--
-- The policy is only the filter for a role it holds. A migration role that bypasses it (a superuser, as the
-- default compose owner is, or a BYPASSRLS role) sees every tenant's rows on every pass, so `sql` must filter on
-- the setting itself: `where tenant_id = nullif(current_setting('wirebench.tenant_id', true), '')::uuid`. The
-- data-migration lint refuses a call without it (test/helpers/catalog.ts).
create function for_each_tenant(sql text) returns void language plpgsql as $each$
declare
  tenant uuid;
  previous text := current_setting('wirebench.tenant_id', true);
begin
  for tenant in select id from tenants order by id loop
    perform set_config('wirebench.tenant_id', tenant::text, true);
    execute sql;
  end loop;
  perform set_config('wirebench.tenant_id', coalesce(previous, ''), true);
end
$each$;

-- The forwarder's lease (issue #209): a claim stamps its rows with a lease id and an expiry on the database's clock,
-- in one short unit; the send runs outside any unit, and the delete names the lease. A row whose lease is live is
-- claimed by nobody else and kept by retention; one whose lease ran out is free again. Nullable, no default: a
-- catalog change only.
alter table audit_forward_queue add column lease_id text, add column leased_until timestamptz;

-- Functions are executable by public by default; these two are the owner's alone.
revoke execute on function for_each_tenant(text) from public;
revoke execute on function tenant_scope(regclass) from public;

-- The `_0019` copies (0020's header): a renamed unique constraint is dropped as a constraint, everything else as
-- an index. Only this schema's.
do $copies$
declare
  copy record;
begin
  for copy in
    select i.relname as index, t.relname as table, con.conname as constraint
      from pg_index x
      join pg_class i on i.oid = x.indexrelid
      join pg_class t on t.oid = x.indrelid
      left join pg_constraint con on con.conindid = i.oid and con.conrelid = t.oid
     where i.relnamespace = to_regnamespace(current_schema()) and i.relname like '%\_0019'
     order by i.relname
  loop
    if copy.constraint is not null then
      execute format('alter table %I drop constraint %I', copy.table, copy.constraint);
    else
      execute format('drop index %I', copy.index);
    end if;
  end loop;
end
$copies$;
