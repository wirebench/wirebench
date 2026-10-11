# Branching in sequences — design

Issue: #347. Builds on sequences (`2026-09-28-sequences-design.md`), which left loops, branches and retries out of
scope. This adds them, with a new sequence file `version`.

## Goal

A step can, depending on its response, **go to** a named step, **skip the next** step, or **repeat** itself, with a
counter and a maximum. That covers polling until something is ready, branching to a fallback on an error, and
skipping a step that does not apply. Every loop has a maximum that cannot be turned off, and the run panel and the
CLI reports show which path a run took.

## Decisions (owner, 2026-10-11)

1. A condition **reuses the step checks**: `status`, `header`, `match` (XPath, XQuery, JSONPath) and `soap-fault`,
   plus a new `outcome` check so a send error can branch too. No expression language.
2. A loop that reaches its maximum **carries on**: the rule stops firing, the run continues as if it had not
   matched, and the last attempt's own outcome stands. The report says the limit was reached.
3. **Only the last run of each step counts** towards the run's outcome. Earlier runs are shown, marked *retried*.
4. A branch that fires **wins over** *Stop on first failure*. With no branch firing, stop-on-failure applies as
   before.

## File format

```yaml
kind: sequence
version: 2            # 2 only when a step has branches; a sequence without any is still written as 1
steps:
  - id: 01JB…A1
    name: Poll the job
    request: 01J9…
    assertions:
      - type: match
        language: jsonpath
        expression: $.state
        equals: done
    branches:
      - when: { type: match, language: jsonpath, expression: $.state, equals: done, not: true }
        then: repeat
        max: 10
        delayMs: 2000
      - when: { type: outcome, equals: errored }
        then: goto
        step: 01JB…A4
        max: 1
  - id: 01JB…A2
    request: 01J9…
    branches:
      - when: { type: status, equals: 404 }
        then: skip-next
```

| Field | Meaning |
|---|---|
| `branches[]` | Optional, at most 20 per step. Evaluated in order after the step's transfers and assertions; the first rule whose condition holds and whose limit is not reached fires. |
| `when` | One check: `status`, `header`, `match`, `soap-fault` (the step-assertion shapes), or `outcome` with `equals: passed \| failed \| errored` or a list of them. `not: true` inverts it. |
| `then` | `goto`, `repeat` or `skip-next`. |
| `step` | `goto` only: the target step's `id` in the same sequence (the step itself is allowed). A target that does not exist makes the file invalid. |
| `max` | Required for `goto` and `repeat`, 1–100: how many times this rule may fire in one run. Not allowed on `skip-next`, which cannot loop. |
| `delayMs` | Optional for `goto` and `repeat`, 0–60000: a wait before the jump. Cancel ends it at once. |

- **When a condition holds.** A check condition holds when the same check as an assertion would *pass*. A check
  that errors (a JSONPath over an XML body) does not hold; the branch result says why. For a step that got no
  response (errored before or during the send) only an `outcome` condition can hold.
- **A disabled step** never runs its branches. A cancelled run takes no branch.
- **Run limit.** On top of every rule's `max`, one run executes at most 1000 step runs (`SEQUENCE_LIMITS.stepRuns`),
  which is what bounds nested loops. Reaching it errors the next step with `sequence-run-limit` and ends the run.

### Versions and older builds

`SEQUENCE_VERSION` becomes **2**, the highest this build reads. `sequenceDocument` writes `version: 2` only when some
step has branches, so a sequence without branches stays readable by older builds. An older build refuses a
`version: 2` file with `sequence-version-too-new`, shows it as a project problem and leaves the file as it is on
every save (`sequence/load.ts`): it never drops a step or a branch silently. No project `formatVersion` bump, for the
reason the sequences spec gives.

`docs-site/public/schemas/v9/sequence.schema.json` is regenerated (`pnpm schemas:project`): `version` is `1 | 2`
and steps gain `branches`.

## Running

`runSequence` walks the steps with a cursor instead of a `for` loop.

1. A step runs as today (send, transfers, assertions), then its branches are evaluated.
2. `repeat` runs the same step again. `goto` continues at the target. `skip-next` reports the next step as
   `skipped` with reason `branch` and continues after it. A forward `goto` reports the steps it jumps over as
   `skipped` / `branch`. A rule whose `max` is reached is passed over and recorded as `limitReached`.
3. With no branch firing, the run goes on to the next step, or stops on a failure under stop-on-failure.
4. The run's outcome is the worst over the **last** result of each step. Every earlier result of a step that ran
   again is marked `retried: true` in the final `steps` list (a `repeat` is marked as it is emitted, since it is
   certain to run again).

`SequenceStepResult` gains, all optional so existing consumers read it unchanged:

```ts
attempt?: number;        // 2, 3, … for the second and later run of the same step
retried?: true;          // a later run of this step superseded this one; it does not count
branch?: {
  rule: number;          // 0-based index in the step's branches
  action: 'goto' | 'repeat' | 'skip-next';
  to?: { index: number; stepId: string; name: string };   // goto and repeat
  count: number;         // how many times this rule has fired, this one included
  max?: number;
  limitReached?: true;   // matched, but at its max: not taken
};
skipped?: … | 'branch';  // jumped over by a goto or skip-next
```

`ResolvedStep` gains `attempt`, so a host can name each send uniquely.

## Reports

- **CLI reporter**: the step line gets a suffix — `→ repeat (2 of 10)`, `→ 4. Fallback login`, `→ skip next`,
  `limit reached: repeat 10 of 10`. From the second attempt on, a step's path is `<seq>/<n>. <step> (attempt k)`.
- **Outcome and exit code**: a retried attempt is reported with outcome `skipped` and `retried: true`, keeping its
  assertions, so summaries, JUnit and the exit code count only the last run of each step.
- **JSON**: optional `branch`, `attempt` and `retried` on a step entry; additive, `formatVersion` stays 1.
- **HTML**: one "Path" line per step that took a branch.

## Desktop

- **Editor**: the selected step shows a **Branches** list under Assertions. A row: the condition (type select,
  then the check's own fields, reusing the assertion widgets, and a *not* checkbox), the action select, a target
  step select for *go to*, *max* and *delay* inputs. *Add branch* adds `status 503 → repeat, max 5`. Removing a step
  removes the rules that targeted it, in the same `update-sequence`.
- **Wire**: `sequenceStepWireSchema` gains `branches`; `sequenceStepResultWireSchema` gains `attempt`, `retried`,
  `branch` and the `branch` skip reason.
- **Run panel**: the run's results are an ordered list, not one row per step index, so a repeated step shows each
  attempt. A row shows `attempt k`, a muted *retried* mark, and a line naming the path taken.
- **Sends**: a step's send id becomes `<runId>:<index>:<attempt>`, so each attempt has its own HTTP Log row.

## Not in scope

Branching on transferred values or a script, an *end the run* action, conditions combining several checks
(`and`/`or`), and anything data-driven runs (#336) add beyond running a sequence inside one iteration.
