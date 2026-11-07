# Manual tests: a custom domain's certificate (#830)

The Pebble test (`packages/server/test/integration/custom-domains/pebble.test.ts`) issues a certificate by HTTP-01 with
no real CA and no real DNS. These rows check the same path against Let's Encrypt, which needs a registered
`<app-domain>`, a second domain standing in for a customer (`<customer-domain>`) and a public host, none of which CI
has. Run them on the hosted deployment recipe (`packages/server/deploy/hosted/`), first with `ACME_CA_SERVER` set to
Let's Encrypt's staging endpoint, then against production. Record the date, the Traefik version and the result of each
row, and file an issue for any failure.

| #   | Step                                                                                                     | Expected                                                                                              | Result |
| --- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------ |
| C0  | `docker compose exec server cat /run/secrets/proxy_token` and compare it with `PROXY_TOKEN` in `.env` | The same value: the `environment:` secret reached the server (Docker Compose 2.24 or newer) | — |
| C1  | `curl -s -o /dev/null -w '%{http_code}' http://server:8081/proxy/traefik` from the Traefik container     | `401`: no token                                                                                       | —      |
| C2  | The same with `-H "Authorization: Bearer $PROXY_TOKEN"`                                                  | `200` and `{"http":{"routers":{}}}` before any claim                                                  | —      |
| C3  | From outside: `curl -I https://<slug>.<app-domain>/proxy/traefik` and a scan of the host's open ports    | `404` from the server; only 80 and 443 are open                                                       | —      |
| C4  | As a team admin, claim `wb.<customer-domain>` in Team settings → Domain                                       | `pending`, with the CNAME and TXT records shown                                                       | —      |
| C5  | Create both records at the customer domain's DNS, then **Check now**                                     | `verified`; C2 now lists one `custom-…` router with `Host(\`wb.<customer-domain>\`)`                  | —      |
| C6  | Watch Traefik's log for 30 seconds after C5                                                              | One order for `wb.<customer-domain>` by the `le-http` resolver, a challenge on port 80, then success  | —      |
| C7  | Wait up to 2 minutes                                                                                     | `active`; the team's server admins get the activation mail with the identity-provider notice          | —      |
| C8  | `openssl s_client -connect <proxy-host>:443 -servername wb.<customer-domain>`                            | The certificate's name is `wb.<customer-domain>` (staging issuer on staging)                          | —      |
| C9  | `curl -I http://wb.<customer-domain>/`                                                                   | A redirect to `https://wb.<customer-domain>/`; the challenge path still worked in C6                  | —      |
| C10 | Open `https://wb.<customer-domain>/` and sign in                                                         | The team's app, with HSTS, signed in on that name only                                                | —      |
| C11 | `wirebench-server admin domains remove --tenant <slug>`                                                  | Within 10 seconds C2 lists no router; `https://wb.<customer-domain>/` no longer reaches the team      | —      |
| C12 | Grep the server's and Traefik's logs for the TXT token and for `PROXY_TOKEN`'s value                     | Neither in the server's log; record whether Traefik's start-up log prints the provider header        | —      |
| C13 | Remove `ACME_CA_SERVER`, delete the `letsencrypt` volume, restart, and repeat C4–C8                      | A trusted certificate for the name, valid in a browser without a warning                              | —      |
