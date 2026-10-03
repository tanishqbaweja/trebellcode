# Trebell Code — Benchmark Results

Trebell Native is built around one objective:

> **Get the same or better verified software-engineering result at lower model cost.**

This page reports verifier-grounded benchmark results that demonstrate Trebell Native's quality-per-dollar objective in practice.

## What counts as a win

- The task and comparison model must be held constant within the comparison.
- Reasoning/thinking settings must be equivalent where the model exposes them.
- Quality is determined by an independent verifier, not by the agent claiming success.
- **Same verifier result at lower total cost counts as an efficiency win even when neither harness fully solves the task.**
- Better quality at lower cost is a strict win.
- Lower cost with worse verifier quality does **not** count as a win.
- Infrastructure-invalid or capability-incomparable runs are not used as headline evidence.

This matters because token count alone is not the product metric. Different input/output mixes, retries, recovery loops, and cache behavior can make a lower-token run more expensive. Trebell optimizes for **verified result per dollar**.

## Results

### coq-block-bound — full-quality parity, lower cost

Terminal-Bench 4.0, GPT-6 Luna, max reasoning.

| Harness | Verifier | Reward | Input tokens | Output tokens | API-equivalent cost | Agent time |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| **Trebell Native** | **4 / 4** | **1.0** | **27,508,990** | **176,935** | **$0.40734** | **31.5 min** |
| Codex API | **4 / 4** | **1.0** | 36,833,744 | 251,050 | $0.57020 | 53.0 min |

**Result:** identical full verifier quality, while Trebell Native used **25.3% less input**, **29.5% less output**, **40.6% less agent time**, and cost **28.6% less**.

The original Native lane was interrupted by an API rate-limit error. The counted Native result is an unchanged infrastructure recovery rerun using the same source tree, Native bundle, model, reasoning effort, and task configuration.

---

### ctr-optimization — same failure surface, dramatically lower spend

Terminal-Bench 4.0 three-lane comparison.

| Harness | Verifier | Reward | API-equivalent cost |
| --- | ---: | ---: | ---: |
| **Trebell Native** | **3 / 4** | **0** | **$0.06461** |
| Codex OAuth | **3 / 4** | **0** | $0.33187 |
| Codex API | **3 / 4** | **0** | $0.69725 |

All three lanes failed the **same core CTR threshold** and ended at the same 3/4 verifier result.

**Result:** same verified outcome, with Trebell Native costing **80.5% less than Codex OAuth** and **90.7% less than Codex API**.

This is exactly why Trebell does not treat reward 0 as automatically useless benchmark evidence. When competing harnesses reach the same independently verified outcome, the amount of model spend required to get there is itself a meaningful harness metric.

The task was later inspected during post-run diagnosis and is therefore not reused as fresh benchmark evidence.

## Additional efficiency results

These runs are useful demonstrations of harness efficiency on already-inspected tasks. They are **not** presented as fresh unseen generalization evidence.

### shadow-relay — same perfect result with much less model traffic

| Harness | Verifier | Reward | Input tokens | Uncached input | Output tokens | Agent time |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| **Trebell Native** | **8 / 8** | **1.0** | **19,600,672** | **426,159** | **345,262** | **49.8 min** |
| Codex API | **8 / 8** | **1.0** | 58,166,154 | 1,095,403 | 448,838 | 157.2 min |

**Result:** identical perfect verifier quality, while Trebell Native used **66.3% less raw input**, **61.1% less uncached input**, **23.1% less output**, and **68.3% less agent execution time**.

The Native cache-hit percentage was actually slightly lower than Codex API's, so the traffic reduction did not come from simply reporting a better cache ratio.

### pretrain-shard-corruption — same partial quality with a much leaner recovery

After a generic completion-blocker recovery fix, the Native causal rerun reached the same **7 / 12** verifier score as the comparison OAuth artifact.

| Harness | Verifier | Input tokens | Uncached input | Output tokens | Agent time |
| --- | ---: | ---: | ---: | ---: | ---: |
| **Trebell Native** | **7 / 12** | **218,052** | **47,182** | **27,124** | **339.6 s** |
| Codex OAuth | **7 / 12** | 1,122,779 | 72,155 | 27,910 | 627.6 s |

**Result:** same verifier quality with **80.6% less raw input**, **34.6% less uncached input**, **2.8% less output**, and **45.9% less agent time**.

This is a same-task causal diagnostic, not an unseen-task claim.

## Why these comparisons matter

A coding harness can waste money even when the underlying model is strong. The largest cost drivers often live above the model:

- repeated context growth;
- poor prompt-cache continuity;
- oversized eager tool schemas;
- unnecessary reasoning turns;
- repeated evidence collection;
- recovery that attacks downstream symptoms instead of upstream causes;
- continuing to edit after acceptance evidence is already green;
- failing to preserve a known-good incumbent;
- retrying work that could have been deterministically reused.

Trebell Native owns those layers. That is where the optimization work happens.

The long-term benchmark target is simple:

> **For the same model and task, Trebell should match or beat mature coding harnesses while spending less to reach the verified result.**

As new benchmark results are sealed, this page should stay focused on clear product-level comparisons rather than raw development logs.
