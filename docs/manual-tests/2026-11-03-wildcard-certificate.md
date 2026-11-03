# Manual tests: the hosted wildcard certificate (#822)

Issuance needs a real domain, its DNS at Hetzner and a public host, none of which CI has. Run these on the hosted
deployment recipe (`packages/server/deploy/hosted/`) once a domain is registered, first against Let's Encrypt's
staging endpoint, then against production. Record the date, the Traefik version and the result of each row, and file an
issue for any failure.

| #   | Step                                                                       | Expected                                                                                    | Result |
| --- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------ |
| W1  | `docker compose up -d` with `ACME_CA_SERVER` set to the staging endpoint   | Traefik's log shows one order for `<app-domain>` and `*.<app-domain>`, then success         | —      |
| W2  | Watch the zone at Hetzner during W1                                        | A TXT record at `_acme-challenge.<app-domain>` appears and is removed afterwards            | —      |
| W3  | `openssl s_client -connect <app-domain>:443 -servername acme.<app-domain>` | The certificate's names are `<app-domain>` and `*.<app-domain>` (staging issuer)            | —      |
| W4  | `curl -I https://<app-domain>/path?q=1` (with `-k` on staging)             | `308` to `https://app.<app-domain>/`                                                        | —      |
| W5  | Open `https://app.<app-domain>/`                                           | The "Find your team" page; no cookie set                                                    | —      |
| W6  | Open `https://a.b.<app-domain>/`                                           | No route: Traefik answers 404, the server is not reached                                    | —      |
| W7  | Remove `ACME_CA_SERVER`, delete the `letsencrypt` volume, restart          | A trusted certificate, valid in a browser without a warning                                 | —      |
| W8  | `grep -c HETZNER /proc/$(pgrep traefik)/environ` inside the container      | Only `HETZNER_API_TOKEN_FILE`; the token is not in the environment                          | —      |
| W9  | After 60 days, or with the renewal forced by a shorter staging run         | Traefik renews without a restart; the old certificate is replaced                           | —      |
