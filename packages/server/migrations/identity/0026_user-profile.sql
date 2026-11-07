-- Wirebench Server 0026: the user profile (user profile spec §6.1). A username, an about text, and a photo and a
-- cover image per person.
--
-- - `users.username` is what the person typed; `username_lower` is what sign-in and the unique key compare. Both are
--   null until the person sets one. `users_username_lower_key` is mapped by name to `identity-username-taken`, and
--   leads with `tenant_id`, so two tenants may share a username. Unique keys skip nulls, so any number of people
--   may have none. The check uses `is not distinct from`, so a username without its lower-case twin is refused too.
-- - `user_images` is scoped as 0021 scopes its tables: `tenant_id` defaulting to the setting, first in the primary
--   key, then `tenant_scope()`, which forces row-level security under the one `tenant_isolation` policy. A user's
--   images go with the user.
--
-- New nullable columns, a constant default and a new table: no row is rewritten.

alter table users
  add column username text,
  add column username_lower text,
  add column about text not null default '',
  add constraint users_username_lower_check check (username_lower is not distinct from lower(username)),
  add constraint users_username_lower_key unique (tenant_id, username_lower);

create table user_images (
  tenant_id     uuid not null default nullif(current_setting('wirebench.tenant_id', true), '')::uuid
                  references tenants (id),
  user_id       text not null,
  kind          text not null,
  content_type  text not null,
  data          bytea not null,
  sha256        text not null,
  updated_at    timestamptz not null default now(),
  constraint user_images_pkey primary key (tenant_id, user_id, kind),
  constraint user_images_kind_check check (kind in ('photo', 'cover')),
  constraint user_images_user_id_fkey
    foreign key (tenant_id, user_id) references users (tenant_id, id) on delete cascade
);

select tenant_scope('user_images'::regclass);
