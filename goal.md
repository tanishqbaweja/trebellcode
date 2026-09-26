# Trebell Code — Product and Architecture Goal

> This document defines what Trebell Code is ultimately trying to become.
>
> It is a product/architecture north star, not a point-in-time implementation checklist. A capability belongs here when it is part of the desired final product whether it is already implemented, partially implemented, or still missing.
>
> Last major feature audit: 2026-09-25, against the current generation of frontier coding models and agent harnesses.

## 1. North Star

Trebell Code should become a **fast, trustworthy, provider-independent agentic software-engineering platform**.

It should not be merely:

- a chat UI around an API,
- a launcher for other coding CLIs,
- a collection of competitor features,
- or a model that has been given shell access.

Trebell should provide a coherent engineering environment in which strong models can understand a repository, use deterministic tools, edit and validate software, operate browsers and computers when needed, work safely for long periods, recover from failures, collaborate with other agents when useful, and leave behind evidence that lets a human understand and trust the result.

The core product idea is:

```text
                    TREBELL PLATFORM
                           │
         ┌─────────────────┼─────────────────┐
         │                 │                 │
  Repository/Context   Tools/Policy     State/Trace
     Intelligence       & Safety       & Verification
         │                 │                 │
         └─────────────────┼─────────────────┘
                           │
                    Runtime Adapters
                           │
      ┌──────────┬─────────┼──────────┬───────────┐
      │          │         │          │           │
    Codex      Claude   OpenCode     ACP      Trebell Native
                                      │
                               Cursor / Grok /
                                Antigravity /
                                 future agents
```

External harnesses should retain the things they do well while gaining Trebell-owned capabilities where their APIs permit it.

Trebell Native should eventually use the same shared platform while owning the complete model/tool loop.

The strongest version of Trebell is therefore not:

> one more coding agent.

It is:

> a durable engineering platform whose intelligence, tools, safety, persistence, observability and verification improve whichever capable model or harness is running inside it.

---

## 2. Design for Modern Models, Not 2024 Models

Harness assumptions age quickly. Trebell must be designed so that improvements in models remove unnecessary scaffolding rather than making old scaffolding permanent.

As of the 2026 generation, frontier models can already:

- reason for long periods,
- navigate large repositories,
- use very large context windows,
- call tools reliably,
- operate browsers/computers,
- perform meaningful self-verification,
- respond to mid-turn steering,
- use asynchronous tools,
- delegate work to subagents,
- maintain long-horizon objectives,
- and recover from many ordinary implementation mistakes without a separate planner or reviewer model.

This changes what Trebell should build.

### 2.1 What the harness should still own

Model intelligence does **not** eliminate the need for:

- reliable repository access,
- context selection and retrieval,
- deterministic code intelligence,
- tool execution,
- state and persistence,
- sandboxing,
- permissions,
- secret handling,
- side-effect control,
- source control,
- process/environment isolation,
- crash recovery,
- verification,
- performance,
- cost/usage accounting,
- observability,
- and a good user interface.

These are engineering-system problems, not reasoning problems.

### 2.2 Patterns Trebell should not ossify

Do **not** make the following mandatory parts of the architecture:

- a separate planner model before every task,
- a separate executor model after every plan,
- fixed Explorer/Planner/Coder/Reviewer fleets for ordinary work,
- automatic reviewer-model calls after every implementation,
- automatic Best-of-N/model tournaments,
- automatic swarms for routine tasks,
- giant system prompts that explain obvious software-engineering behavior,
- huge monolithic AGENTS.md/CLAUDE.md files,
- eager injection of the entire repository,
- forced patch-only editing,
- mandatory embeddings for repository understanding,
- continuous LLM-generated RepoWiki regeneration,
- brittle heuristics that override a capable model's judgment,
- or a hardcoded model router that claims to know the best model without evidence.

If a modern model can make a decision itself from good tools and good context, Trebell should generally provide the capability and boundary rather than micromanage the reasoning.

### 2.3 The durable rule

Before adding harness intelligence, ask:

```text
Is this solving a real environment/control problem?

or

Is this compensating for something modern models can now reliably do themselves?
```

Prefer durable platform capabilities over model-era prompt tricks.

---

## 3. Product Principles

### 3.1 Real functionality only

Every control, setting, tool and status shown in the UI must map to actual behavior.

No:

- fake toggles,
- fake tools,
- placeholder buttons,
- hardcoded demo state presented as real state,
- or capability labels that the selected runtime cannot actually honor.

If a feature is unsupported by the selected runtime, hide it or explain the limitation honestly.

### 3.2 Capability-driven, not runtime-name-driven

Do not scatter logic such as:

```js
runtime === "codex"
```

through the product when the real question is:

```text
Does this runtime support steering?
Does it support native compaction?
Can Trebell inject MCP?
Can Trebell intercept tool permissions?
```

Runtimes must advertise capabilities and Trebell must adapt to them.

### 3.3 Reuse strengths instead of replacing them

If Codex already has a strong sandbox, use it.

If OpenCode has usable native LSP support, adapt it.

If Claude exposes a good compaction mechanism, do not build a second compactor merely for symmetry.

If an external runtime cannot provide a capability or Trebell needs stronger guarantees, Trebell supplies a fallback.

### 3.4 Failure must not masquerade as absence or success

Examples:

```text
refresh failed
→ preserve last-known-good state
→ show the failure

checkpoint failed
→ continue the turn if safe
→ explain that rollback protection degraded

background request may already have started
→ mark uncertainty
→ do not encourage a blind duplicate retry

bootstrap failed
→ show startup failure
→ do not fabricate an empty workspace

Thread B supplemental state failed to load
→ never leave Thread A data displayed as B's
```

### 3.5 Deterministic engineering before additional inference

Prefer:

- compiler diagnostics,
- LSP,
- AST/symbol information,
- targeted tests,
- file hashes,
- dependency graphs,
- browser console/network evidence,
- git history,
- and structured state

before spending another model call to rediscover the same facts.

### 3.6 Human attention is the scarce resource

Trebell should reduce:

- needless approvals,
- repeated explanations,
- manual context gathering,
- repeated environment setup,
- polling noise,
- UI clutter,
- and unhelpful confirmation steps.

But reducing friction must never mean hiding meaningful risk.

---

## 4. Runtime Architecture

Trebell should support two complementary execution models.

### 4.1 External harness mode

Supported harnesses may include:

- OpenAI Codex,
- Claude Code,
- OpenCode,
- Cursor,
- Grok Build,
- Antigravity,
- and future ACP/MCP-compatible agents.

The external harness continues to own whichever internal behavior it exposes best.

Trebell should augment it with shared capabilities where possible:

- repository context,
- code intelligence,
- project knowledge,
- Trebell tools,
- source control,
- browser/computer tools,
- policy/permissions,
- checkpoints,
- tracing,
- cost/usage tracking,
- verification,
- and Trebell persistence.

The integration mechanism may differ by runtime:

- MCP injection,
- SDK tools,
- dynamic tools,
- system/additional context,
- client filesystem APIs,
- client terminal APIs,
- permission callbacks,
- runtime-native extensions,
- or whole-process containment.

### 4.2 Trebell Native

Trebell Native should be a first-class runtime in which Trebell owns:

- context assembly,
- provider requests,
- conversation state,
- tool definitions,
- tool execution,
- policy decisions,
- async tool lifecycle,
- steering,
- retries,
- compaction/continuation,
- checkpoints,
- verification,
- usage accounting,
- event recording,
- and completion semantics.

It must reuse the same platform services external runtimes use.

Conceptually:

```text
user goal
   ↓
assemble useful context
   ↓
call model
   ↓
model chooses action/tool(s)
   ↓
policy checks side effects
   ↓
tool executes
   ↓
observation is sanitized + recorded
   ↓
model continues
   ↓
verification / completion evidence
   ↓
finished result
```

Do not build Trebell Native as a separate monolith with duplicate browser, git, context, policy or persistence systems.

### 4.3 Runtime capability contract

Each runtime should advertise capabilities such as:

```text
queue
steering
fork
rewind
compaction
delegation
collaboration
background/detached tasks
multi-model fan-out

MCP injection
system-context injection
dynamic tools
client filesystem
client terminal

native LSP
native sandbox
permission interception

usage reporting
context reporting
native history pagination
runtime/profile switching
```

The UI and backend should operate from these capabilities rather than hardcoded product names.

---

## 5. Trebell Context Engine

The Context Engine is a core Trebell capability.

Even with million-token context windows, context is not free or harmless:

- very large prompts cost more,
- long prompts can dilute relevance,
- tool schemas and history consume context,
- stale instructions can mislead,
- and loading information before it is needed can be worse than retrieving it just in time.

The goal is therefore **not** to maximize context.

The goal is:

> provide the smallest high-value set of repository facts that helps the model orient itself quickly, then let it retrieve more detail with tools.

### 5.1 Hybrid context strategy

Use a hybrid approach:

1. inject small, high-confidence orientation/context,
2. expose excellent just-in-time retrieval tools,
3. allow the model to explore when necessary,
4. keep context bounded,
5. preserve useful cache prefixes where providers support prompt caching.

Do not aggressively curate every token to the point that the model loses autonomy.

### 5.2 Repository indexing

The Context Engine should understand:

- repository files,
- ignored/generated/vendor directories,
- languages,
- modules/packages,
- source vs test files,
- build/configuration files,
- repository instructions,
- current Git state,
- recent changes,
- and remote workspace equivalents.

Index incrementally.

Do not re-read/reparse an unchanged repository on every turn.

Cache by:

- file identity,
- content hash/version,
- Git revision,
- parser version,
- and relevant configuration.

### 5.3 Structural repository map

Maintain a lightweight repo map covering useful relationships such as:

```text
file → imports file
file → exports symbol
symbol → defined in file
symbol → referenced by file
function → calls function
class → implements interface
test → relates to module
package → depends on package
```

Structural importance can use techniques such as:

- reference counts,
- import/export relationships,
- graph centrality/PageRank-like ranking,
- task-term matches,
- explicit user focus,
- current diff proximity,
- recently changed files,
- test relationships,
- and language-server evidence.

The map is a retrieval aid, not a replacement for reading real source.

### 5.4 Real parsers where they add value

Regex symbol extraction is useful as a fallback, but the mature Context Engine should prefer reliable parsers where practical:

- Tree-sitter,
- compiler/parser APIs,
- language servers,
- or language-native metadata.

Use graceful fallback for unsupported languages rather than making indexing brittle.

### 5.5 Just-in-time retrieval tools

Models should be able to request:

- exact text search,
- regex search,
- file search,
- symbol search,
- definitions,
- references,
- importers/imports,
- callers/callees,
- related tests,
- current diff,
- Git history/blame when useful,
- and full source ranges.

The model should not need another agent merely to discover these facts.

### 5.6 Repository instructions

Support scoped instructions such as:

- AGENTS.md,
- CLAUDE.md,
- project-specific Trebell guidance,
- nested directory guidance,
- and future standardized instruction files.

Use progressive disclosure.

A small root instruction file should act more like a map than a 1,000-page manual.

Nested guidance should override broader guidance only within its scope.

### 5.7 Context pressure management

Context selection should understand:

- model context window,
- response reserve,
- recent conversation size,
- tool schema cost,
- injected project instructions,
- cached-prefix behavior,
- attachments,
- and runtime-owned context that may be opaque.

When pressure is high, degrade intelligently:

- reduce pre-injected repository excerpts,
- keep high-value instructions,
- retain current task/decisions,
- rely more heavily on just-in-time tools,
- and preserve enough output budget for the model to finish.

### 5.8 Context Inspector

Trebell should make its own context decisions inspectable.

Show:

- selected files,
- why each was selected,
- symbols/relations involved,
- approximate token cost,
- project instructions included,
- current budget,
- cache/index reuse,
- and exact Trebell-injected context when safe.

For external harnesses, clearly distinguish:

```text
Trebell-supplied context
vs
runtime-private/opaque context
```

Never pretend to see internal context the runtime does not expose.

---

## 6. Language Intelligence and Semantic Tools

Strong models can edit code without an IDE, but deterministic language intelligence remains highly valuable.

Trebell should provide a shared language-intelligence layer for operations where deterministic tools are more reliable than model inference.

### 6.1 LSP/compiler integration

Support useful language servers/compiler APIs such as:

- TypeScript language services,
- Pyright,
- rust-analyzer,
- clangd,
- jdtls,
- Go tooling,
- and equivalents where worthwhile.

Capabilities should include:

- diagnostics,
- definition lookup,
- references,
- workspace/document symbols,
- rename,
- code actions,
- import organization,
- call hierarchy,
- type information,
- and semantic refactor operations.

### 6.2 Adaptive reuse

If a runtime already provides strong native LSP support, Trebell may adapt that instead of launching a duplicate server.

If not, use Trebell's service.

### 6.3 Do not force semantic tools unnecessarily

The model should be free to use:

- patching,
- file replacement,
- shell scripts,
- semantic rename,
- codemods,
- or other editing mechanisms

according to the task.

Trebell should provide reliable editing primitives rather than mandate one editing ideology.

---

## 7. Unified Tool Platform

Agent tools should be backend/platform capabilities, not React implementation details.

### 7.1 Trebell Tool Registry/Gateway

Maintain a shared registry for capabilities such as:

```text
filesystem
search
repository intelligence
language intelligence
editing
shell/processes
git
source control
browser
computer use
devices
previews
verification
knowledge
MCP/apps/plugins
```

Each tool should define:

- input/output schema,
- permissions,
- risk level,
- reversibility,
- idempotence where known,
- external side effects,
- workspace/environment requirements,
- network requirements,
- desktop requirements,
- timeout/cancellation behavior,
- and whether it is safe to run asynchronously.

### 7.2 Multiple adapters, one implementation

Expose shared Trebell tools through the best mechanism for each runtime:

```text
Trebell Native → direct invocation
Codex          → dynamic/custom tools and/or MCP
Claude         → Agent SDK/MCP
OpenCode       → MCP/native integration
ACP agents     → injected MCP + client capabilities
```

Fixing a Trebell tool should benefit every runtime that consumes it.

### 7.3 Lazy capability exposure

Do not dump every installed tool/MCP schema into every model request.

Use capability groups, discovery and progressive disclosure.

Examples:

- normal code task: file/search/edit/shell/diagnostics,
- browser task: add browser tools,
- source-control task: add forge/PR tools,
- specialized plugin: load when relevant.

This reduces:

- context cost,
- model choice overload,
- security surface,
- and tool-selection ambiguity.

---

## 8. Trebell Intelligence MCP

Trebell should expose its shared intelligence as an MCP surface so external harnesses can consume it.

Potential tools/resources include:

```text
repo_map
search_code
symbol_search
definition
references
diagnostics
related_tests
project_knowledge
verify
git_context
```

This turns:

```text
Claude Code
OpenCode
Cursor
Grok
Antigravity
future ACP runtimes
```

from isolated harnesses into consumers of Trebell's shared platform.

An external harness should not lose its own strengths merely because it is running inside Trebell.

---

## 9. Provider and Model Layer

Trebell must separate:

```text
agent harness
from
model provider transport
```

A harness can be Trebell Native while the provider transport deliberately mimics another official client when an upstream requires that protocol identity.

### 9.1 Provider transport profiles

A provider profile may define:

- endpoint,
- wire API,
- headers,
- client fingerprint,
- authentication,
- model discovery,
- tool schema quirks,
- streaming event translation,
- retries/backoff,
- timeouts,
- usage extraction,
- and model capability metadata.

### 9.2 Protocol support

The platform should be able to normalize commonly encountered APIs such as:

- OpenAI Responses,
- OpenAI-compatible Chat Completions,
- Anthropic Messages,
- provider-specific derivatives,
- and future protocols as needed.

### 9.3 AgentRouter compatibility

AgentRouter requires Codex-like request identity/behavior for some routes and can fail (for example with HTTP 503) when that compatibility is missing.

Trebell must preserve this intentionally.

Conceptually:

```text
Trebell Native
      ↓
AgentRouter transport adapter
      ↓
Codex-compatible fingerprint/request shape
      ↓
AgentRouter
```

The provider fingerprint does not determine which harness owns the agent loop.

### 9.4 Provider credentials

Credentials must remain outside normal model-visible configuration wherever possible.

Support current and backward-compatible environment aliases when providers have accumulated naming variants.

Do not:

- print secrets,
- persist them in transcripts,
- write them into public configuration,
- or expose them through status APIs.

### 9.5 Model catalog and capabilities

Model metadata should describe factual capabilities where known:

- context window,
- max output,
- vision,
- tool/function calling,
- computer use,
- reasoning controls,
- async tools,
- streaming,
- protocol compatibility,
- caching,
- availability,
- pricing when reliable.

Do not claim a model is the universal "best" model for a task without evaluation evidence.

User selection remains first-class.

---

## 10. Long-Running Work and Goals

Modern models can work much longer than earlier generations, but long-running engineering still needs durable state.

### 10.1 Persistent goals

Support durable objectives that survive:

- many turns,
- context compaction,
- app restart,
- runtime restart,
- background execution,
- and handoffs.

A goal should describe:

- desired outcome,
- completion conditions,
- constraints,
- validation expectations,
- and optional budgets.

The goal is not a giant procedural plan.

The model should retain freedom to adjust its approach as it learns.

### 10.2 Durable task state

Persist useful facts such as:

- current objective,
- completed work,
- unresolved failures,
- important decisions,
- artifacts created,
- current branch/worktree,
- verification state,
- and pending next actions.

Do not rely on the chat transcript alone as the only continuity mechanism.

### 10.3 Compaction and continuation

Use runtime-native compaction when it is good.

For Trebell Native, support reliable context reduction that preserves:

- the goal,
- user constraints,
- architectural decisions,
- unresolved problems,
- important repository facts,
- and recent active work.

Raw old tool output should generally be easier to discard than decisions or constraints.

With large modern context windows, compact when it improves relevance/cost or is required by the limit—not according to assumptions inherited from small-context models.

### 10.4 Restart recovery

After a crash/restart, Trebell should know:

- which tasks were active,
- whether an external runtime session can resume,
- whether a tool/action may have completed,
- what state is uncertain,
- and whether an automatic continuation is safe.

Never duplicate an uncertain side effect merely to make recovery convenient.

---

## 11. Delegation and Multi-Agent Work

Delegation remains useful, but the architecture should match modern models.

### 11.1 Generic delegation primitive

Expose a capability roughly equivalent to:

```text
delegate(task, permissions, isolation, budget, context)
```

Let capable models decide when delegation adds value.

### 11.2 No mandatory specialist bureaucracy

Do not require every task to pass through:

```text
Planner → Explorer → Coder → Reviewer
```

Modern models can perform these cognitive roles themselves.

Optional presets/custom agents are fine when they provide real differences in:

- permissions,
- tools,
- model,
- environment,
- or domain configuration.

### 11.3 Isolation

Parallel coding workers should normally use:

- separate Git worktrees/branches,
- explicit ownership,
- bounded shared state,
- and clear merge/reconciliation behavior.

### 11.4 Budgets

Delegation should respect:

- token/cost limits,
- maximum child count,
- wall time,
- tool limits,
- and user settings.

No silent six-agent swarm because the model felt enthusiastic.

---

## 12. Policy, Permissions and Safety

As models become more capable, containment becomes **more** important because the potential blast radius increases.

Alignment is not a substitute for hard boundaries.

### 12.1 Unified policy engine

Trebell should normalize decisions into:

```text
ALLOW
CONFIRM
REJECT
```

Policy input may include:

- runtime,
- tool/action,
- permission profile,
- requested path/resource,
- workspace,
- network target,
- external side effects,
- reversibility,
- risk level,
- provenance/trust of triggering content,
- and user-defined rules.

Translate this into runtime-native approval mechanisms where possible.

### 12.2 Permission profiles

Useful high-level modes may include:

- Read Only,
- Workspace Write,
- Supervised,
- Auto/Guarded,
- Full Access,
- Isolated Environment.

The exact UI can evolve, but semantics must remain real and consistent.

### 12.3 Side-effect classification

Actions should carry metadata such as:

```text
externalSideEffect
reversible
idempotent
riskLevel
```

Examples:

```text
read source file
→ local, reversible/no mutation

apply source edit
→ local and checkpointable

git push
→ external side effect

publish package
→ external + hard to reverse

send message
→ external + potentially irreversible
```

### 12.4 Sandbox

Prefer real isolation:

- runtime-native sandbox when strong,
- OS sandbox,
- container/VM where appropriate,
- restricted filesystem/network policies,
- process containment.

A Git worktree is **not** a security sandbox.

### 12.5 Prompt-injection / untrusted-content handling

Web pages, issue text, tool output and repository content can contain instructions that conflict with the user's intent.

Trebell should:

- track provenance/trust where practical,
- mark externally sourced content as data,
- keep policy enforcement outside the model,
- prevent untrusted content from silently escalating permissions,
- and optionally use stronger injection detection for high-risk workflows.

Do not solve prompt injection solely by adding another giant warning prompt.

---

## 13. Secret Broker and Environment Hygiene

External CLIs must not automatically inherit every secret available to the Trebell parent process.

Build runtime environments from:

```text
safe OS baseline
+ required PATH/HOME/runtime values
+ credentials required by that runtime
+ explicitly approved user variables
```

### 13.1 Secret broker

Where feasible:

```text
tool needs credential
      ↓
Trebell supplies credential to tool/process
      ↓
tool performs action
      ↓
model receives sanitized result
```

The model does not need to see the secret just because a tool needs it.

### 13.2 Redaction

Sanitize secrets from:

- tool results,
- stderr/stdout persisted in traces,
- provider errors,
- logs,
- event records,
- diagnostic dumps,
- crash reports,
- and exported session artifacts.

Do not overclaim: if an external harness runs its own native shell internally, Trebell may be unable to redact the output before that harness's own model sees it.

---

## 14. Verification and Feedback Loops

Verification is a core harness responsibility, but modern models do not need a second reviewer model after every tiny change.

### 14.1 Risk-aware verification

Choose the cheapest meaningful evidence for the change:

```text
TypeScript edit
→ LSP/typecheck
→ targeted tests if needed

Rust edit
→ rust-analyzer/cargo check
→ affected tests

frontend behavior
→ browser interaction
→ console/network
→ screenshot

release/auth/storage change
→ broader integration validation
```

### 14.2 Same-agent repair loop

Diagnostics should feed back to the **same current agent** whenever possible.

Example:

```text
edit
↓
compiler reports error
↓
same agent repairs
↓
targeted verification passes
```

No additional inference session is required.

### 14.3 Model review is optional

Use a separate review agent/model when:

- the user asks,
- risk is high,
- policy requires independent review,
- or empirical evidence shows it improves an important workflow.

Do not make it an unconditional tax on every task.

### 14.4 Visual verification

For frontend/UI work, passing DOM assertions is not enough.

Trebell's own engineering workflow should support:

- screenshots,
- responsive viewports,
- browser console checks,
- network errors,
- interaction verification,
- visual regression checks,
- and human/model visual inspection where appropriate.

---

## 15. Browser, Computer Use and Visual Tools

Trebell should support browser and computer interaction as first-class engineering capabilities.

### 15.1 Isolated agent browser

Provide:

- navigation,
- back/forward/reload,
- DOM snapshots,
- accessibility representation,
- element references/bounds,
- click/type,
- viewport control,
- screenshots,
- cookies/profile import where safely supported,
- recording,
- console errors,
- network failures,
- and localhost preview discovery.

Prefer deterministic DOM/accessibility/runtime evidence before using expensive visual reasoning for facts already available structurally.

### 15.2 Computer use

Support:

- desktop screenshots,
- mouse movement/click,
- scrolling,
- keyboard input,
- typing,
- and application interaction

with explicit permission and platform-specific containment.

If the selected model/runtime provides better native computer-use primitives, Trebell should integrate rather than duplicate unnecessarily.

### 15.3 Desktop-only harness scope

Trebell is a **desktop coding harness**.

Do not spend product or engineering effort on:

- Android emulator control,
- iOS Simulator control,
- physical mobile-device control,
- mobile-device remote-control panels,
- mobile companion-app workflows,
- or device-specific validation infrastructure.

This does **not** exclude remote development environments such as SSH or WSL. Those remain desktop-controlled execution environments for coding work.

---

## 16. Filesystem, Terminal and Environments

### 16.1 Filesystem

Support robust:

- tree/listing,
- search,
- range reads,
- writes,
- patching,
- diff,
- attachments,
- previews,
- large-file bounds,
- and remote equivalents.

### 16.2 Terminal

Provide:

- interactive PTYs,
- command execution,
- persistent scrollback,
- background processes,
- cancellation,
- exit status,
- bounded output,
- shell/environment awareness,
- and restart-safe history where useful.

Agent task lifetime and background process lifetime must be modeled separately.

### 16.3 Environments

Support:

- local,
- WSL,
- SSH,
- and future remote/container/cloud environments.

A project/thread should remain pinned to its intended environment unless the user explicitly changes it.

Capabilities, themes, filesystem, source control, terminals, runtimes and usage must respect the environment boundary.

---

## 17. Git, Worktrees and Source Control

Source control is part of the agent environment, not an afterthought.

Support:

- status/diff,
- branches,
- fetch/pull/push,
- commits,
- worktrees,
- safe cleanup,
- checkpoints,
- revert/rewind,
- submodule policies,
- branch ownership,
- recent history,
- and conflict-aware operations.

### 17.1 Worktrees

Use worktrees for:

- parallel agents,
- detached/background tasks,
- experiments,
- review/revert flows,
- and isolation of concurrent coding changes.

Protect dirty/active worktrees conservatively.

### 17.2 Multi-forge source control

Support real forge capabilities where available:

- GitHub,
- GitLab,
- Bitbucket,
- Forgejo/Gitea-like services,
- and future providers.

Operations may include:

- create/update PR/MR,
- comments,
- reviews,
- viewed files,
- merge,
- update/rebase,
- stacked work,
- revert PR,
- workflow checks,
- and diagnostics.

Never fake unsupported forge capabilities.

---

## 18. Checkpoints, Rewind and Recovery

Trebell should make experimentation cheap without pretending every external side effect is reversible.

Checkpoints should:

- preserve source state before meaningful turns,
- avoid modifying the user's working state merely to capture a checkpoint,
- work with nested repositories carefully,
- support thread/worktree ownership,
- and restore conservatively.

Conversation rewind and file rewind are related but distinct.

If checkpoint creation fails, the task may still proceed when safe, but the degraded protection must be visible.

---

## 19. Repository Knowledge

Trebell should maintain durable repository knowledge without creating a constantly regenerated hallucination-prone wiki.

Useful knowledge includes:

- architecture,
- project conventions,
- build/test commands,
- deployment rules,
- auth/data-flow facts,
- important entry points,
- domain terminology,
- recurring failure modes,
- and decisions discovered during real work.

Every stored fact should ideally carry:

- evidence/source files or symbols,
- last verified revision/hash,
- confidence/status,
- and scope.

When supporting evidence changes, mark the fact stale rather than silently trusting it forever.

Repository-local versioned documentation remains the highest-quality system of record when the project already maintains it.

Trebell knowledge should complement that system, not compete with it.

---

## 20. Skills, MCP, Plugins, Hooks and Apps

Trebell should support real extensibility.

### 20.1 Skills

Skills are useful for:

- specialized workflows,
- domain-specific instructions,
- tool usage guidance,
- or reusable project/team practices.

Do not use skills to explain generic behavior a modern model already understands.

### 20.2 MCP

Support:

- discovery,
- configuration,
- authentication,
- tools,
- resources,
- elicitation,
- reload,
- permission mediation,
- and runtime injection.

### 20.3 Plugins/apps

Plugins should add actual capabilities such as:

- skills,
- hooks,
- MCP servers,
- applications/connectors,
- or scheduled/triggered behaviors.

Installation, permissions and provenance must be visible.

### 20.4 Hooks

Hooks can enforce or automate deterministic lifecycle behavior around:

- tool execution,
- validation,
- formatting,
- project setup,
- source control,
- and task completion.

Do not turn every model decision into a hook.

---

## 21. Project Actions and Recipes

Project actions remain useful for direct commands:

```text
dev
test
lint
build
preview
setup
```

Recipes are higher-level reusable workflows such as:

```text
/fix-ci
/security-review
/add-tests
/release
/refactor-module
```

A recipe may declare:

- allowed tools,
- expected artifacts,
- validation,
- permissions,
- and workflow-specific context.

Keep recipes legible and economical.

Do not hide a large automatic agent swarm behind a simple slash command.

---

## 22. Queueing, Steering and Async Work

Modern models increasingly support long-running and asynchronous tool work.

Trebell should normalize:

- queued follow-ups,
- editing/reordering/removing queued prompts,
- mid-turn steering where supported,
- interruption/cancellation,
- async tool calls,
- pending tool results,
- detached tasks,
- and background processes.

Do not conflate:

```text
an agent task continuing in the background
with
a server/process the agent intentionally left running
```

Both need separate lifecycle/state.

---

## 23. Persistence and Event Architecture

Trebell should have durable, queryable state that scales beyond giant JSON documents.

### 23.1 Normalized event journal

Represent important lifecycle activity as typed events such as:

```text
session.started
turn.started
context.selected
model.requested
model.completed
tool.requested
policy.decision
tool.started
tool.completed
patch.applied
diagnostics.generated
verification.completed
checkpoint.created
turn.completed
```

Avoid persisting noisy token deltas as thousands of useless permanent events.

### 23.2 Storage

The mature persistence layer should use an indexed transactional store such as SQLite/WAL for:

- threads,
- turns,
- event indexes,
- usage,
- goals,
- checkpoints metadata,
- repository knowledge,
- task/recovery state,
- and searchable history.

JSONL is useful for:

- append-only export,
- debugging,
- interchange,
- and replay

but should not become a second conflicting source of truth.

### 23.3 Reconstructable state

Where practical, important UI/task state should be derivable from durable events/materialized state rather than only living in React memory.

---

## 24. Observability and Trace

Trebell should make the agent's **observable engineering behavior** inspectable without pretending to expose private hidden reasoning.

The Trace UI may show:

- runtime/provider/model,
- context selected,
- model latency,
- tool requests,
- policy decisions,
- command lifecycle,
- edits/diffs,
- diagnostics,
- verification,
- checkpoints,
- usage/cost,
- errors,
- recovery,
- and external side effects.

It should support filtering by:

- thread,
- turn,
- runtime,
- event category,
- and time.

Persisted trace data must be bounded and secret-redacted.

---

## 25. Usage, Cost and Budgets

Track factual usage:

- input tokens,
- cached input,
- cache writes where reported,
- output tokens,
- reasoning tokens where exposed,
- provider,
- model,
- runtime,
- environment,
- and known monetary cost.

Never invent unavailable cost data.

### 25.1 Runtime budget controller

Allow users/projects/tasks to bound:

- wall time,
- model turns,
- tool calls,
- tokens,
- child agents,
- and optionally cost.

Trebell Native can enforce these exactly.

External harness enforcement depends on available telemetry/control and should be honest about limitations.

---

## 26. Performance Is a Product Feature

Trebell must remain fast with:

- long chats,
- long tool traces,
- hundreds/thousands of threads,
- many projects,
- large repositories,
- remote environments,
- multiple background tasks,
- and large source-control histories.

Lag in the main interface is a product bug.

### 26.1 Long conversations

Use:

- virtualization/windowing,
- bounded history pages,
- incremental loading,
- normalized state,
- stable keys,
- memoized expensive renderers,
- lazy rendering of tool details,
- and offscreen work suppression.

Do not mount thousands of messages/tool rows.

### 26.2 Streaming

Do not force a full application render for every token/chunk.

Use:

- buffered/coalesced updates,
- narrow subscriptions,
- mutable transport buffers plus scheduled UI commits where appropriate,
- and incremental derived state.

### 26.3 Page navigation

Heavy pages should:

- lazy-load where useful,
- fetch only what they need,
- avoid global-state churn,
- preserve last-known-good data,
- and not remain fully mounted when hidden unless there is a concrete reason.

### 26.4 Polling and realtime

Avoid:

- overlapping polls,
- refreshing entire datasets for one changed item,
- work on hidden pages,
- repeated identical error notifications,
- and multiple components independently fetching the same resource.

Prefer:

- event-driven updates,
- deltas,
- shared caches,
- visibility-aware polling,
- backoff,
- and deduplication.

### 26.5 Repository indexing

Context indexing must be:

- incremental,
- cached,
- bounded,
- cancellation-aware,
- and moved off latency-sensitive UI paths where practical.

Large parsing/indexing work should use worker/background execution when needed.

### 26.6 Performance evidence

Maintain stress fixtures/benchmarks for cases such as:

- very long chats,
- large event histories,
- thousands of threads,
- large repositories,
- many projects/PRs,
- and sustained streaming.

Measure:

- interaction latency,
- page-open time,
- render time,
- memory growth,
- streaming throughput,
- indexing time,
- and storage/query latency.

Optimization should be evidence-based.

---

## 27. UI and Interaction Design

The primary experience should remain simple:

```text
choose/open project
      ↓
choose runtime/model when needed
      ↓
describe the task
      ↓
agent works
      ↓
review result/evidence
```

Advanced systems should appear contextually rather than becoming permanent clutter.

Examples:

- Context Inspector,
- Runtime Trace,
- diagnostics,
- policy approval,
- browser/computer panels,
- repository knowledge,
- source control.

### 27.1 No dead controls

Every visible control must:

- work,
- be correctly capability-gated,
- or explain why it is disabled.

### 27.2 Avoid redundant toggles

Capabilities that should normally be available to the agent—such as basic search—should not require meaningless composer toggles merely because an older UI exposed one.

### 27.3 Layout quality

The workspace should support:

- resizable panes,
- sane minimum sizes,
- long-content handling,
- responsive navigation,
- useful keyboard shortcuts,
- accessible focus behavior,
- themes,
- high-DPI rendering,
- and no accidental horizontal overflow.

Settings should be structured and searchable, not a giant unaligned scroll dump.

### 27.4 Provider-independent conversation identity

Conversation/history should not disappear merely because the user changed inference provider.

Thread identity belongs to the task/session, with provider/runtime metadata attached to turns as needed.

---

## 28. Desktop Control Surface

Trebell's supported product surface is the desktop application.

Remote development environments such as SSH and WSL may be controlled **from the desktop app**, but Trebell should not grow a separate mobile control product or device-harness layer.

Do not add Android/iOS remote control, emulator/simulator orchestration, or mobile companion workflows as product requirements.

---

## 29. Reliability and Failure Honesty

Reliability behavior is part of the product specification.

### 29.1 Last-known-good state

Polling/refresh failures should normally retain valid previous data and surface the error.

Do not convert:

```text
request failed
```

into:

```text
there are zero items
```

unless zero items is actually known.

### 29.2 Partial success

If:

```text
primary operation succeeds
follow-up refresh fails
```

report partial success rather than failure or fake full success.

### 29.3 Uncertain operations

Network/RPC failure after an action was sent may mean:

```text
the action happened but the acknowledgement was lost
```

Treat uncertain actions explicitly.

Do not blindly retry non-idempotent operations.

### 29.4 Runtime capability absence vs runtime failure

```text
method unsupported
```

is different from:

```text
method should exist but failed
```

The UI must not collapse these into the same state.

---

## 30. Testing and Evaluation

Trebell should be heavily tested without requiring a huge recurring inference budget.

### 30.1 Deterministic tests

Use:

- unit tests,
- integration tests,
- protocol fixtures,
- failure injection,
- filesystem/git fixtures,
- fake providers,
- remote-environment fixtures,
- and UI fixtures.

### 30.2 Visual tests

For user-visible behavior:

- run headless browser tests,
- capture screenshots,
- inspect the screenshots,
- and maintain targeted visual regressions.

A DOM assertion passing does not prove the UI looks correct.

### 30.3 Replay

Use sanitized recorded event/model/tool sequences to replay harness behavior without paying the model again.

Replay can validate:

- policy,
- event ordering,
- tool routing,
- recovery,
- persistence,
- UI state,
- redaction,
- and adapter changes.

### 30.4 Live smoke tests

Use real providers/models for the things mocks cannot prove:

- authentication,
- protocol compatibility,
- streaming/tool-call shape,
- model-driven end-to-end behavior,
- provider fingerprints.

Keep these intentional and bounded.

### 30.5 Harness/model comparisons

Trebell may record comparable results when a developer explicitly runs the same task across runtimes/models.

Do not continuously burn paid inference on background benchmark tournaments.

---

## 31. Packaging, Updates and Cross-Platform Behavior

Trebell should behave as a polished desktop product, not only a development script.

Maintain:

- installable desktop builds,
- bundled required runtimes where appropriate,
- updater metadata,
- explicit download/install behavior,
- app icon/branding consistency,
- safe background mode/tray behavior,
- and local development commands.

Support Windows, macOS and Linux where technically feasible.

OS-specific capabilities should be capability-gated rather than simulated.

---

## 32. Open-Source Reference and Reuse Policy

Do not reinvent high-quality infrastructure when a compatible open-source implementation already solves it.

At the same time, public source does **not** automatically mean code can legally be copied into Trebell.

### 32.1 Permissive references

Projects whose relevant implementations have been useful references include, subject to verifying the exact current revision/license before copying:

- OpenAI Codex — Apache-2.0
- Aider — Apache-2.0
- Cline — Apache-2.0
- Goose — Apache-2.0
- Qwen Code — Apache-2.0
- ACP — Apache-2.0
- Roo Code — historically Apache-2.0 for relevant released source
- OpenHands — MIT
- OpenCode — MIT
- Kilo Code — MIT
- Kimi Code — MIT
- Trae Agent — MIT

Useful areas to study:

```text
Aider
→ repository maps, Tree-sitter, structural ranking

OpenAI Codex
→ agent loop, app-server separation, patch/edit tools,
  sandbox, approvals, protocol and context engineering

OpenHands
→ action/observation events, runtime isolation, evaluation

Cline
→ checkpoints, permissions, tool/context integration

Goose
→ MCP-first extensibility and recipes

OpenCode / Qwen
→ runtime/provider abstractions, LSP, permissions

Kilo / Roo
→ delegation/worktree/mode concepts

Kimi
→ session/transcript persistence

ACP
→ standardized agent-client capability negotiation
```

### 32.2 Restricted/source-available references

Treat these as architecture/behavior references unless an exact component has a compatible separate license:

- Claude Code core source — proprietary/source-visible,
- Crush current FSL releases — competing-use restrictions until their future-license transition,
- Zed — primarily GPL,
- Warp client — AGPL,
- Cursor proprietary components,
- Devin,
- Kiro,
- Junie,
- Amp,
- Replit Agent,
- proprietary Factory components.

Do not evade licensing by copying restricted code and renaming variables.

### 32.3 Attribution

For substantial reused/adapted code, record:

- project,
- repository,
- exact revision,
- source file,
- license,
- destination,
- modifications,
- and required notices.

Preserve upstream licenses/NOTICE requirements.

---

## 33. Explicit Non-Goals

The final Trebell product should **not** depend on these ideas to be good:

### 33.1 Automatic "best model" router

Capability metadata and user/provider defaults are useful.

An automatic quality router is not trustworthy without representative evaluation data and can become stale quickly as models change.

Do not make it foundational.

### 33.2 Default Best-of-N/model tournaments

Do not multiply inference cost by default just to compensate for a weak harness.

### 33.3 Mandatory multi-agent swarm

Delegation is a capability, not a requirement.

### 33.4 Mandatory reviewer agent

Modern models self-check much better than earlier generations.

Use deterministic validation first and independent review when justified.

### 33.5 Mandatory embeddings/vector database

Structural search, exact search, symbols, Git and model-directed exploration should work without a paid embedding pipeline.

Embeddings may be an optional retrieval signal if they demonstrate value.

### 33.6 Giant always-on RepoWiki generator

Prefer repository-local source-of-truth docs plus evidence-backed knowledge with staleness tracking.

### 33.7 Forced plan bureaucracy

Complex tasks may benefit from durable plans.

Simple tasks should not be forced through planning ceremonies because older models needed them.

### 33.8 Patch-only editing

Provide reliable patching, semantic refactors and file tools.

Let the model choose the appropriate editing mechanism under policy and verification.

### 33.9 Prompt micromanagement

Do not encode hundreds of instructions telling capable models how to perform ordinary engineering.

Prompts/instructions should focus on:

- project-specific facts,
- user intent,
- real constraints,
- safety boundaries,
- and completion criteria.

---

## 34. What "Done" Looks Like

A mature Trebell session should feel approximately like this:

```text
User opens a project
        ↓
Trebell already knows the environment, Git state,
project instructions and repository structure
        ↓
User chooses a runtime/model (or keeps the default)
        ↓
User describes the desired outcome
        ↓
Trebell supplies small high-value orientation context
and excellent retrieval/semantic tools
        ↓
The model explores and acts autonomously
        ↓
Policy gates genuinely risky actions
without creating approval fatigue
        ↓
Edits, shell commands, browser/computer work and source-control
actions occur through observable real tools
        ↓
Compiler/LSP/tests/browser evidence provide fast feedback
        ↓
The same agent repairs problems
        ↓
Long work can compact, resume, delegate or continue
without losing the goal
        ↓
Everything important is durable across restart
        ↓
The user can inspect context, trace, diff, tests,
usage, side effects and checkpoints
        ↓
The final result is verified and reviewable
```

Changing from Codex to Claude, OpenCode, an ACP agent or Trebell Native should not throw away Trebell's repository intelligence, project knowledge, safety, source-control workflows or verification infrastructure.

The model/harness supplies reasoning.

Trebell supplies the engineering environment that lets that reasoning produce reliable software.

---

## 35. Final Principle

Trebell should not try to win by adding the most toggles, the most agents, or the most prompt text.

It should win by giving strong models the best possible environment:

- the right context,
- excellent deterministic tools,
- low-latency interaction,
- strong safety boundaries,
- reliable state,
- fast feedback,
- durable recovery,
- transparent evidence,
- and minimal unnecessary friction.

As models improve, Trebell should become **simpler where model intelligence can take over and stronger where only the harness can provide guarantees**.

That is the long-term product.
