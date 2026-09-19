# Wirebench GitHub Action

Runs a Wirebench project's requests and fails the step on a red assertion.

```yaml
- uses: wirebench/wirebench/action@v2.3.0
  with:
    project: ./api-tests
    env: staging
    junit: reports/wirebench.xml
  env:
    WIREBENCH_SECRET_BILLING_PASSWORD: ${{ secrets.BILLING_PASSWORD }}
```

Secrets are the caller's: map each one to `WIREBENCH_SECRET_<NAME>` in `env:`, the way any other
step's environment is set. The action never asks for or stores a secret itself; the runner's own
masking hides the value.

## Inputs

| Input                | Default                                                                                 | Maps to                                    |
| -------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------ |
| `project`            | _(required)_                                                                            | `<path>`                                   |
| `env`                | —                                                                                       | `--env`                                    |
| `select`             | —                                                                                       | selectors, one per line                    |
| `vars`               | —                                                                                       | `--var`, one `key=value` per line          |
| `junit`              | —                                                                                       | `--reporter junit=<path>`                  |
| `json`               | —                                                                                       | `--reporter json=<path>`                   |
| `html`               | —                                                                                       | `--reporter html=<path>`                   |
| `bail`               | `false`                                                                                 | `--bail`                                   |
| `require-assertions` | `false`                                                                                 | `--require-assertions`                     |
| `insecure`           | `false`                                                                                 | `--insecure`                               |
| `timeout`            | —                                                                                       | `--timeout`                                |
| `sla`                | —                                                                                       | `--sla`                                    |
| `version`            | this action's own ref when it is a version tag (e.g. `v2.3.0` → `2.3.0`), else `latest` | the `@wirebench/cli` version run via `npx` |
| `node-version`       | `24`                                                                                    | `actions/setup-node`                       |

## Output

| Output      | Value                                                                                                                                                                                                                                                                                         |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `exit-code` | The `wirebench` CLI's exit code: `0` pass, `1` an assertion failed, `2` a usage error, `3` a required secret was missing. A non-zero code fails the step; a caller that wants to keep going and branch on the result adds `continue-on-error: true` and reads `steps.<id>.outputs.exit-code`. |

## Node 24 as a side effect

The action's first step is `actions/setup-node@v7` with `node-version` (default `24`). This
changes which `node` later steps in the same job see — hosted runners default to an older Node,
and `@wirebench/cli` needs 24. Pin `node-version` on the action if a later step in the job needs a
different Node version, or run this action in a job of its own.
