# Stampede + Cowboy — execution plan

Build plan for the merge queue (**Stampede**) and its AI orchestrator (**Cowboy**), to execute in the
`posthog` repo. This is the carry-over artifact: it consolidates the milestone sequence, the locked
contract, the integration surfaces, and the rules that must hold throughout.

## Document set

| Doc                                 | Role                                                                                      |
| ----------------------------------- | ----------------------------------------------------------------------------------------- |
| `merge-queue-design.md`             | Product RFC — the _what_ and _why_ (source of truth for behavior)                         |
| `stampede-engineering-rfc.md`       | Engine design — the _how_ (architecture, modules, integration)                            |
| `cowboy-engineering-rfc.md`         | Orchestrator design — built on the ReviewHog template (`products/review_hog/`, PR #64651) |
| `stampede-facade-and-data-model.md` | **Locked contract** — Postgres tables + `facade/` signatures. Build to this.              |
| `stampede-cowboy-execution-plan.md` | This file — the build sequence                                                            |

Copy these into the repo (suggest `products/merge_queue/docs/`) so they live next to the code.

## Where it lives

```text
products/merge_queue/                 # Stampede — the product home
├── backend/
│   ├── models.py                      # Partition, Enrollment, Slot, Trial, QueueEvent (locked: Part A)
│   ├── facade/                         # the ONLY public surface (locked: Part B)
│   │   ├── api.py                      #   imperative: enroll/dequeue/status/freeze/unfreeze/break_glass
│   │   ├── types.py                    #   DTOs/enums
│   │   └── decisions.py                #   DecisionProvider, DeterministicDefaults, GatedProvider
│   ├── engine/                         # lifecycle, strategies/, projected_state.py, bisection.py
│   ├── grammar/                        # parser.py, evaluator.py (auto-enroll + partition predicates)
│   ├── router.py                       # partition matching → safe set
│   ├── ci/                             # affected_targets.py, scoping.py
│   ├── github/                         # adapter.py, bot_accounts.py
│   ├── temporal/                       # trial_workflow.py, queue_workflow.py
│   ├── observability.py                # → engineering_analytics
│   └── presentation/views.py           # DRF ViewSet → MCP + UI
├── cowboy/                            # Cowboy — ReviewHog-template package; imports facade/ ONLY
│   ├── core.py  run.py  promotion.py  signals.py  constants.py
│   ├── models/  tools/  prompts/<step>/{prompt.jinja,schema.json}
│   └── sandbox/executor.py             # run_sandbox_step() + MAX_CONCURRENT_SANDBOXES semaphore
├── frontend/   mcp/tools.yaml   skills/
└── docs/                               # the 5 docs above
```

**Dependency rule (enforce with `tach`):** `cowboy/` imports `products/merge_queue/backend/facade/`
and nothing deeper. The engine never imports `cowboy/`. This one-way edge is what lets the engine run
standalone and lets Cowboy shadow against a live engine.

## Before code — three external sign-offs (conversations, run in parallel with M1)

1. **`engineering_analytics` owners** — the event-ingestion path _does not exist yet_ and is net-new
   work in their product (it reads GitHub warehouse snapshots today). Decide: emit via the event
   pipeline (group-typed `pull_request` events) or a dedicated warehouse table. **On M1's critical path
   for observability — stub `observability.py` if this lags; do not block the engine.**
2. **`products/tasks` owners** — Cowboy runs _all_ its LLM work through the Tasks sandbox facade
   (`MultiTurnSession`, `create_and_run_task`). Confirm it handles the single-turn judgment volume +
   concurrency Cowboy will drive. (Needed before M7, not M1.)
3. **`products/review_hog` owners** — the reuse decision (cowboy RFC §2.1): extract a shared
   `github_meta` / chunking / sandbox-step helper, or copy. Settle before M8. Cheap now, annoying later.

## Build sequence

Tracked task IDs in brackets. Each milestone ships behind shadow and promotes incrementally — per
_partition_ (engine) or per _decision_ (Cowboy). No big-bang cutover.

### Stampede (the engine)

**M1 — Engine core, shadow-only (optimistic + serial)** `[task 1]`
The irreducible first engine, recording decisions but acting on nothing.

- 5 Postgres tables (locked Part A); facade with deterministic defaults + `GatedProvider(cowboy=None)`
  (locked Part B); `QueueEvent` on every transition.
- Condition-grammar parser/evaluator (powers auto-enroll).
- GitHub adapter: webhook ingest (review/check-suite/push/label) → eligibility → enroll; per-agent bot
  accounts; merge + commit-status out.
- Lifecycle: enroll → trial → merge/eject; back-of-line re-enroll.
- Temporal trial workflow: **full suite** against projected state (master HEAD / single predecessor).
- Shadow harness; `observability.py` (stub if sign-off #1 lags).
- **Gate:** shadow decisions agree with actual human/direct-merge outcomes on one low-risk slice.

**M2 — Surfaces & controls (MVP boundary)** `[task 2]`

- DRF ViewSet → MCP tools (`enroll`/`status`/`dequeue`) + skills; `hogli` CLI; UI queue view; Slack.
- Hybrid mode; freeze (finish-but-hold, results persisted); audited break-glass (human-only).
- **Gate:** flip the first partition hybrid → exclusive on a low-risk slice. **← This is the MVP: it
  already kills broken-`master` on that partition.**

**M3 — Partition router** `[task 3]`

- Predicate matching (reuse grammar) → safe set; `partitions.yml` sync into the `Partition` table;
  per-partition strategy/config; deterministic spanning route (precedence); Slot-per-partition +
  merge-gate = all slots GREEN; Visual Review as a required `checks-green` check.
- **Gate:** ≥2 partitions running independently in parallel.

**M4 — Affected-target graph + CI scoping** `[task 4]`

- changed-files→targets graph; test-impact subset (open only); **full-suite-at-trial split enforced in
  `ci/scoping.py`** (no test selection at trial); per-partition CI scope derived from the graph.
- **Gate:** CI-cost-per-merged-PR instrumented; subset faster while open; trial provably full-suite.

**M5 — Speculative engine** `[task 5]`

- Projected-state chain; configurable speculation depth (per-partition cap); invalidation cascade
  bounded by depth.
- **Gate:** throughput up on a green queue; wasted-CI-per-failure within `depth × failure_rate × suite_cost`.

**M6 — Batching + bisection** `[task 6]`

- Scope-aware batch assembly (via M4 graph); dynamic sizing, capped; `O(log n)` bisection keeps innocents.
- **Gate:** a bad PR in a batch costs a logarithmic retry, not a rerun per member; innocents still land.

### Cowboy (the orchestrator)

**M7 — Scaffold + strategy selection (first live decision)** `[task 7]`

- ReviewHog-template scaffold (`core.py`/`run.py`/`sandbox/executor.py` semaphore/`models/`+`generate_all_schemas()`/`prompts/`/`constants.py`); `promotion.py`; `signals.py` (reads `engineering_analytics`).
- Wire `CowboyDecisions` into `GatedProvider`; **all hooks start shadow**. Settle reuse decision (#3).
- Strategy selection: **rules over live signals, no LLM/sandbox** — for `auto` partitions pick strategy
  - knobs. First decision promoted shadow → live.
- **Gate:** `select_strategy` live on ≥1 auto partition; full shadow-vs-live agreement on others.

**M8 — Collision prediction** `[task 8 — blocked by M7 *and* M4]`

- Static pass (local, off M4's graph) → semantic detect (sandbox, both PR branches checked out) →
  adversarial validate (second agent refutes before acting). Gated to `static-inconclusive ∧ high-risk`.
- Feeds strategy/ordering only; never blocks a merge (trial is arbiter).
- **Gate:** `predict_collision` live; semantic spend confined to the ambiguous minority; collision-driven
  ejections down.

**M9 — Conflict handling** `[task 9]`

- `on_conflict`: judgment step → mechanical → agent rebases in place (re-validates before merge); else
  eject.
- **Gate:** `on_conflict` live; auto-rebased PRs re-validate and merge clean.

**M10 — Ejection triage + fix loop (promoted last)** `[task 10]`

- Flaky split (via `signals.py`); diagnose step (sandbox, structured `EjectionDiagnosis`); fast-fix
  (mechanical, under existing approval, no fresh review); agent dispatch (`create_and_run_task`,
  `create_pr=False` → push to PR branch → re-enroll; backs the `diagnose_ejection` MCP tool); cycle cap
  (escalates fast-fix → agent → human).
- **Gate:** `triage_ejection` live; auto-recovery rate up, human interventions per merge → 0; no
  green-but-wrong merges in the watch window.

**M11 (later) — Cowboy parent Temporal workflow** `[task 11]`

- Lift `run.py` into a parent workflow spawning each step as a child workflow (ReviewHog's roadmap). Not
  on the critical path.

## Sequencing rules that actually constrain order

- **Nothing in Cowboy starts before M1** — it needs a live engine, the shadow harness, and the
  `GatedProvider` to shadow against.
- **Each Cowboy decision wants its engine capability first:** collision (M8) needs the affected-target
  graph (M4); strategy selection (M7) is only meaningful once speculative/batch knobs exist (M5/M6).
- **Promote incrementally, never big-bang:** per partition on the engine; per decision on Cowboy.

## Invariants that must hold across every milestone

1. **Full-suite-at-trial, no exceptions.** Every merge runs the full suite against its projected merged
   state with no test selection. Test-impact selection is for the open-PR loop only. Enforced in
   `ci/scoping.py`, never configurable away. _(This is the correctness anchor — protect it in review.)_
2. **Every state mutation emits a `QueueEvent`.** No queue state changes silently; this is what makes
   observability complete and the shadow harness trustworthy.
3. **`break_glass` is the only hard authz gate** — human-only, enforced in the facade; never available
   to agents or Cowboy. All other actions inherit repo access.
4. **The deterministic defaults are the safety floor.** With `cowboy=None` the engine is fully
   deterministic and self-sufficient; every Cowboy decision is still gated by a full-suite trial before
   merge, so a wrong/failed Cowboy call costs CI or throughput, never correctness.
5. **Shadow ⇒ act-on-default.** A hook in shadow always acts on the deterministic default and records
   Cowboy's would-be decision (`SHADOW_DECISION` event); promotion to live is per-hook.

## Integration points (reuse, don't rebuild)

| Need                              | Reuse                                                                                                                |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Durable orchestration             | Temporal — pattern from `products/tasks/backend/temporal/`                                                           |
| Repo access / GitHub App          | `github_integration` (as `products/tasks` uses it)                                                                   |
| MCP tools                         | DRF `@action` + `@validated_request(operation_id=…)` → `products/merge_queue/mcp/tools.yaml`; server `services/mcp/` |
| Skills                            | `products/merge_queue/skills/<name>/SKILL.md`                                                                        |
| Observability store               | `engineering_analytics` (new event-ingestion path; curated builders in `…/logic/views/`)                             |
| Flaky verdict                     | Mendral today → `engineering_analytics` flaky signal (`github_workflow_jobs.run_attempt`)                            |
| Visual Review gate                | `visual-review-runs-list` (`products/visual_review/mcp/tools.yaml`)                                                  |
| Cowboy LLM judgment               | `MultiTurnSession.start(model=Shape)` + `end()` — `products/tasks/backend/facade/agents.py`                          |
| Cowboy code fixes                 | `create_and_run_task` — `products/tasks/backend/facade/api.py`                                                       |
| Cowboy LLM provider/cost/fallback | LLM gateway **transitively**, via the agent (product `posthog_code`) — no direct integration                         |
| Cowboy LLM traces                 | `ai_observability` (`$ai_generation`, auto-captured through the agent)                                               |
| Cowboy template                   | `products/review_hog/` (PR #64651) — same pipeline anatomy                                                           |
| Systemic-pattern surfacing        | Signals (`signals-scout-emit-signal` / `emit_signal()`)                                                              |

## Start here

**M1 `[task 1]` is the only unblocked task.** Build it against the locked contract
(`stampede-facade-and-data-model.md`). Everything else unlocks as its dependency completes. Kick off the
three sign-off conversations in parallel.
