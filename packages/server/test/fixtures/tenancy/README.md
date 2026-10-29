# The frozen `0019` fixture

A database and a data directory as Wirebench Server left them at commit `e9bdc5af1`, the last schema at
migration `0019` (hosted edition spec §19.13). The tenancy migrations (`0020`, `0021`), the file step, the key
re-wrap and `admin tenancy revert` are tested against it, so it never changes once checked in. It is written by
that commit's own code, never by a seed run through today's repositories, which the tenancy work rewrites.

| File                      | What it holds                                                                                                                                                                                                    |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `seed-0019.sql`           | `pg_dump --data-only --column-inserts` of every table but `schema_migrations`, with rows in all 36 others, including sealed audit rows and an unsealed tail.                                                     |
| `data-dir-0019.tar.gz`    | The data directory: bare repositories, a `tmp/removed-…` repository and scratch, and a checkout a real host wrote with two server workspaces open, holding a `secrets.json` and two cookie jars.                  |
| `fixture-0019.json`       | The ids, the sealed chain's range, the keys every sealed value is under, and the plaintexts behind them. `load.ts` exports it as `Fixture`.                                                                       |
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

The URL is a superuser's, on a scratch database. Without `pg_dump` on the `PATH`, set
`WIREBENCH_FIXTURE_PG_DUMP` to a command that runs one, such as
`docker exec <container> pg_dump -U wirebench -d wirebench`. The machine needs a non-loopback IPv4 address,
because the host refuses to send to loopback. `--in-place` runs the generator in the current checkout, which is
only useful while working on the generator: its output is not the frozen fixture.
