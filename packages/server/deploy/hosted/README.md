# Hosted deployment: names, certificates, roles, billing and the public suffix list

The operator's runbook for the hosted edition (hosted edition spec §21, §22; ADR-0038, ADR-0039): the server in
`WIREBENCH_SERVER_MODE=hosted`, where teams sign up at `app.<app-domain>/signup`, pay through Paddle, and each get
`<slug>.<app-domain>`. No domain is owned yet, so every name below is a placeholder: `<app-domain>` for the product,
`<site-domain>` for the public site. There is no Paddle account yet either: every Paddle value in this folder is a
`test_…` or `pri_test…` placeholder. Hosting is in the EU only, and there is no free tier: a team exists once its
first payment arrives.

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

## The database roles

Hosted mode needs three roles, and refuses to start without them (spec §19.4, §22.2):

| Role                | URL                                       | What it does                                                     |
| ------------------- | ----------------------------------------- | ---------------------------------------------------------------- |
| `wirebench`         | `WIREBENCH_SERVER_MIGRATION_DATABASE_URL` | Owns the schema and migrates it; the image's superuser here      |
| `wirebench_app`     | `WIREBENCH_SERVER_DATABASE_URL`           | Runs every query, under row-level security; never a superuser    |
| `wirebench_control` | `WIREBENCH_SERVER_CONTROL_DATABASE_URL`   | The control plane alone: `bypassrls`, never a superuser or owner |

The server refuses a superuser, `BYPASSRLS` or owning app role in hosted mode (`tenancy-role-bypasses`), a migration
URL naming the app role (`control-plane-migration-url-shared`), and a control role that is a superuser, may create
roles or databases, owns anything or is the app role or the owner (`control-plane-role-*`).

Only a superuser, or a role that itself has `BYPASSRLS`, may create a `BYPASSRLS` role. Here the owner is the image's
superuser, so `docker compose run --rm server admin tenancy role` creates both roles with the passwords from `.env`
(as SCRAM verifiers, never the password) and grants them. With an owner that is no superuser (a managed database),
`admin tenancy role --print-sql` prints the statements: a superuser runs the `create role` lines once, the owner the
rest. The server grants both roles again at every start, so a table a later migration adds is covered.

## Billing: Paddle

Paddle is the merchant of record: it takes the payment, charges the VAT and sends the invoices. Enterprise is invoiced
by Verathic directly and set with `admin tenant set-edition`, outside Paddle. The server never calls Paddle's API and
holds no API key: it renders Paddle.js's checkout overlay on the signup page and receives Paddle's webhooks at
`https://app.<app-domain>/billing/paddle`, each checked against the `Paddle-Signature` header before it is read.

In Paddle's dashboard (sandbox first):

1. Create the **Team** product with a per-seat monthly price, and put its id (`pri_…`) in `.env` as
   `PADDLE_TEAM_PRICE_ID`.
2. Create a **client-side token** and put it in `.env` as `PADDLE_CLIENT_TOKEN`, with `PADDLE_ENVIRONMENT=sandbox` for
   a `test_…` token or `production` for a `live_…` one; the server refuses a token that does not match.
3. Approve `https://app.<app-domain>` as a checkout domain (the signup page's origin).
4. Create a **notification destination** for `https://app.<app-domain>/billing/paddle` with the `subscription.*`
   events, and put its secret key (`pdl_ntfset_…`) alone in `secrets/paddle_webhook_secret`, readable by the server's container only: `chown 1000:1000` and
   `chmod 400` it (the image runs as its `node` user, uid 1000, and compose mounts the file with the host's owner and
   mode, so a root-owned mode-600 file stops the server at start). It is a secret: the server reads it from the file, never prints it, and keeps it off every log line.

A subscription that goes `past_due` gets Paddle's own retries and 14 days' grace, then the team is suspended `unpaid`;
a canceled one suspends the team at the end of its period and keeps its data until a server admin or the operator asks
for its deletion. Before the first real customer, run `docs/manual-tests/2026-11-04-paddle-sandbox.md` against the
sandbox.

## Starting

1. Copy `env.example` to `.env` and fill it in: the two names, the ACME contact address, the three database passwords,
   the secrets key (`openssl rand -base64 32`), the audit chain key (`openssl rand -base64 48`; never change it: every
   team's chain is sealed under a key derived from it, and its exports verify by it), the SMTP sender the entry's and the teams' mail goes out through,
   `PROXY_TOKEN` (`openssl rand -hex 32`), which Traefik and the server share for custom domains, and the three Paddle
   values. Put the Paddle webhook secret in `secrets/paddle_webhook_secret`.
2. `docker compose run --rm server config check`: every variable hosted mode requires is named if missing, and every
   one it refuses (`WIREBENCH_SERVER_OIDC_*`, `_SAML_*`, `_AUDIT_FORWARD_*`, which are each team's own settings in
   hosted mode) is named if set.
3. `docker compose up -d db`, then `docker compose run --rm server admin tenancy role` (above).
4. `docker compose up -d`.
5. Check: `https://<app-domain>/` redirects to `https://app.<app-domain>/`, which shows the "Find your team" page;
   `https://app.<app-domain>/signup` shows the signup form; and the certificate's subject names both `<app-domain>`
   and `*.<app-domain>`. `wirebench-server admin tenant list` lists the teams.

`.env`, `server.env` and `secrets/` are in this folder's `.gitignore`: never commit them.

## Custom domains

An Enterprise team can serve the product at a name of its own, such as `wirebench.<customer-domain>` (hosted edition
spec §23). The server proves the name and tells Traefik about it; Traefik gets the name its own certificate by
HTTP-01. Nothing in this folder changes per customer, and the DNS records above stay as they are:
`custom.<app-domain>`, which every custom name points at, is already under the wildcard.

**What the customer creates.** A team admin claims the name in Settings, which shows two records for the customer's
own DNS:

| Type    | Name                | Value                                   |
| ------- | ------------------- | --------------------------------------- |
| `CNAME` | `<name>`            | `custom.<app-domain>`                   |
| `TXT`   | `_wirebench.<name>` | `wirebench-domain-verification=<token>` |

An apex (`example.com` itself) cannot hold a CNAME, so a customer uses a name under it. A provider that flattens a
CNAME at the apex passes when its addresses equal `custom.<app-domain>`'s.

**What happens.** The server checks the records hourly (on demand at most once a minute). Once both pass, the name is
`verified` and held for that team. Traefik polls the server's internal proxy listener (`server:8081`, never published)
every 10 seconds, finds a router for the name, and asks Let's Encrypt for its certificate through the `le-http`
resolver: a challenge file on the `web` entry point, which Traefik answers ahead of its redirect to `https`. The server
probes `traefik:443` with the name every 2 minutes; when a trusted certificate for it answers, the name is `active`
and becomes the team's primary name, and the team's server admins get a mail. A name that stops passing is re-checked
every 6 hours, `failing` but still served, and released after 72 hours (`lapsed`).

**The token.** Every poll carries `Authorization: Bearer <PROXY_TOKEN>`. Traefik's provider header takes a value, not
a file, so the token is set once in `.env` as `PROXY_TOKEN`: compose puts it into Traefik's header and also hands it
to the server as the `proxy_token` secret, which the server reads from `WIREBENCH_SERVER_PROXY_TOKEN_FILE`. It is one
value, so the two cannot drift. Make it with `openssl rand -hex 32`; changing it means `docker compose up -d` for
both services. It shows in Traefik's container command line (`docker inspect`), so keep the Docker socket to the
operators. Don't run Traefik at `--log.level=DEBUG` in production: the provider's header, the token, can then appear in
its log as well as its argv. A compose secret with an `environment:` source, as `proxy_token` is, needs Docker Compose
2.24 or newer.

**What the operator sees.** `wirebench-server admin domains list` prints every team's claim: its slug, the name, the
state and when it was last checked, never a token. Traefik's log shows one ACME order per verified name and the
router's name, `custom-` and a hash of the host. Let's Encrypt's rate limits apply per registered domain of the
customer's name, so one customer cannot use up another's. While any team's names cannot be read, `/proxy/traefik`
answers `503` and Traefik keeps the routers of its last good poll, so a newly verified name waits until every team
reads again.

**Removing a name** (abuse, a support case): `wirebench-server admin domains remove --tenant <slug>`. The name is
released at once, its router goes at Traefik's next poll, and the team's primary goes back to `<slug>.<app-domain>`.
The certificate stays in `acme.json` until it expires and is never served again, since no router names it.
`admin domains check --tenant <slug>` checks a name now.

Before the first customer, run `docs/manual-tests/2026-11-04-custom-domain.md` against Let's Encrypt's staging
endpoint.

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
