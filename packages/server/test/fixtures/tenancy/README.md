# The frozen `0019` fixture

A database and a data directory as Wirebench Server left them at commit `e9bdc5af1`, the last schema at
migration `0019` (hosted edition spec §19.13). The tenancy migrations (`0020`, `0021`), the file step, the key
re-wrap and `admin tenancy revert` are tested against it, so it never changes once checked in. It is written by
that commit's own code, never by a seed run through today's repositories, which the tenancy work rewrites.

| File                      | What it holds                                                                                                                                                                                                    |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `seed-0019.sql`           | `pg_dump --data-only --column-inserts` of every table but `schema_migrations`, with rows in all 36 others: sealed audit rows and an unsealed tail, a disabled user, an accepted invitation, a revoked CI token and a rejected capture.                                                     |
| `data-dir-0019.tar.gz`    | The data directory: bare repositories, a `tmp/removed-…` repository and scratch, and a checkout a real host wrote with two server workspaces open, holding a `secrets.json` and two cookie jars.                  |
| `fixture-0019.json`       | The ids, the sealed chain's range, the keys every sealed value is under, the plaintexts behind them, and the checksums of migrations `0001` to `0019`. `load.ts` exports it as `Fixture`.                        |
| `load.ts`                 | `loadFixture0019(owner, dataDir)`: migrations `0001` to `0019` as the owner, the rows, then the data directory.                                                                                                  |
| `generate-0019.ts`        | The generator. It runs only inside a worktree of `e9bdc5af1`.                                                                                                                                                    |
| `make-fixture-0019.ts`    | Makes that worktree, runs the generator there, copies the three outputs here, and removes the worktree.                                                                                                          |

The git configs in the tarball name the generator's data directory as `@WIREBENCH_FIXTURE_DATA_DIR@`, and the
loader puts the new one back.

## Regenerating

Only when the fixture itself is wrong: a new one changes every id, and the tests that name the old ones.

```sh
WIREBENCH_SERVER_TEST_DATABASE_URL=postgres://wirebench:wirebench@127.0.0.1:5432/wirebench \
  node packages/server/test/fixtures/tenancy/make-fixture-0019.ts
```

It needs:

- **A superuser URL** on a scratch database, in `WIREBENCH_SERVER_TEST_DATABASE_URL`. That commit's test helper
  creates and drops its schema as that role.
- **A `pg_dump` of the server's major version.** Without one on the `PATH`, set `WIREBENCH_FIXTURE_PG_DUMP` to a
  command that runs one, such as `docker exec <container> pg_dump -U wirebench -d wirebench`.
- **Network access**, for `pnpm install` in the worktree of `e9bdc5af1`.
- **A non-loopback IPv4 address, and port 47019 free on it.** The host refuses to send to loopback, so the cookie
  target listens on the machine's LAN address. The requests name `http://cookies.fixture.test:47019`, which the
  generator resolves to that address inside its own process only. No file of the fixture holds the address.

`--in-place` runs the generator in the current checkout, which is only useful while working on the generator:
its output is not the frozen fixture.

**A regeneration changes almost every byte**, so review it as a new fixture, not as a diff. The ids are ULIDs,
the secrets, nonces and agent key are random, the host writes real-clock times into `secrets.json`, and the
removed repository's name carries an epoch. The URLs, keys, plaintexts and the rows' clock (`2026-09-24T12:00Z`)
stay the same.

`fixture-0019.json` records the version, name and SHA-256 of migrations `0001` to `0019` as the generator ran
them. `loadFixture0019` refuses to load when today's files differ, because the rows only fit that schema.
