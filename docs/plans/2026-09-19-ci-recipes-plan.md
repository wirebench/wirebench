# CI Recipes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended)
> or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`)
> syntax for tracking.

**Goal:** Ship `wirebench run` to CI users as npm packages, a GHCR image, a GitHub Action and a GitLab
template, published from `release.yml` on version tags.

**Architecture:** `@wirebench/engine` and `@wirebench/cli` become publishable through `publishConfig`
(no bundler). A multi-stage Dockerfile builds the image from the repository with `pnpm deploy`. A
composite Action in `action/` runs the npm package with `npx`; a GitLab hidden job runs the image. One
smoke script, driven three ways (image, packed tarballs, Action), proves each recipe on every PR.

**Tech Stack:** pnpm 9, Node 24, TypeScript (NodeNext, strict), vitest, GitHub Actions, Docker Buildx,
GHCR, npm trusted publishing.

**Spec:** `docs/specs/2026-09-19-ci-recipes-design.md`

## Global Constraints

- Node `>=24`; base image `node:24-bookworm-slim`.
- Names: image `ghcr.io/wirebench/wirebench-cli`; npm `@wirebench/cli`, `@wirebench/engine`; Action
  `action/action.yml`; template `templates/gitlab/wirebench.gitlab-ci.yml`.
- Tags: `vX.Y.Z` → image `X.Y.Z`, `X.Y`, `latest`, npm dist-tag `latest`. A tag containing `-` → image
  `X.Y.Z-pre` only, npm dist-tag `next`. Never `latest` for a pre-release.
- Publishing only from `release.yml` on a `refs/tags/v*` ref; `workflow_dispatch` and PRs never push or
  publish. Job-level permissions only (`packages: write` / `id-token: write`); workflow stays
  `contents: read`.
- npm auth: trusted publishing (OIDC) with provenance; no `NPM_TOKEN`.
- `@wirebench/engine`'s in-repo `exports` (with `development` and `./test-helpers`) stay unchanged; the
  publish shape lives in `publishConfig.exports`.
- Action inputs reach scripts only through `env:`; no `${{ inputs.* }}` inside a `run:` string.
- Third-party actions pinned to a major version, as `ci.yml` does.
- No new runtime dependency. (`yaml` is already an engine dependency; tests may import it.)
- No secret in any recipe, example or fixture. Never name, in docs or code, the products that inspired a
  feature (`pnpm check:banned-terms`).
- Commits as Mohammed Naami <m.naami@outlook.com>; no `Co-Authored-By:` or `Claude-Session:` trailer.
  One commit per task after `WIREBENCH_SKIP_PERF=1 pnpm check` is green.
- Docker is optional locally: image tasks are verified by the CI job; run the Dockerfile locally only if
  `docker` is available.

---

### Task 1: Publishable npm packages

**Files:**

- Modify: `packages/engine/package.json`, `packages/cli/package.json`, `.gitignore`, `package.json`
  (script `pack:check`)
- Create: `packages/engine/README.md`, `packages/cli/README.md`, `scripts/pack-check.ts`,
  `scripts/pack-check.test.ts`

**Interfaces:**

- Produces: `pnpm pack:check` — packs both packages into a temp dir and fails if a tarball holds anything
  outside `dist/`, `README.md`, `LICENSE`, `package.json`; if the packed engine manifest has a
  `development` condition or a `./test-helpers` export; or if the packed CLI depends on any `workspace:`
  version. Exported helper
  `packPackages(outDir: string): Promise<{ engine: string; cli: string }>` (tarball paths) — reused by
  Tasks 2 and 4.

- [ ] Both manifests: remove `"private": true`; add `"files": ["dist", "README.md", "LICENSE"]`,
      `"repository": { "type": "git", "url": "git+https://github.com/wirebench/wirebench.git", "directory": "packages/<name>" }`,
      `"engines": { "node": ">=24" }`, `"publishConfig": { "access": "public", "provenance": true }`.
- [ ] Engine `publishConfig.exports`: the same subpaths as `exports` minus `development` on each and minus
      `./test-helpers`.
- [ ] Root `LICENSE` into each tarball: a `prepack` script copying `../../LICENSE` (via `node -e`, no
      shell tools) and `packages/*/LICENSE` in `.gitignore`.
- [ ] Engine README: one paragraph — internal dependency of `@wirebench/cli`, no stability promise until
      3.0, repo link. CLI README: `npx @wirebench/cli run ./project --env ci`, Node 24 note, link to
      `docs/cli.md`.
- [ ] Write `scripts/pack-check.test.ts` first (vitest `scripts` project): `packPackages`, list entries
      with `tar -tzf` via `execFileSync`, assert the rules above. Red, then implement
      `scripts/pack-check.ts` (`pnpm --filter <pkg> pack --pack-destination <dir>` via `execFileSync`,
      no shell). Green.
- [ ] Same test: install both tarballs into a temp dir (`npm install --no-audit --no-fund <engine.tgz> <cli.tgz>`)
      and run `node node_modules/@wirebench/cli/dist/bin.js --version`; expect the manifest version
      (proves the packed engine and its worker resolve).
- [ ] `WIREBENCH_SKIP_PERF=1 pnpm check`; commit `feat(cli): make the engine and CLI publishable to npm`.

### Task 2: Recipe smoke script

**Files:**

- Create: `scripts/cli-smoke.ts`, `scripts/cli-smoke.test.ts`
- Modify: `package.json` (script `cli:smoke`)

**Interfaces:**

- Consumes: `startDemoServer`, `FIXTURE` from `packages/cli/test/integration/helpers.ts`; `packPackages`
  from Task 1.
- Produces: `node scripts/cli-smoke.ts --via <node|npm|docker> [--image <ref>] [--gitlab] [--serve-only]`.
  Starts the demo server and, with the base URL passed via `--var` as the integration tests do, checks:
  1. a passing selection exits 0;
  2. a failing selection exits 1;
  3. `--reporter junit=<out>/junit.xml` leaves a parseable file on the host with the selection's testcase
     count;
  4. a run using the `/secure` secret through `WIREBENCH_SECRET_*` never shows the secret value in
     stdout, stderr or the JUnit file.
- `--via node` runs `packages/cli/dist/bin.js`; `--via npm` packs + installs the tarballs into a temp dir
  and runs the installed bin; `--via docker` copies the fixture into a temp dir and runs
  `docker run --rm --network host -v <tmp>:/work -e … <image>`. `--gitlab` (docker only) runs the
  template's `script[0]` instead (Task 5; until the file exists, exit 2 with a clear message).
  `--serve-only` starts the server, writes `url=<base>` to `$GITHUB_OUTPUT` when set (else stdout) and
  stays alive until killed. On the first failed expectation: one-line reason, exit 1.

- [ ] Reuse selectors and the secret setup from `packages/cli/test/integration/run.test.ts` and
      `secrets.test.ts`; no new fixture requests.
- [ ] `scripts/cli-smoke.test.ts` runs `--via node` as a child process and expects exit 0 (other modes run
      in CI only).
- [ ] `WIREBENCH_SKIP_PERF=1 pnpm check`; commit `test(cli): add the recipe smoke script`.

### Task 3: Container image

**Files:**

- Create: `packages/cli/Dockerfile`, `.dockerignore`
- Modify: `.github/workflows/ci.yml` (job `image-smoke`)

- [ ] Dockerfile per spec §2.2. Stage `build`: `node:24-bookworm-slim`, `corepack enable`, copy manifests
      + lockfile first for layer caching, `pnpm install --frozen-lockfile --filter @wirebench/cli...`,
      copy sources, `pnpm --filter @wirebench/cli... build`,
      `pnpm deploy --filter @wirebench/cli --prod /out`. Stage `runtime`: `COPY --from=build /out /app`,
      `USER node`, `WORKDIR /work`, `ENTRYPOINT ["node", "/app/dist/bin.js"]`, `CMD ["--help"]`,
      `ARG VERSION` / `ARG REVISION` feeding OCI labels `org.opencontainers.image.source`, `.version`,
      `.revision`, `.licenses=Apache-2.0`.
- [ ] `.dockerignore`: `**/node_modules`, `apps`, `docs-site`, `e2e`, `git-worktrees`, `**/dist`, `.git`,
      `.superpowers`, coverage and release output.
- [ ] `ci.yml` job `image-smoke` (ubuntu-latest): checkout, pnpm, node 24, install,
      `docker/setup-buildx-action@v3`, `docker/build-push-action@v6` (`load: true`, `push: false`,
      `platforms: linux/amd64`, `file: packages/cli/Dockerfile`, tag `wirebench-cli:ci`), then
      `docker run --rm wirebench-cli:ci --version` and `pnpm cli:smoke --via docker --image wirebench-cli:ci`.
- [ ] If `docker` exists locally, build and smoke once; otherwise write "verified in CI" in the report.
- [ ] `WIREBENCH_SKIP_PERF=1 pnpm check`; commit `feat(cli): add the container image`.

### Task 4: GitHub Action

**Files:**

- Create: `action/action.yml`, `action/README.md`, `scripts/recipes.test.ts`
- Modify: `.github/workflows/ci.yml` (jobs `npm-smoke`, `action-smoke`)

**Interfaces:**

- Produces: `scripts/recipes.test.ts` (parses YAML with `yaml`); Tasks 5 and 6 append cases.

- [ ] Write `scripts/recipes.test.ts` first: every input in spec §2.3's table exists with its default;
      `outputs.exit-code` exists; `runs.using === 'composite'`; no step's `run` contains `${{ inputs.`.
      Red.
- [ ] `action.yml`: inputs per the table. Steps: (1) `actions/setup-node@v7` with
      `node-version: ${{ inputs.node-version }}`; (2) id `run`, `shell: bash`, every input mapped into
      `env:` as `WB_*` plus `WB_ACTION_REF: ${{ github.action_ref }}`. Script: version = `WB_VERSION` if
      set, else `WB_ACTION_REF` without its leading `v` when it matches `^v[0-9]+\.[0-9]+\.[0-9]+`, else
      `latest`; `args=(run "$WB_PROJECT")`, then `--env`, each non-empty line of `WB_SELECT`, `--var` per
      line of `WB_VARS`, `--reporter cli`, `--reporter junit=…`/`json=…`/`html=…`, the flags;
      `set +e; npx --yes "${WB_PACKAGE:-@wirebench/cli@$version}" "${args[@]}"; code=$?`; write
      `exit-code=$code` to `$GITHUB_OUTPUT`; `exit $code`. `WB_PACKAGE` is an undocumented env override
      used only by `action-smoke` to point at a tarball.
- [ ] `action/README.md`: the spec §1 example, input table, output, the Node 24 side effect, secret
      mapping.
- [ ] `ci.yml` `npm-smoke` (matrix ubuntu/macos/windows): build, `pnpm cli:smoke --via npm`.
- [ ] `ci.yml` `action-smoke` (ubuntu, windows): build; pack into `${{ runner.temp }}/pkgs`; install the
      engine tarball globally (`npm i -g`) so `npx` resolves it; start `node scripts/cli-smoke.ts --serve-only`
      in the background and read `url`; step A `uses: ./action` (passing selection, `junit: out/pass.xml`,
      env `WB_PACKAGE` = CLI tarball); step B same with the failing selection and `continue-on-error: true`;
      assert A's `exit-code` is `0`, B's is `1`, and `out/pass.xml` exists.
- [ ] `recipes.test.ts` green; `WIREBENCH_SKIP_PERF=1 pnpm check`; commit `feat(ci): add the GitHub Action`.

### Task 5: GitLab template

**Files:**

- Create: `templates/gitlab/wirebench.gitlab-ci.yml`
- Modify: `scripts/recipes.test.ts`, `scripts/cli-smoke.ts`, `.github/workflows/ci.yml` (`image-smoke`)

- [ ] Failing cases: `.wirebench-run` exists; image `ghcr.io/wirebench/wirebench-cli:${WIREBENCH_VERSION}`;
      `entrypoint: [""]`; variables `WIREBENCH_VERSION` (`latest`), `WIREBENCH_PROJECT`, `WIREBENCH_ENV`,
      `WIREBENCH_ARGS`, `WIREBENCH_JUNIT` (`wirebench-junit.xml`); `artifacts.when === 'always'`;
      `artifacts.reports.junit === '$WIREBENCH_JUNIT'`.
- [ ] Template per spec §2.4. `script` (POSIX sh, one line):
      `node /app/dist/bin.js run "$WIREBENCH_PROJECT" ${WIREBENCH_ENV:+--env "$WIREBENCH_ENV"} --reporter cli --reporter "junit=$WIREBENCH_JUNIT" $WIREBENCH_ARGS`.
      Header comment: include the URL pinned to a tag, set `WIREBENCH_VERSION`, store secrets as masked CI
      variables named `WIREBENCH_SECRET_*`.
- [ ] `cli-smoke.ts --gitlab`: read `script[0]` and run it with `sh -c` in the image
      (`--entrypoint sh`), passing variables with `-e`; same expectations. Add a second `image-smoke`
      step running `--gitlab`.
- [ ] `WIREBENCH_SKIP_PERF=1 pnpm check`; commit `feat(ci): add the GitLab CI template`.

### Task 6: Publishing in release.yml

**Files:**

- Modify: `.github/workflows/release.yml`, `scripts/recipes.test.ts`

- [ ] Failing cases: jobs `image` and `npm` exist with `needs: check`; `image` has `packages: write`,
      `npm` has `id-token: write`; workflow-level permissions are only `contents: read`; every push or
      publish step is gated on `startsWith(github.ref, 'refs/tags/v')`.
- [ ] `image`: `docker/setup-qemu-action@v3`, `docker/setup-buildx-action@v3`, `docker/login-action@v3`
      (ghcr.io, `github.actor`, `secrets.GITHUB_TOKEN`; tags only), `docker/metadata-action@v5` with
      `images: ghcr.io/wirebench/wirebench-cli`, tags `type=semver,pattern={{version}}` and
      `type=semver,pattern={{major}}.{{minor}},enable=${{ !contains(github.ref_name, '-') }}`,
      `flavor: latest=auto`; `docker/build-push-action@v6` with `platforms: linux/amd64,linux/arm64`,
      `push: ${{ startsWith(github.ref, 'refs/tags/v') }}`, build-args `VERSION`, `REVISION`.
- [ ] `npm`: checkout, pnpm, `actions/setup-node@v7` (node 24, `registry-url: https://registry.npmjs.org`),
      install, build. On tags: `v=${GITHUB_REF_NAME#v}`, set both versions with
      `pnpm --filter @wirebench/engine --filter @wirebench/cli exec npm version "$v" --no-git-tag-version`,
      dist-tag `next` if the ref name contains `-` else `latest`,
      `pnpm publish -r --filter @wirebench/engine --filter @wirebench/cli --access public --tag "$dist" --no-git-checks`.
      On `workflow_dispatch`: `pnpm pack:check` only.
- [ ] Update the header comment: desktop artifacts stay a draft; the image and npm packages publish on
      tags.
- [ ] `WIREBENCH_SKIP_PERF=1 pnpm check`; commit `feat(release): publish the image and npm packages on tags`.

### Task 7: Docs

**Files:**

- Modify: `docs/cli.md`, `docs/release.md`, `README.md`, `CHANGELOG.md`, `docs/roadmap.md`
- Create: a docs-site "Run in CI" page beside the existing CLI page (same folder and frontmatter style)

- [ ] `docs/cli.md` "Run in CI": GitHub and GitLab (spec §1), Docker (spec §2.2), npx; secret mapping per
      CI; each example matches what a smoke job runs.
- [ ] `docs/release.md`: the `image` and `npm` jobs, tag → version table, rehearsal behaviour, and spec
      §6's owner actions under "Before the first release".
- [ ] README links to the docs-site page; CHANGELOG `Unreleased` entry; roadmap item 3 noted as shipped
      pending the first publishing release.
- [ ] `pnpm check:doc-paths && pnpm check:banned-terms`; `WIREBENCH_SKIP_PERF=1 pnpm check`; commit
      `docs: document the CI recipes`.

## Self-review

- Spec §2.1 → T1; §2.2 → T3; §2.3 → T4; §2.4 → T5; §2.5 → T7; §3 → T6; §4 → T2–T6; §6 → T7.
- Shared names: `packPackages` (T1 → T2, T4); `cli-smoke.ts` flags `--via`, `--image`, `--gitlab`,
  `--serve-only` (T2 → T3, T4, T5); `recipes.test.ts` (T4 → T5, T6).
