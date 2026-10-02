# Benchmark-Driven Changes

This file is the canonical change log for Trebell changes that are made **because benchmark evidence exposed a weakness**.

It is intentionally separate from `benchmark.md`:

- `benchmark.md` records benchmark runs, results, comparisons, and conclusions.
- `benchmark_changes.md` records what we changed **because of those results**, why we changed it, and what improvement the change is expected to produce.

Every future benchmark-driven harness change should add an entry here before the next fresh external validation run.

## Entry format

Each entry records:

- **Trigger** — benchmark/task/evidence that exposed the problem.
- **Observed failure** — what Native or the benchmark rig actually did wrong.
- **Change** — the generic code/controller/transport change made.
- **Why** — the causal reasoning for the change.
- **Expected effect** — what should improve if the hypothesis is correct.
- **Validation** — local regression coverage and fresh external evidence status.
- **Commit** — commit containing the change.

---

# Harness behavior changes

## 2026-10-02 — Global constraint planning before persistent commits

**Trigger:** fresh Terminal-Bench 4.0 `production-planning` three-lane comparison.

**Observed failure:** Trebell Native reached only **16/20** verifier checks while spending **$0.23408033 API-equivalent**, versus Codex API at **16/20 / $0.077988845** and Codex OAuth at **18/20 / $0.11622938**. Native therefore cost about **3.001× Codex API** for the same verifier score and about **2.014× OAuth** while scoring worse. The Native trace showed that it spent dozens of turns constructing, checking, persisting, and repairing a candidate before proving the whole planning problem globally feasible. It also wrote persistent state before all acceptance-critical constraints and the objective had been validated together.

**Change:**

- Added a generic detector for constraint-heavy planning, scheduling, allocation, dispatch, routing, packing, solver, and optimization tasks.
- Added an early **global-constraint planning checkpoint** after three completed model turns.
- The checkpoint tells Native to encode authoritative hard constraints, derived quantities, and the objective together in one bounded local solver/search/check instead of manually repairing candidates across many turns.
- Updated the Native system prompt so global feasibility and any priority/optimality objective must be validated before persistent writeback or another hard-to-reverse side effect.
- Added terminal audit metadata for common persistent mutations, including SQL/writeback gateway operations, mutating HTTP requests, remote writes, publish/deploy/apply/destroy commands, and similar actions.
- Added a **global-constraint commit guard**: on a detected constraint-planning task, the first persistent/hard-to-reverse mutation is blocked until a successful non-mutating full-contract audit has run for the current staged revision.
- A new workspace edit invalidates that audit and requires a fresh pre-commit audit.
- Added benchmark strategy telemetry for planning checkpoints, blocked commits, and successful pre-commit audits.
- Tightened generic evidence batching/recovery behavior encountered during the same postmortem so repeated local probes do not consume many model turns while a global acceptance gap remains.

**Why:** the previous controller could become locally productive while still being globally wrong. Row counts, internally consistent tables, one repaired identifier, or one passing local check are not substitutes for whole-candidate feasibility. Allowing persistent state to be written before the global contract is proven also makes later recovery more expensive or impossible.

**Expected effect:**

- Fewer model turns spent manually repairing infeasible candidates.
- Lower repeated input/context and output-token cost.
- Earlier detection of impossible or suboptimal plans.
- Better coverage of hard constraints and priority/optimality objectives.
- No irreversible/persistent commit until the candidate has passed a complete pre-commit audit.
- Lower probability of spending recovery epochs fixing state that should never have been persisted.

**Validation:** current combined tree passes **187/187 Native-loop tests**, the combined Native system/session/strategy/Terminal-Bench gate **94/94**, and the full repository suite **1,272/1,272**. Harbor bundle SHA-256 after the combined change: `b7442a0808bc69b1a4b55fda90d156b8615be745a528466e5bf923f89cee0c1e`. Fresh external validation is **in progress** on unseen TB4 task `freight-dispatch-shift`; do not claim benchmark improvement until that run seals.

**Commit:** `a1579f5d Guard constraint planning before persistent commits`

---

## 2026-10-02 — Persistent deliverable detection recognizes plural output wording

**Trigger:** postmortem of the `freecad-spring-clip` benchmark and follow-up detector inspection.

**Observed failure:** the persistent-deliverable controller could miss natural wording such as a task that “saves two parametric files.” The action detector had already been generalized for inflected verbs, but the output noun matching still expected singular `file` in an important path.

**Change:** generalized the persistent-output detector to recognize plural `files` as well as singular `file`, with regression coverage.

**Why:** a production/deliverable controller is only useful if it reliably recognizes ordinary task wording. Missing a plural noun could silently disable the controller on artifact-producing tasks.

**Expected effect:** fewer false negatives in persistent-artifact detection, so Native starts producing and validating required deliverables earlier rather than spending the turn in open-ended discovery.

**Validation:** focused Native-loop validation passed after the change. The later fresh `production-planning` run showed the persistent-deliverable/controller path activating, but that run also exposed a separate global-planning inefficiency; this change alone is not evidence of better final benchmark quality.

**Commit:** `38369d03 Recognize plural persistent deliverables`

---

## 2026-10-02 — Deliverable pressure can coexist with source edits

**Trigger:** `freecad-spring-clip` benchmark postmortem.

**Observed failure:** Native completed **13 model turns / 21 tool calls** before infrastructure interruption but emitted zero persistent-deliverable checkpoints. The task explicitly required a generator script plus two persistent FCStd outputs. The old controller treated “workspace mutation requested” and “persistent artifact requested” as mutually exclusive, so ordinary write/edit wording disabled deliverable pressure.

**Change:** removed the false exclusivity. Persistent-deliverable pressure now activates whenever explicit output targets are detected, even when the same task also requires source/script edits.

**Why:** real software tasks frequently require both implementation work and a produced artifact. Treating those intents as exclusive suppressed the controller exactly when a generator/script had to create a deliverable.

**Expected effect:** artifact-producing tasks should start the actual production attempt sooner, while still allowing source edits needed to generate the artifact.

**Validation:** regression coverage proves deliverable checkpoints fire on mixed “write implementation + save outputs” tasks. The later fresh `production-planning` run provided external evidence that mixed edit + persistent-output pressure can activate, although that run did not establish overall efficiency improvement.

**Commit:** `44b9257f Let deliverable pressure coexist with edits`

---

## 2026-10-02 — Persistent deliverable progress controller

**Trigger:** first `cad-model` fresh benchmark attempt.

**Observed failure:** before Docker interrupted the lane, Native spent **46 model turns / 53 tools** mostly investigating image/toolchain setup and did not begin the concrete FreeCAD installation until its final tool call. Telemetry showed `workspaceMutationRequested=false`, so code-edit implementation pressure never activated even though the task required a persistent generated deliverable.

**Change:**

- Added explicit persistent-artifact target detection.
- Added a production checkpoint after four model turns.
- Added a stronger deliverable escalation after eight model turns.
- Added strategy telemetry for those checkpoints.

**Why:** “make/save/export a file” is a different progress signal from “edit repository source.” A harness can waste the whole budget researching how to make an artifact without ever attempting to create it.

**Expected effect:** earlier toolchain establishment and earlier provisional artifact creation, leaving more budget for measurement/refinement instead of discovery.

**Validation:** strong local regression coverage. The next external task, `freecad-spring-clip`, exposed a detector interaction that led to the follow-up `44b9257f` and `38369d03` fixes rather than validating the original implementation unchanged.

**Commit:** `5bc32116 Nudge persistent deliverables toward production`

---

## 2026-10-02 — Active OpenAI WebSocket turns use inactivity timeout

**Trigger:** long-running benchmark/provider turns where healthy streaming could outlive the previous absolute request wall timeout.

**Observed failure:** an otherwise healthy OpenAI Responses WebSocket turn could be terminated merely because total elapsed request time crossed the configured timeout, even while the socket continued making progress.

**Change:** changed the active WebSocket timeout semantics from an absolute request wall limit to an **inactivity timeout that resets on progress**.

**Why:** benchmark tasks can legitimately have long max-reasoning turns. Killing an active turn because it is long creates artificial failures, retries, and wasted tokens that are transport behavior rather than model/harness quality.

**Expected effect:** fewer false provider timeouts and retries, less paid work discarded, and cleaner benchmark evidence for long reasoning turns.

**Validation:** provider-manager regression tests cover healthy streams outliving the old timeout and idle streams still timing out. Later benchmark runs completed long Native turns without the old absolute-timeout behavior.

**Commit:** `75dd2c60 Let active OpenAI WebSocket turns run past idle timeout`

---

## 2026-10-02 — Abstraction-repair verification is opt-in

**Trigger:** fresh `interleaved-vigenere` diagnostic comparison.

**Observed failure:** Native was much cheaper and structurally more complete than the Codex lanes but still failed the cryptanalytic core. Event analysis showed the generic post-edit controller automatically entered a parser/layout-style “abstraction repair” mode after repeated evidence rounds. This produced **15 abstraction-repair verification gates** even though the task was cryptanalysis, not a parser/layout reconstruction problem.

**Change:** strict abstraction-repair verification is now opt-in instead of automatically becoming mandatory from generic repeated evidence. Generic assumption-audit behavior remains available.

**Why:** a generic controller was imposing a specialized failure model on unrelated tasks. That creates unnecessary model turns and can actively steer reasoning toward the wrong hypothesis family.

**Expected effect:** fewer controller-induced reasoning spirals, lower token use, and less risk of forcing unrelated tasks into parser/layout/abstraction explanations.

**Validation:** local Native-loop tests passed. A later `cad-model` partial trajectory showed **zero** abstraction-repair verification gates before infrastructure interruption, which is useful external behavioral evidence but not a correctness win.

**Commit:** `6f687f5a Make abstraction repair verification opt in`

---

## 2026-10-02 — Recovery guidance made task-agnostic

**Trigger:** `interleaved-vigenere` postmortem alongside the abstraction-repair controller issue.

**Observed failure:** recovery wording contained assumptions that were too specific to parser/layout/source-reconstruction failure modes, which could bias unrelated tasks toward the same diagnosis.

**Change:** generalized Native recovery guidance so it asks for evidence against the earliest shared assumption without presuming that the relevant abstraction is a parser, decoder, adapter, mapper, layout, or similar implementation layer.

**Why:** recovery prompts should narrow uncertainty from evidence, not inject a preferred failure ontology.

**Expected effect:** more task-appropriate recovery hypotheses and fewer wasted turns pursuing a controller-suggested explanation unsupported by the task.

**Validation:** focused Native-loop regression coverage passed. Later benchmark traces did not reproduce the original forced abstraction-verification spiral.

**Commit:** `37f26ec2 Generalize Native recovery guidance`

---

# Benchmark infrastructure changes

These changes do not directly make Trebell Native smarter. They make benchmark evidence more trustworthy and prevent expensive paid trajectories from being misclassified or replayed.

## 2026-10-02 — Classify mid-run Docker exec transport failures

**Trigger:** fresh `cad-model` attempt where all lanes were hit by Docker Desktop `/exec/<container>/json` 5xx transport failures.

**Observed failure:** infrastructure transport failure could otherwise look like an agent/task failure.

**Change:** added explicit Docker exec transport-failure classification and pair-report infrastructure metadata.

**Why:** correctness/cost conclusions must not be drawn from a lane that was severed by Docker Desktop.

**Expected effect:** fewer false benchmark conclusions and clearer separation of harness/model failures from infrastructure failures.

**Validation:** Terminal-Bench runner regression coverage.

**Commit:** `30ecf569 Classify mid-run Docker benchmark failures`

---

## 2026-10-02 — Retry only safe pre-agent Docker image-pull EOFs

**Trigger:** first `freecad-spring-clip` launch failed in all lanes before any model inference because Docker image extraction returned `unexpected EOF`.

**Observed failure:** a purely pre-agent transient image-pull problem invalidated a fresh benchmark without consuming model tokens.

**Change:** added a narrow one-shot retry for Docker image pull/extraction `unexpected EOF` **only when no agent phase has started**.

**Why:** retrying before any paid trajectory is safe; replaying a lane after model work has started would distort cost and may duplicate side effects.

**Expected effect:** transient image-pull failures no longer waste fresh benchmark opportunities while preserving cost integrity.

**Validation:** Terminal-Bench runner tests cover the pre-agent-only retry boundary.

**Commit:** `f6e45cf4 Retry transient Docker image pulls`

---

## 2026-10-02 — Classify post-agent verifier image-pull failures without replay

**Trigger:** evidence-bearing `freecad-spring-clip` run where Codex agent phases completed, then verifier image extraction failed with `unexpected EOF`.

**Observed failure:** completed paid trajectories were left without verifier results because verifier infrastructure failed after agent work.

**Change:** classify verifier image-pull EOFs as infrastructure failures but do **not** automatically rerun the paid agent trajectory. Existing completed artifacts can instead be regraded verifier-only when possible.

**Why:** repeating an already-paid agent run would contaminate cost comparison. Regrading the saved artifact preserves the original trajectory.

**Expected effect:** recover more valid correctness evidence without paying for or replaying model inference.

**Validation:** both completed Codex spring-clip artifacts were successfully regraded later with no additional model inference.

**Commit:** `0f479f49 Classify verifier image pull failures`

---

# Active validation

## `freight-dispatch-shift` — fresh post-`a1579f5d` validation

- Dataset: `terminal-bench/terminal-bench@4.0.0`
- Task: `terminal-bench/freight-dispatch-shift`
- Model: `gpt-6-luna`
- Reasoning: `max`
- Lanes: Trebell Native API, Codex API, Codex OAuth
- Execution: parallel
- Agent timeout multiplier: `1` (base timeout)
- Source commit: `a1579f5d`
- Pair: `tb4-pair-gpt-6-luna-max-freight-dispatch-shift-20261002T090308Z`
- Status: **running**

The purpose of this run is to test whether the new constraint-planning behavior improves the combination that actually matters: **correctness first, then total API-equivalent cost**, with particular attention to Native model-turn count, repeated context/token growth, global-constraint checkpoint telemetry, persistent-commit guard telemetry, and verifier outcome.

Do not update this entry with a claimed improvement until the three lanes seal and the verifier results are available.
