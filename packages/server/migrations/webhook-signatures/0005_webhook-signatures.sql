-- Wirebench Server 0005: signature verification on catch URLs (webhook-signatures spec §3.2).
-- A catch URL's scheme and its sealed secret are set and cleared together; the secret is never
-- returned. A capture's verdict is fixed on receipt: null means the catch URL checked nothing.

alter table catch_urls
  -- A SignatureScheme, validated by the app before it is written.
  add column signature jsonb null,
  -- version ‖ iv ‖ tag ‖ ciphertext (hooks/secret-box.ts); never returned or logged.
  add column signature_secret bytea null,
  -- The last four characters of the secret, for editors.
  add column signature_hint text null,
  add column reject_unverified boolean not null default false,
  add constraint catch_urls_signature_pair check ((signature is null) = (signature_secret is null)),
  add constraint catch_urls_reject_needs_signature check (not reject_unverified or signature is not null);

alter table captures
  add column signature_verdict text null check (signature_verdict in ('verified', 'failed')),
  -- A SignatureFailure when the verdict is 'failed'.
  add column signature_reason text null,
  -- Answered 401 because the catch URL rejects unverified requests; stored all the same.
  add column rejected boolean not null default false;
