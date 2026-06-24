# Stampede (merge queue) + Cowboy (AI orchestrator)

## TL;DR

We want to build a merge queue for our monorepo (Stampede), and an AI orchestrator that sits above it to eliminate the human shepherding of the merge loop (Cowboy). Mark your PR ready, and once it's approved and CI passes, Cowboy will take over and attempt to:

- not break `master` by validating against `master` before it's merged;
- not collide with other in-flight PRs by predicting conflicts ahead of time;
- autofix ejections by dispatching a PostHog Code/AI agent to fix, re-enroll, and merge it.

While the merge queue engine guarantees correctness within a partition, Cowboy makes the judgment calls a human engineer makes today.

We're asking for buy-in and approval to start work on an MVP.

## Why now, why us

**Why now:** Agent-authored PRs (PostHog Code, Claude Code, Graphite Stacks) are growing exponentially, and the bottleneck has moved from _writing_ code to reviewing it, _safely merging it_, and deploying it. With many PRs racing the same `master`, changes that pass CI in isolation increasingly collide once merged[1], and nothing today validates a PR against the state it will actually merge into. A broken `master` then stalls everyone (red CI everywhere, blocked deploys, incidents), and every one of those failures currently lands on a person to re-run, rebase, and untangle.

**Why us:** PostHog is building the future of self-driving software; soon, people will expect their software to improve by itself. To get there, we need to close the loop on agent-authored changes. The merge queue is a critical missing piece of that loop, and an AI orchestrator is the only way to eliminate the human bottleneck in it. No vendor offers this level of AI-driven merge orchestration, and it's a natural extension of our existing investment in PostHog Code.

## Alternatives considered

As the number of human-agent authored PRs increases (by 10% MoM in `posthog/posthog`), maintaining the status quo is no longer an option. GitHub's native merge queue offers very few config options and would drastically slow PR-to-deploy times. While mature commercial options exist (Mergify, Aviator, Graphite, Trunk), observability is gated, costs are prohibitive (many bundle all products under a single price @ ~40$/month/contributor), and they cannot hook into our agent-fix loop.

**Rough annual cost.** This isn't really a cost decision — every option is cheap next to the engineer time at stake — but it's worth knowing what we're suggesting. Figures are order-of-magnitude, against a ~180-contributor headcount (all per-seat numbers verified 2026-06-24):

- **Do nothing** — $0 in licenses, but a real, unmeasured cost in engineer interruptions: broken-`master` incidents, manual rebases and re-runs, PRs stalled behind a red trunk. Grows with PR volume.
- **Graphite** — a commitment requires ~$20/engineer/month on Cursor credits, ≈ **$43k/year**, growing with headcount.
- **Mergify** — $21/seat/month (−15% annual) on the Max plan, but Max caps at 100 users, so at our size it's an Enterprise (custom) quote; list price would imply **~$45k/year**.
- **Aviator** — $20/dev/month (Team) ≈ **$43k/year**, but the monorepo + flaky features we'd want are Scale at $40/dev/month ≈ **~$86k/year**.
- **Trunk** — Team is **$18/committer/month** ≈ **~$39k/year** at ~180 committers, and includes 1M test spans per committer with **$3 per additional 1M test spans** on top. So it bills per seat _and_ per usage — and a merge queue re-running the full suite at every trial is exactly the workload that inflates span counts, so the usage component rides our test volume. Enterprise is a custom quote.
- **Build + host (Stampede + Cowboy)** — a one-time engineering build (very rough: a few engineer-quarters across the seven milestones) plus ongoing run cost: added CI compute (the dominant variable, see [Bounds & cost](#bounds)), marginal LLM spend on the existing PostHog Code budget, and hosting on infra we already run. No per-seat license, so it scales with usage rather than headcount.

The shape that matters: the commercial options bill per head (and, for Trunk, per test-span) and grow forever, while building is a fixed investment plus usage-based run cost — and only building gives us pre-CI conflict prediction, the agent-fix loop, and our data in `engineering_analytics`.

**Feature comparison** (commercial capabilities verified 2026-06-24):

|                                               | GitHub native       | Graphite   | Mergify                             | Aviator                              | Trunk                                   | Stampede + Cowboy             |
| --------------------------------------------- | ------------------- | ---------- | ----------------------------------- | ------------------------------------ | --------------------------------------- | ----------------------------- |
| Monorepo partitioning                         | ❌ one queue/branch | ⚠️ limited | ✅ Scopes (paths/Bazel/Nx)          | ✅ Affected Targets                  | ✅ Parallel Queues (impacted targets)   | ✅ partitions                 |
| Strategies: serial / speculative / batched    | ⚠️ basic grouping   | ⚠️ some    | ✅ all + bisection                  | ✅ all + bisection                   | ✅ all + bisection                      | ✅ all four + bisection       |
| Pre-CI collision prediction (static/semantic) | ❌                  | ❌         | ❌ reactive                         | ❌ target overlap only               | ❌ runs projected state                 | ✅ static + semantic          |
| AI auto-fix / agent loop                      | ❌                  | ❌         | ❌ (CLI exposes skills _to_ agents) | ⚠️ self-heals its _own_ bot PRs only | ❌ built it, scrapped it; roadmap Q2'26 | ✅ dispatch + re-queue        |
| Stacks                                        | ❌                  | ✅ native  | ✅ native (depth 20)                | ✅ `av` CLI                          | ✅ supported                            | ✅                            |
| Flaky handling                                | ❌                  | ⚠️         | ✅ CI Insights + auto-retry         | ⚠️ optimistic validation             | ✅ flagship (rules + AI investigation)  | ✅ eng-analytics signal       |
| Observability                                 | ⚠️                  | ⚠️ gated   | ✅ but retention-tiered (24h/30d)   | ✅ dashboards + API                  | ✅ not tier-gated                       | ✅ in `engineering_analytics` |
| Self-host                                     | ❌                  | ❌         | ⚠️ Enterprise only                  | ✅ Helm/Docker (Enterprise)          | ⚠️ private preview (Enterprise)         | ✅ ours                       |
| Cost (~180 contributors)                      | free                | ~$43k/yr ↑ | ~$45k/yr ↑ (Enterprise quote)       | ~$43–86k/yr ↑                        | ~$39k/yr ↑ + test-spans ($3/1M)         | build + usage                 |

**Worth copying or trialing first.**

- **Pre-CI conflict prediction and the agent-fix loop are genuinely unattainable off-the-shelf** — no vendor predicts conflicts before CI, Trunk built-and-killed the auto-fix agent, and Aviator only self-heals its own bot PRs. This is the part that justifies building.
- **The merge engine itself is not a differentiator** — partitioning, speculative/batched validation with bisection, and stacks are table stakes across Mergify/Aviator/Trunk. Worth studying their designs (Mergify Scopes, Aviator Affected Targets, Trunk Parallel Queues) rather than reinventing; our affected-target graph maps directly onto all three.
- **Trunk's flaky-test detection is the most mature piece on the market** (rule-based monitors + AI investigation) and overlaps our Mendral / `engineering_analytics` signal — a short trial would benchmark our own and de-risk that dependency.
- **GitHub's native queue is free** and could serve as a zero-cost interim gate on one low-risk partition while we build.

## Stampede

The merge engine deploys four selectable strategies, chosen per partition:

| Strategy                   | Behavior                                                                             |
| -------------------------- | ------------------------------------------------------------------------------------ |
| **Optimistic**             | each PR validated against a fresh `master` and merged on its own                     |
| **Serial**                 | PRs validated on top of the one before, in true merge order, for maximum correctness |
| **Speculative**            | many PRs validated concurrently in projected order, for high throughput              |
| **Batched & self-healing** | groups are validated together; on failure, bisect the culprit and keep innocents     |

### CI

While a PR is open, a _test-impact sub-selection_ runs for fast developer feedback. At the queue trial the full suite runs against the state the PR will actually merge into (`master` under optimistic, the projected stack of in-flight predecessors under serial and speculative) once per PR, or once per batch when batching is enabled. Because the full suite always re-runs against the merged state, no suite has to be certified "safe in isolation", and a thin or stale subset will eject in the worst case.

<details>
<summary><strong>Advanced options</strong></summary>

### Controls

A few controls govern how aggressively the queue runs and how humans take back the wheel:

- **Hybrid mode**: the queue runs alongside direct merges during rollout. Some PRs go through it, others still merge directly. The end state is an exclusive mode where every merge goes through the queue, enabled per partition once it has earned trust. While hybrid mode is on, a direct merge can move `master` under an in-flight trial, so it only fully holds once a partition is exclusive.
- **Freeze**: an admin pauses merges for the whole queue or a single partition (an incident, a release cut, a deploy window). Enrolled PRs hold in place and nothing is merged until it's lifted. In-flight trials finish rather than being cancelled, and their results are held, including the projected validations of a speculative chain, so when the freeze lifts merging resumes from where it left off instead of re-validating from scratch.
- **Audited break-glass**: a human-only emergency override to force a merge or bypass the queue (the queue is down, a hotfix must release now). Every use is logged and attributed, and it's never available to agents or Cowboy.

### Partitioning

A partition is an independent sub-queue scoped to a slice of the monorepo. PRs in different partitions validate and merge in parallel without waiting on each other, and each partition carries its own strategy, conditions, and CI scope. Every partition has a name and a predicate that decides which PRs belong to it. Simple predicates are just path glob (`frontend/**`), but more complex ones capture boundaries the tree can't express. Predicates are written in the same fixed-keyword grammar that gates queue admission (`approved`, `checks-green`, `files~=`, `label=`, implicit `AND`, negation).

Partitioning assumes the slices it covers are effectively independent, but because a partition only validates against its own scope and merges in parallel with the others, a change in one partition can in theory break `master` for another. We're effectively trading collision avoidance for high throughput, so partition boundaries must be drawn well enough to reduce the change of breaking `master`.

### Ordering

Within a partition, PRs merge in the order they become eligible (approved → green → enrolled). When a PR is ejected and re-enrolled, or knocked out by another PR merging ahead of it, it rejoins at the **back** of the line rather than reclaiming its old slot. This keeps a flapping PR from holding up everything behind it (no head-of-line stall) and bounds starvation.

### Stacks

A stack is a chain of dependent PRs, and people use them to break a change into reviewable steps — often merging the lower steps first because the later work needs the earlier steps _landed_ to build and validate against. The queue works with that grain rather than against it: each step enrolls, validates, and merges **independently, in dependency order**, instead of the whole stack landing as one unit. A step becomes eligible on its own (approved and green) — no need to mark the entire stack ready — and validates against the projected state of its already-landed-or-in-flight ancestors plus everything ahead of it in the queue, so by the time an upper step trials, the steps below it are usually already on `master`.

If a lower step ejects, the steps above it depend on the change it carries, so they hold until it lands rather than merging ahead of it. A step whose changes span partitions serializes across all of them, the same treatment the router gives any partition-spanning PR. To land a whole stack at once, mark every step ready and the queue merges them bottom-up as each one clears.

</details>

## Cowboy

The merge queue engine answers one narrow question: "is this PR green against `master`?". Cowboy answers everything fuzzy a human merge-wrangler does, sitting _above_ the engine:

- **Strategy selection:** A partition can pin its own strategy (optimistic → serial → speculative → batched). For the others, Cowboy picks the strategy and knobs from live signals (failure rate, queue depth, CI cost, what's enrolled) instead of using a static config.
- **Collision prediction:** Before a costly merge trial, predicts conflicts _statically_ first (overlapping paths, touched symbols, migration collisions, shared scopes), escalating to a _semantic_ LLM pass over diffs only when the static pass is inconclusive on a high-risk surface, catching what file overlap misses, like two PRs changing the same contract (an interface and its callers).
- **Conflict handling:** When a PR no longer merges cleanly into the state ahead of it (a textual conflict after a predecessor is merged), Cowboy can choose to auto-rebase in place when the resolution is mechanical, or eject back to the author/agent when it isn't. A rebased PR re-validates against its target state before merging, like every other write.
- **Ejection triage & recovery:** On ejection, separate the faulty PR from flaky victims; victims re-queue silently. A faulty PR with a high-confidence diagnosis _and_ fix is fast-fixed in place (mechanical changes only), otherwise it dispatches a fix brief (or, on a low-confidence diagnosis, just the failure) to the agent. The fix lands under the PR's existing approval and re-queues with no fresh review required. A configurable cycle cap breaks loops and escalates fast-fix → agent → human.

### Shadow mode

Shadow mode is how we validate that a component of the merge queue (the engine, a strategy, Cowboy itself) is ready to gate actual PRs. It runs its full logic against real PRs but only _records_ the decision each component would make, never acting on it.

Cowboy operates under the same conditions and access control as any other agent, with one addition and one exclusion: it _may_ act on the merge queue (the whole point), but it can _never_ use break-glass, which stays human-only. Each decision type earns promotion from shadow to live on its own evidence, and the two that write code (fast-fix, agent dispatch) earn it last. For routing and strategy decisions, a wrong call only costs CI time or slows throughput, because the engine still validates against `master` before anything is merged.

### Flaky tests

Telling a real failure from a flake is what makes the retry-and-heal behavior safe, and the queue doesn't judge that itself. Instead, it reads the flakiness signal from the `engineering_analytics` product. A failure on a test flagged flaky is retried rather than charged to the PR, while a failure on a stable test ejects. Ejection triage consumes the same signal to separate a faulty PR from its flaky victims.

## Bounds

Every aggressive mode is bounded so its worst case is not open-ended:

- **Speculation depth** is capped (configurable per partition), so the invalidation cascade (re-validating everything behind a failed PR) can only ripple as far as that depth. Expected wasted CI per failure is roughly `depth × failure_rate × suite_cost`. Cowboy tunes depth _down_ as the live failure rate climbs, so a flapping partition collapses toward serial instead of burning CI on speculation that keeps getting invalidated.
- **Batch size** is dynamically sized and capped. On a batch failure, bisection isolates the culprit in `O(log n)` extra trials while keeping the innocents, so a bad PR only costs a logarithmic retry, not a rerun per member.
- **Full-suite-at-trial** is the final and full CI gate. Every trial runs the full suite against the merged state with _no_ test selection. Test-impact selection runs only while a PR is open and while agents iterate, keeping that loop cheap without ever weakening the trial.
- **Semantic collision prediction** (the LLM pass) fires only when the static pass is inconclusive on a high-risk surface, bounding per-PR LLM spend to the ambiguous minority rather than every trial.
- **Fix loops** are bounded by the cycle cap, which escalates fast-fix → agent → human rather than retrying indefinitely.

## How it fits together

**For a human,** mark a PR ready, and once approved and CI is green, it auto-enrolls into the queue. Flakes get retried, and PRs knocked out by someone else's change get re-queued automatically. Monitor the progress of your PR with `hogli`, `ph`, in Posthog Code, via Claude/Codex, or on the web app.

**For an agent,** the queue closes the loop to "merged on `master`":

1. Agent opens (or stacks) a PR and marks it ready.
2. The PR auto-enrolls, and the agent watches the merge trial.
3. On _eject_, Cowboy briefs the agent via `diagnose_ejection` → agent fixes in-sandbox → pushes → PR re-enters the queue.
4. On _merge_, agent closes the task.

Agent surfaces are the same ones available to humans, plus **MCP tools** (`enroll`, `status`, `diagnose_ejection`, `dequeue`, served alongside `products/posthog_ai/mcp`) and **skills** in `products/merge_queue/skills/`. Queue actions inherit repo access. Anyone (human or agent) who can act on the repo can `enroll` or `dequeue` a PR, the same way they could already push or merge. Behavior is configurable via settings, but there is no separate per-tool permission grant to manage.

## Milestones

1. Queue engine (enroll → trial → merge/eject), GitHub adapter with per-agent bot accounts, condition-grammar evaluator that powers auto-enroll, observability pipeline into `engineering_analytics`, and shadow harness. Only implement optimistic and serial merge strategies.
2. Human/agent surfaces (CLI, MCP, UI, Slack) and the operational controls (hybrid mode, freeze, audited break-glass) over the engine API.
3. Partition router: predicate matching (reusing the condition grammar), per-partition strategy and config, and deterministic routing for PRs that span partitions.
4. Affected-target dependency graph (changed files → build/test targets) that powers affected-target CI scoping, the test-impact subset that gives fast dev feedback, the full-suite-at-trial split, and lets partitions derive their map instead of hand-drawing it.
5. Speculative engine to model projected state (a PR validated on top of its in-flight predecessors), with configurable speculation depth and the invalidation cascade that re-validates everything behind a PR that fails.
6. Batch assembly (scope-aware via the affected-target graph), healing, dynamic sizing, and bisection that isolates the culprit on a batch failure.
7. Cowboy's decision core, static + semantic collision prediction, and ejection triage with fast-fix and agent dispatch. Each decision is promoted from shadow to live independently, and all merges go through the queue once trust is earned.

## Success metrics

- Reduced `master` red rate
- Reduced time-to-merge (PR ready → CI passed → approved → merged)
- Escaped breakages → 0 (changes that merge green but broke `master` anyway)
- Increased auto-recovery rate (ejections resolved with no human touch)
- Human interventions per merge → 0 (manual rebases, re-runs, break-glass uses)
- Reduced CI cost per merged PR
- Full shadow-vs-live agreement
- All partitions in exclusive mode

## Cost

- **CI runs:** Every trial runs the full suite against the merged state, so the queue adds CI on top of the per-PR runs we already pay for. The aggressive strategies amplify it (speculation re-validates on invalidation, batches re-run on failure, etc.).
- **LLM/agents:** Cowboy's semantic collision pass fires only on ambiguous high-risk surfaces, and fast-fix / agent-dispatch invoke a PostHog Code agent per ejection. This is a marginal cost next to CI, and it rides our existing PostHog Code budget rather than a new contract.

Today every broken `master` and every manual rebase/re-run is paid in engineer time, and trunk downtime stalls everyone at once. Our bet is that recovered engineer time and trunk uptime outweigh the added CI bill.

## Risks

- A bad boundary lets a change in one partition break `master` for another.
- Aggressive merge strategies can increase CI costs faster than the bounds contain it.
- Fast-fix and agent dispatch merges with CI green but has _incorrect_ changes.
- Self-healing leans on the flakiness signals, but a poor signal means real failures retried or flakes ejected.
- Hybrid mode means a direct merge can break trunk under an in-flight trial until a partition is exclusive.
- An AI/LLM outage takes Cowboy offline, auto-recovery stops and ejections fall back to humans.

## Glossary

- Agent dispatch: handing an ejection to a PostHog Code/AI agent with a fix brief.
- Cycle cap: a configurable limit that breaks fix loops and escalates fast-fix → agent → human.
- Eject: a PR removed from the queue after its trial fails.
- Enroll: a PR entering the queue; auto-enrolls once it's approved and green.
- Escaped breakage: a change that merged with CI green but broke `master` anyway.
- Fast-fix: a mechanical, high-confidence fix Cowboy applies in place
- Invalidation cascade: re-validating everything behind a PR whose trial failed.
- Partition-spanning PR: a PR matching multiple partitions, serialized across all of them.
- Projected state: the state a PR will merge into; `master` HEAD, or `master` plus in-flight predecessors.
- Speculation depth: how many in-flight predecessors a speculative PR is validated on top of (capped).
- Test-impact selection: the reduced test subset run while a PR is open and during agent iteration.
- Trial: a full-suite CI run of a PR against its projected merged state.

[1] See [#46597](https://github.com/postHog/posthog/pull/46597) vs [#46442](https://github.com/postHog/posthog/pull/46442), [#42561](https://github.com/postHog/posthog/pull/42561) vs [#45345](https://github.com/postHog/posthog/pull/45345), and [#56733](https://github.com/postHog/posthog/pull/56733) vs [#57498](https://github.com/postHog/posthog/pull/57498)
