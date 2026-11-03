# Hosted deployment: names, certificates and the public suffix list

The operator's runbook for the hosted edition's names (hosted edition spec §21, ADR-0038). It runs end to end once the
control plane (slice 7) lifts the server's refusal of `WIREBENCH_SERVER_MODE=hosted`; until then it is the recipe that
slice will start. No domain is owned yet, so every name below is a placeholder: `<app-domain>` for the product,
`<site-domain>` for the public site.

## The two names

Register **two** domains:

- `<app-domain>`: the product. Each team is `https://<slug>.<app-domain>`. `app.<app-domain>` is the entry where a
  person gets their teams' links by email, and the apex redirects to it.
- `<site-domain>`: the site, docs and signup. The server never serves it; it is built and hosted apart.

They must be two registrable names, not one under the other, so that a cookie or storage key set on one can never be
read by a page on the other. The server checks that neither sits under the other, but it does not check that each is
a registrable name (one label under a public suffix): that is yours to get right.

Set them in `.env` as `APP_DOMAIN` and `SITE_DOMAIN`; the compose file passes them to the server as
`WIREBENCH_SERVER_APP_DOMAIN` and `WIREBENCH_SERVER_SITE_DOMAIN`. Use the `xn--` form for an international name.

## DNS

Host `<app-domain>`'s DNS at Hetzner DNS (the domain can be registered anywhere; point its name servers there). Create:

| Name             | Type         | Value                      |
| ---------------- | ------------ | -------------------------- |
| `<app-domain>`   | `A` / `AAAA` | the proxy host's addresses |
| `*.<app-domain>` | `A` / `AAAA` | the proxy host's addresses |

`<site-domain>` keeps its own records, pointing at wherever the site is hosted.

## The certificate

Traefik, the only public listener, asks Let's Encrypt for **one** certificate covering `<app-domain>` and
`*.<app-domain>`. A wildcard can only be proven by DNS-01: Traefik writes a short TXT record at
`_acme-challenge.<app-domain>` through the Hetzner DNS API, Let's Encrypt reads it, and the record is removed. Renewal
runs by itself about 30 days before expiry. The server never sees the certificate, its key or the DNS token.

1. In the Hetzner console, create an API token for the project that holds the zone, with read and write access.
2. Put it in `secrets/hetzner_api_token` beside this file, with nothing else in the file, and `chmod 600` it. Traefik
   reads it through `HETZNER_API_TOKEN_FILE`; it is never in the environment and never in a log.
3. For a first run, set `ACME_CA_SERVER=https://acme-staging-v02.api.letsencrypt.org/directory` in `.env`: the staging
   endpoint issues an untrusted certificate but has generous rate limits. Once it works, remove the line and delete
   the `letsencrypt` volume so the trusted certificate is requested.

Another DNS provider is a change in `compose.yaml`: replace `dnschallenge.provider=hetzner` with the provider's lego
code and its token variable, as the lego documentation for the Traefik version in use lists them. Nothing in the server
changes.

## Starting

1. Copy `env.example` to `.env` and fill it in: the two names, the ACME contact address, both database passwords, the
   secrets key (`openssl rand -base64 32`) and the SMTP sender the entry's mail goes out through.
2. `docker compose up -d`.
3. Check: `https://<app-domain>/` redirects to `https://app.<app-domain>/`, which shows the "Find your team" page, and
   the certificate's subject names both `<app-domain>` and `*.<app-domain>`.

`.env`, `server.env` and `secrets/` are in this folder's `.gitignore`: never commit them.

## The public suffix list

Once `<app-domain>` is registered and stable, submit it to the public suffix list, so that every browser, extension and
password manager treats `acme.<app-domain>` and `other.<app-domain>` as separate sites. Until the listing ships, which
takes months, the `__Host-` session cookie and per-origin storage already keep tenants apart.

1. Keep the registration paid at least two years ahead: the list's maintainers ask for it, and a lapsed listed domain
   is a hazard to everyone.
2. Open a pull request to the list's repository adding `<app-domain>` to its private section, under a comment naming
   the project and a contact address.
3. Add a TXT record `_psl.<app-domain>` holding that pull request's URL, and keep it for as long as the entry is listed.
4. Answer the maintainers' questions on the pull request. When it merges, nothing changes in Wirebench.
