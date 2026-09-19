# Spec: CI recipes for the runner — GitHub Action, container image, GitLab template

- Status: **approved** (2026-09-19)
- Date: 2026-09-19
- Issue: [#31](https://github.com/wirebench/wirebench/issues/31) (roadmap item 3, milestone 2.3)
- Builds on: `docs/specs/2026-09-18-cli-runner-design.md` (the runner, shipped in #94), `docs/release.md`
  (tag-driven releases), `docs/cli.md` (the command reference).
- Owner decisions (2026-09-19): publish **both** a container image and an npm package; the GitHub Action
  lives in a **subfolder of this repository**; images are **amd64 + arm64**, built on **release tags**.

## Assumptions I'm making

1. **Nothing is downloadable today.** `@wirebench/cli` and `@wirebench/engine` are both `private: true`
   and there is no Dockerfile. This is the first time the project publishes anything besides the desktop
   app's GitHub release.
2. **npm: publish both packages, no bundler.** The CLI depends on the engine, which loads a worker file
   (`xpath/worker.js`) and a WASM validator at run time — bundling them into one file is fragile. Both
   packages are published, lock-step at the app's version. The engine gets a publish-time shape through
   `publishConfig` (`dist/` only, no `development` condition, no `./test-helpers` subpath), so its
   in-repo exports stay exactly as they are. No new dependency.
3. **The image is built from the repository, not from npm.** A multi-stage Dockerfile builds with pnpm
   and uses `pnpm deploy --prod`, so the image and the npm package never wait on each other.
4. **Names.** Image `ghcr.io/wirebench/wirebench-cli`; npm `@wirebench/cli` and `@wirebench/engine`;
   Action `wirebench/wirebench/action@<tag>`; GitLab template `templates/gitlab/wirebench.gitlab-ci.yml`.
5. **Versions follow the release tag.** `v2.3.0` publishes image tags `2.3.0`, `2.3`, `latest` and npm
   `2.3.0` under `latest`. A pre-release (`v2.3.0-rc.1`) publishes image `2.3.0-rc.1` only and npm under
   `next` — never `latest`.
6. **Publishing happens only in `release.yml`**, after `check` passes, with job-level permissions
   (`packages: write`, `id-token: write`) and no workflow-wide write. npm and GHCR have no draft state, so
   a bad release is withdrawn by a patch release, not by deleting a version.
7. **The Action sets up Node 24** (input `node-version`, default `24`), since hosted runners default to
   an older Node. This changes `node` for later steps of the caller's job; the Action's README says so.
8. **Secrets are the caller's.** No recipe holds or asks for a secret. The caller maps CI secrets to
   `WIREBENCH_SECRET_<NAME>` in `env:` (GitHub) or `variables:` (GitLab); the runner's masking does the
   rest.
9. **Out of scope:** `--baseline` (#36), a Marketplace listing, templates for other CI systems (the image
   and npm cover them), image signing and SBOM (#28).

## 1. Objective

A team with a Wirebench project in its repository goes from nothing to a red-or-green pipeline step in
five minutes, on GitHub or GitLab, without installing anything by hand.

```yaml
# GitHub Actions
- uses: wirebench/wirebench/action@v2.3.0
  with:
    project: ./api-tests
    env: staging
    junit: reports/wirebench.xml
  env:
    WIREBENCH_SECRET_BILLING_PASSWORD: ${{ secrets.BILLING_PASSWORD }}
```

```yaml
# GitLab CI
include:
  - remote: https://raw.githubusercontent.com/wirebench/wirebench/v2.3.0/templates/gitlab/wirebench.gitlab-ci.yml

api-tests:
  extends: .wirebench-run
  variables:
    WIREBENCH_VERSION: '2.3.0'
    WIREBENCH_PROJECT: api-tests
    WIREBENCH_ENV: staging
```

Each goes red on a failed assertion, shows JUnit results in the CI's test view, and never prints a
secret.

## 2. The recipes

### 2.1 npm packages

- Both `package.json` files drop `private` and gain `files` (`dist`, `README.md`, `LICENSE`),
  `repository`, `license`, `engines: { node: ">=24" }` and `publishConfig` (`access: public`,
  `provenance: true`; for the engine, the publish-time `exports`).
- `packages/cli/README.md`: install, one example, link to `docs/cli.md`.
- The CLI keeps `workspace:*` on the engine; pnpm rewrites it to the exact version at pack time.
- `npx @wirebench/cli@2.3.0 run …` works on Linux, macOS and Windows with Node 24.

### 2.2 Container image

- `packages/cli/Dockerfile` (context: repo root) and a root `.dockerignore` excluding `apps/`,
  `docs-site/`, `e2e/`, `node_modules`, `git-worktrees/` and build output.
- Stage 1 (`node:24-bookworm-slim`, pnpm via corepack): `--frozen-lockfile` install, build engine + CLI,
  `pnpm deploy --filter @wirebench/cli --prod /out`.
- Stage 2 (`node:24-bookworm-slim`): copy `/out` to `/app`, run as the non-root `node` user,
  `WORKDIR /work`, `ENTRYPOINT ["node", "/app/dist/bin.js"]`, OCI labels (source, version, revision,
  licence).
- Usage: `docker run --rm -v "$PWD:/work" -e WIREBENCH_SECRET_X ghcr.io/wirebench/wirebench-cli:2.3.0 run ./project --env ci`.
- `linux/amd64` and `linux/arm64` via Buildx (arm64 through QEMU).

### 2.3 GitHub Action — `action/action.yml`

Composite action:

| Input | Default | Maps to |
| --- | --- | --- |
| `project` | _(required)_ | `<path>` |
| `env` | — | `--env` |
| `select` | — | selectors, one per line |
| `vars` | — | `--var`, one `key=value` per line |
| `junit` / `json` / `html` | — | `--reporter junit=…` etc. |
| `bail`, `require-assertions`, `insecure` | `false` | the flags |
| `timeout`, `sla` | — | `--timeout`, `--sla` |
| `version` | the Action's ref when it is a version tag, else `latest` | npm version to run |
| `node-version` | `24` | `actions/setup-node` |

- Steps: `actions/setup-node` → one bash step that builds an argument array from inputs passed through
  `env:` (never interpolated into the script) and runs `npx --yes @wirebench/cli@<version> run …`.
- Output `exit-code`. A non-zero exit fails the step; callers using `continue-on-error` can still read it.
- Works on `ubuntu-*`, `macos-*` and `windows-*` runners (bash exists on all three).

### 2.4 GitLab template — `templates/gitlab/wirebench.gitlab-ci.yml`

- Hidden job `.wirebench-run`: `image: ghcr.io/wirebench/wirebench-cli:${WIREBENCH_VERSION}`,
  `entrypoint: [""]`.
- Variables: `WIREBENCH_VERSION` (default `latest`; docs say pin it), `WIREBENCH_PROJECT` (required),
  `WIREBENCH_ENV`, `WIREBENCH_ARGS`, `WIREBENCH_JUNIT` (default `wirebench-junit.xml`).
- `script` runs the runner with `--reporter cli --reporter junit=$WIREBENCH_JUNIT` plus the rest.
- `artifacts: when: always` with `reports: junit`, so results show even on a red pipeline.
- The file is not rewritten at tag time (the tagged file must equal the tagged commit), hence the
  explicit `WIREBENCH_VERSION` pin in the docs.

### 2.5 Docs

- `docs/cli.md` gains "Run in CI": one complete example each for GitHub, GitLab, plain Docker and plain
  npx, and how to map CI secrets to `WIREBENCH_SECRET_*`.
- `action/README.md` lists the inputs and output.
- A docs-site "Run in CI" page; README links to it.
- `docs/release.md` gains the publishing jobs and §6's owner actions.

## 3. Release workflow

`release.yml` gains two jobs, `needs: check`, beside the packaging jobs:

- **`image`** — setup-qemu, setup-buildx, login to GHCR with `GITHUB_TOKEN`, metadata-action for the tags
  in assumption 5, build-push for both platforms. Permissions `contents: read`, `packages: write`.
- **`npm`** — install, build, set both versions from the tag,
  `pnpm publish -r --filter @wirebench/engine --filter @wirebench/cli --tag <latest|next>` with
  provenance. Permissions `contents: read`, `id-token: write`. Auth: npm trusted publishing.
- A `workflow_dispatch` run (the rehearsal) builds the image and packs the tarballs but **pushes and
  publishes nothing**.

## 4. Testing

- **Unit:** parse `action/action.yml` and the GitLab template as YAML; check every documented
  input/variable exists and that no `run:` string interpolates `${{ inputs.* }}`.
- **CI (`ci.yml`), every PR:**
  - `image-smoke` (ubuntu): build amd64 only; `scripts/cli-smoke.ts` starts the CLI tests' demo server
    and runs the image on the runner fixture — exit 0 for a passing selection, exit 1 for a failing one,
    JUnit file on the host, no secret in the output. It also runs the GitLab template's `script` line in
    the image.
  - `npm-smoke` (ubuntu, macos, windows): `pnpm pack` both packages, install the tarballs into an empty
    directory, run the same smoke script through that install.
  - `action-smoke` (ubuntu, windows): `uses: ./action` pointed at the packed tarball, same fixture.
- **Release rehearsal:** `workflow_dispatch` on `release.yml` before the first real tag.

## 5. Boundaries

- **Always:** one commit per task after `WIREBENCH_SKIP_PERF=1 pnpm check`; Action inputs via `env:`;
  pin third-party actions to a major version as `ci.yml` does; keep the engine's in-repo exports
  unchanged.
- **Ask first:** creating the npm org, an `NPM_TOKEN` secret or a trusted-publisher entry; making the
  GHCR package public; changing the desktop packaging jobs; adding a dependency.
- **Never:** push or publish from a PR or a rehearsal run; put a secret in a recipe, example or fixture;
  name in docs or code the products that inspired a feature; tag a pre-release `latest`.

## 6. Before the first publishing release (owner actions, outside the repository)

1. Create (or confirm) the `wirebench` npm organisation; register `release.yml` as a trusted publisher
   for both packages, or add an `NPM_TOKEN` secret.
2. After the first image push, make `ghcr.io/wirebench/wirebench-cli` **public** and link it to this
   repository (GHCR packages start private).
3. Run `release.yml` by `workflow_dispatch` once and check the rehearsal.

## 7. Success criteria

1. `npx @wirebench/cli@<version> --version` prints the version on Linux, macOS and Windows, Node 24.
2. `docker run ghcr.io/wirebench/wirebench-cli:<version> --version` works on amd64 and arm64.
3. The Action with `project` + `junit` fails its job on a failing assertion, passes on a passing run and
   leaves the JUnit file in the workspace, on ubuntu and windows.
4. The GitLab template's script, run in the image on the fixture, yields the JUnit file and the runner's
   exit code.
5. A pre-release tag publishes nothing as `latest`; a PR or rehearsal publishes nothing at all.
6. Every example in `docs/cli.md` "Run in CI" is exercised by a smoke job.
7. `pnpm check` and the release rehearsal are green.

## Resolved questions (2026-09-19)

1. **npm auth:** trusted publishing (OIDC, provenance, no long-lived token).
2. **Engine as a public package:** its README says it is an internal dependency of the CLI with no
   stability promise until 3.0.
3. **Image name:** `ghcr.io/wirebench/wirebench-cli`.
