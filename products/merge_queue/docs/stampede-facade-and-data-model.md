# Stampede — facade contract & data model (locked)

> The authoritative contract for the Stampede engine: the Postgres data model and the
> `facade/api.py` surface that is the engine's only public entry point (for surfaces, for Cowboy, for
> the shadow harness). Companion to [`stampede-engineering-rfc.md`](./stampede-engineering-rfc.md)
> (expands its §2 model bullets and §4 engine API) and [`cowboy-engineering-rfc.md`](./cowboy-engineering-rfc.md)
> (which consumes the decision hooks). Locked means: build to these signatures; change them by editing
> this doc, not by drifting in code.
>
> Code is illustrative Django / typed Python — field types, states, constraints, and signatures are
> the contract; names are strong suggestions.

## Part A — Data model

Five tables in `products/merge_queue/backend/models.py`. The shape:

```text
Partition 1──* Slot *──1 Enrollment        (Enrollment = a PR in the queue;
              │                              Slot = that PR's membership in one partition)
              *
              │
            Trial  (validates one Slot, or many Slots when batched)

QueueEvent — append-only audit/observability log; FKs to any of the above
```

- An **Enrollment** is a PR in the queue (PR-level, the thing that merges).
- A **Slot** is that PR's membership + position in **one** partition. Most PRs have one slot; a
  partition-spanning PR has several and merges only when **every** slot is green (Stampede RFC §8).
- A **Trial** is one full-suite CI attempt against a projected state; it covers one slot, or several
  when batched (RFC §5.1). Bisection links child trials to a parent.
- **Stacks** are a `parent` edge on Enrollment (RFC §9); ordering is enforced in the lifecycle.

### A.1 Partition

Identity + resolved config + runtime state. Predicate / strategy / config are **authored in
`partitions.yml` and synced into this table** on deploy; only the runtime fields (`mode`, `frozen_at`,
`frozen_by_*`) are mutated at runtime via the facade.

```python
class Strategy(models.TextChoices):
    OPTIMISTIC = "optimistic"
    SERIAL = "serial"
    SPECULATIVE = "speculative"
    BATCHED = "batched"
    AUTO = "auto"            # engine default = serial; Cowboy selects live (RFC §4.2)

class PartitionMode(models.TextChoices):
    HYBRID = "hybrid"        # queue runs alongside direct merges (RFC §10)
    EXCLUSIVE = "exclusive"  # every merge goes through the queue

class Partition(models.Model):
    name = models.SlugField(unique=True)
    predicate = models.TextField()                 # condition grammar (RFC §6); synced from yml
    strategy = models.CharField(choices=Strategy.choices, default=Strategy.SERIAL)
    speculation_depth = models.PositiveIntegerField(null=True)   # null → engine default
    max_batch_size = models.PositiveIntegerField(null=True)      # null → engine default
    ci_scope = models.JSONField(default=dict)       # affected-target selector for this partition
    precedence = models.IntegerField(default=0)     # tiebreak for the deterministic spanning route (RFC §8)
    # runtime-mutable (not from yml):
    mode = models.CharField(choices=PartitionMode.choices, default=PartitionMode.HYBRID)
    frozen_at = models.DateTimeField(null=True)
    frozen_by_id = models.CharField(max_length=255, null=True)
    frozen_by_kind = models.CharField(max_length=16, null=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    @property
    def is_frozen(self) -> bool:
        return self.frozen_at is not None
```

### A.2 Enrollment (PR-level)

```python
class EnrollmentState(models.TextChoices):
    ACTIVE = "active"        # in the queue across one or more slots
    MERGED = "merged"        # terminal: all slots green, merged to master
    EJECTED = "ejected"      # terminal for this enrollment; a re-enroll creates a new row
    DEQUEUED = "dequeued"    # terminal: removed by a human/agent

class Enrollment(models.Model):
    repo = models.CharField(max_length=255)         # "owner/name"
    number = models.PositiveIntegerField()          # PR number
    head_sha = models.CharField(max_length=40)      # head being validated
    state = models.CharField(choices=EnrollmentState.choices, default=EnrollmentState.ACTIVE)
    approval_ref = models.CharField(max_length=255) # approving review; re-enroll lands under it (RFC §9, Cowboy §7)
    enrolled_by_id = models.CharField(max_length=255)
    enrolled_by_kind = models.CharField(max_length=16)            # ActorKind
    parent = models.ForeignKey("self", null=True, on_delete=models.SET_NULL,
                               related_name="children")           # stack dependency edge (RFC §9)
    eject_count = models.PositiveIntegerField(default=0)
    cycle_count = models.PositiveIntegerField(default=0)          # vs the Cowboy cycle cap (Cowboy §7)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    merged_at = models.DateTimeField(null=True)
    ejected_at = models.DateTimeField(null=True)

    class Meta:
        constraints = [
            # at most one ACTIVE enrollment per PR
            models.UniqueConstraint(fields=["repo", "number"], condition=Q(state="active"),
                                    name="uniq_active_enrollment_per_pr"),
        ]
        indexes = [models.Index(fields=["repo", "number"]), models.Index(fields=["state"])]
```

### A.3 Slot (per-partition membership + position)

```python
class SlotState(models.TextChoices):
    ENROLLED = "enrolled"    # holding a position, awaiting trial
    TRIALING = "trialing"    # a trial is running
    GREEN = "green"          # passed; waiting for sibling slots before the PR merges
    EJECTED = "ejected"      # trial failed (non-flaky)
    HELD = "held"            # blocked by an unlanded stack parent (RFC §9) or a freeze

class Slot(models.Model):
    enrollment = models.ForeignKey(Enrollment, on_delete=models.CASCADE, related_name="slots")
    partition = models.ForeignKey(Partition, on_delete=models.PROTECT, related_name="slots")
    state = models.CharField(choices=SlotState.choices, default=SlotState.ENROLLED)
    enqueued_at = models.DateTimeField()             # ORDERING KEY; reset on re-enroll → back of line (RFC §Ordering)
    current_trial = models.ForeignKey("Trial", null=True, on_delete=models.SET_NULL, related_name="+")
    projected_base_sha = models.CharField(max_length=40, null=True)     # base of the projected state
    projected_predecessor_shas = models.JSONField(default=list)         # in-flight predecessors (speculative)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["enrollment", "partition"], name="uniq_slot_per_partition"),
        ]
        indexes = [
            # the line within a partition: WHERE partition=? AND state=? ORDER BY enqueued_at, id
            models.Index(fields=["partition", "state", "enqueued_at"]),
        ]
```

**Ordering & merge gate.** The line in a partition is `Slot` rows for that partition ordered by
`(enqueued_at, id)`. Re-enroll (after eject, or knocked out by a merge ahead) writes a fresh
`enqueued_at` → back of line. A PR **merges** when _all_ of its enrollment's slots are `GREEN`; any slot
going `EJECTED` ejects the enrollment.

### A.4 Trial

```python
class TrialKind(models.TextChoices):
    SINGLE = "single"
    BATCH = "batch"

class TrialState(models.TextChoices):
    PENDING = "pending"
    RUNNING = "running"
    PASSED = "passed"
    FAILED = "failed"
    # note: freeze lets in-flight trials FINISH (RFC §10) — there is no "cancelled-by-freeze" state.

class Trial(models.Model):
    partition = models.ForeignKey(Partition, on_delete=models.PROTECT, related_name="trials")
    kind = models.CharField(choices=TrialKind.choices, default=TrialKind.SINGLE)
    slots = models.ManyToManyField(Slot, related_name="trials")     # one (single) or many (batch)
    state = models.CharField(choices=TrialState.choices, default=TrialState.PENDING)
    projected_base_sha = models.CharField(max_length=40)            # what the full suite ran against
    projected_head_shas = models.JSONField(default=list)            # predecessors folded into the projection
    workflow_id = models.CharField(max_length=255, null=True)       # Temporal handle (RFC §3)
    ci_run_ref = models.CharField(max_length=255, null=True)        # link to the CI run
    failing_tests = models.JSONField(null=True)                     # populated on FAILED
    flaky_retried = models.BooleanField(default=False)              # this trial was a flaky retry
    parent_trial = models.ForeignKey("self", null=True, on_delete=models.SET_NULL,
                                     related_name="bisection_children")   # bisection lineage (RFC §5.1)
    created_at = models.DateTimeField(auto_now_add=True)
    started_at = models.DateTimeField(null=True)
    finished_at = models.DateTimeField(null=True)

    class Meta:
        indexes = [models.Index(fields=["partition", "state"]), models.Index(fields=["workflow_id"])]
```

Every trial runs the **full suite** against `projected_base_sha` (+ `projected_head_shas`), no test
selection — the §5.2 invariant, enforced in `ci/scoping.py`, not configurable here.

### A.5 QueueEvent (append-only)

The single source for `engineering_analytics` emission (RFC §13), the break-glass audit (RFC §10), and
Cowboy's shadow-decision records (RFC §4.2). **Append-only**: never updated or deleted.

```python
class QueueEventType(models.TextChoices):
    ENROLLED = "enrolled"
    TRIAL_STARTED = "trial_started"
    TRIAL_FINISHED = "trial_finished"
    MERGED = "merged"
    EJECTED = "ejected"
    REQUEUED = "requeued"
    HELD = "held"
    DEQUEUED = "dequeued"
    FROZEN = "frozen"
    UNFROZEN = "unfrozen"
    CONFLICT = "conflict"
    BREAK_GLASS_USED = "break_glass_used"
    CYCLE_CAP_HIT = "cycle_cap_hit"
    SHADOW_DECISION = "shadow_decision"   # payload: {hook, would_be, taken}

class QueueEvent(models.Model):
    type = models.CharField(choices=QueueEventType.choices)
    enrollment = models.ForeignKey(Enrollment, null=True, on_delete=models.SET_NULL, related_name="events")
    slot = models.ForeignKey(Slot, null=True, on_delete=models.SET_NULL, related_name="events")
    trial = models.ForeignKey(Trial, null=True, on_delete=models.SET_NULL, related_name="events")
    partition = models.ForeignKey(Partition, null=True, on_delete=models.SET_NULL, related_name="events")
    actor_id = models.CharField(max_length=255, null=True)
    actor_kind = models.CharField(max_length=16, null=True)
    payload = models.JSONField(default=dict)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        indexes = [models.Index(fields=["type", "created_at"]), models.Index(fields=["enrollment"])]
```

**Invariant:** every state transition in A.1–A.4 writes exactly one `QueueEvent`. The engine never
mutates queue state without emitting one — that's what makes the observability stream complete and the
shadow harness trustworthy.

## Part B — Facade contract

`products/merge_queue/backend/facade/` — the only module surfaces, Cowboy, and the shadow harness may
import. Three files: `types.py` (DTOs/enums), `api.py` (imperative surface), `decisions.py` (hooks).

### B.1 Shared types — `facade/types.py`

```python
class ActorKind(StrEnum):
    HUMAN = "human"
    AGENT = "agent"
    COWBOY = "cowboy"
    SYSTEM = "system"

@dataclass(frozen=True)
class Actor:
    id: str
    kind: ActorKind
    display: str = ""
    @property
    def is_human(self) -> bool: return self.kind is ActorKind.HUMAN

@dataclass(frozen=True)
class PRRef:
    repo: str          # "owner/name"
    number: int
    head_sha: str

@dataclass(frozen=True)
class Scope:
    partition: str | None      # None = whole queue
    @classmethod
    def queue(cls) -> "Scope": return cls(partition=None)
    @classmethod
    def of(cls, name: str) -> "Scope": return cls(partition=name)

@dataclass(frozen=True)
class SlotStatus:
    partition: str
    state: str                 # SlotState value
    position: int              # 0-based index in the partition line
    current_trial_id: int | None
    projected_base_sha: str | None

@dataclass(frozen=True)
class EnrollmentStatus:
    pr: PRRef
    state: str                 # EnrollmentState value
    slots: list[SlotStatus]
    enrolled_by: Actor
    blocked_by: PRRef | None   # unlanded stack parent, if held (RFC §9)
    eject_count: int
    cycle_count: int
    enrolled_at: datetime
```

### B.2 Imperative surface — `facade/api.py`

All queue mutation goes through these. Each emits the matching `QueueEvent` (Part A.5). Synchronous
(Django ORM); `enroll` starts the Temporal trial workflow fire-and-forget.

```python
def enroll(pr: PRRef, *, actor: Actor) -> EnrollmentStatus:
    """Admit an eligible PR. Auto-called by the GitHub adapter; callable by humans/agents.
    Routes to its safe-set partitions (RFC §8), creates Enrollment + Slot(s), emits ENROLLED.
    Raises AlreadyEnrolled / NoMatchingPartition / NotEligible."""

def dequeue(pr: PRRef, *, actor: Actor, reason: str) -> None:
    """Remove an active enrollment. Emits DEQUEUED. Raises NotEnrolled."""

def status(pr: PRRef) -> EnrollmentStatus | None:
    """Read-only. None if the PR has no active enrollment."""

def freeze(scope: Scope, *, actor: Actor) -> None:
    """Pause merges for a partition or the whole queue. In-flight trials FINISH (RFC §10).
    Emits FROZEN."""

def unfreeze(scope: Scope, *, actor: Actor) -> None:
    """Resume; merging continues from persisted trial results. Emits UNFROZEN."""

def break_glass(pr: PRRef, *, actor: Actor) -> None:
    """Human-only forced merge / queue bypass. Emits BREAK_GLASS_USED.
    Raises NotHumanActor if actor.kind is not HUMAN — the one hard authz check (RFC §14)."""
```

```python
# exceptions
class FacadeError(Exception): ...
class AlreadyEnrolled(FacadeError): ...
class NotEnrolled(FacadeError): ...
class NotEligible(FacadeError): ...
class NoMatchingPartition(FacadeError): ...
class PartitionFrozen(FacadeError): ...
class NotHumanActor(FacadeError): ...      # raised only by break_glass
```

### B.3 Decision hooks — `facade/decisions.py`

The Stampede ↔ Cowboy seam. The engine calls a `DecisionProvider` at each branch point. Hooks are
**async** (Cowboy runs sandboxes). Each has a deterministic default; a `GatedProvider` composes the
default with Cowboy under the per-decision shadow/live gate (RFC §4.2).

```python
# ---- decision inputs/outputs ----
@dataclass(frozen=True)
class PartitionSignals:               # live signals for strategy selection (read from engineering_analytics)
    failure_rate: float
    queue_depth: int
    ci_cost_recent: float
    enrolled_count: int

@dataclass(frozen=True)
class StrategyDecision:
    strategy: Strategy
    speculation_depth: int | None
    max_batch_size: int | None
    reason: str

class CollisionBasis(StrEnum):
    NONE = "none"; STATIC = "static"; SEMANTIC = "semantic"

@dataclass(frozen=True)
class CollisionDecision:
    collides: bool
    confidence: float
    with_prs: list[PRRef]
    basis: CollisionBasis
    reason: str

class ConflictAction(StrEnum):
    AUTO_REBASE = "auto_rebase"; EJECT = "eject"

@dataclass(frozen=True)
class ConflictDecision:
    action: ConflictAction
    reason: str

@dataclass(frozen=True)
class TrialResult:                     # input to triage
    trial_id: int
    pr: PRRef
    partition: str
    failing_tests: list[str]
    attempt: int
    log_ref: str | None

class Disposition(StrEnum):
    RETRY_FLAKY = "retry_flaky"
    FAST_FIX = "fast_fix"
    DISPATCH_AGENT = "dispatch_agent"
    EJECT_TO_HUMAN = "eject_to_human"

@dataclass(frozen=True)
class TriageDecision:
    disposition: Disposition
    fix_plan: dict | None              # for FAST_FIX
    brief: str | None                  # for DISPATCH_AGENT
    reason: str

# ---- the provider protocol (Cowboy implements this; see cowboy-engineering-rfc.md) ----
class DecisionProvider(Protocol):
    async def select_strategy(self, partition: str, signals: PartitionSignals) -> StrategyDecision: ...
    async def predict_collision(self, pr: PRRef, projected: list[PRRef]) -> CollisionDecision: ...
    async def on_conflict(self, pr: PRRef, target_sha: str) -> ConflictDecision: ...
    async def triage_ejection(self, trial: TrialResult) -> TriageDecision: ...
```

**Deterministic defaults** — the engine's behavior with Cowboy off (fully specified; this is the
baseline the shadow harness scores against):

```python
class FlakyOracle(Protocol):
    def is_flaky(self, repo: str, test_id: str) -> bool: ...   # Mendral today → engineering_analytics (RFC §13)

class DeterministicDefaults:
    def __init__(self, flaky: FlakyOracle, pinned: Callable[[str], Strategy]):
        self._flaky = flaky
        self._pinned = pinned

    async def select_strategy(self, partition, signals) -> StrategyDecision:
        s = self._pinned(partition)
        return StrategyDecision(
            strategy=Strategy.SERIAL if s is Strategy.AUTO else s,   # auto → serial
            speculation_depth=None, max_batch_size=None, reason="pinned/default")

    async def predict_collision(self, pr, projected) -> CollisionDecision:
        return CollisionDecision(False, 0.0, [], CollisionBasis.NONE, "let the trial decide")

    async def on_conflict(self, pr, target_sha) -> ConflictDecision:
        return ConflictDecision(ConflictAction.EJECT, "default: eject to author")

    async def triage_ejection(self, trial) -> TriageDecision:
        if trial.failing_tests and all(self._flaky.is_flaky(trial.pr.repo, t) for t in trial.failing_tests):
            return TriageDecision(Disposition.RETRY_FLAKY, None, None, "all failing tests flagged flaky")
        return TriageDecision(Disposition.EJECT_TO_HUMAN, None, None, "non-flaky failure")
```

**The gate** — per-decision shadow/live composition; this is where §4.2 shadow recording happens:

```python
class PromotionState(Protocol):
    def is_live(self, hook: str) -> bool: ...   # backed by Cowboy's promotion.py

class GatedProvider:
    def __init__(self, default: DecisionProvider, cowboy: DecisionProvider | None,
                 promotion: PromotionState, record_shadow: Callable[..., Awaitable[None]]):
        self._default, self._cowboy, self._promotion, self._record = default, cowboy, promotion, record_shadow

    async def _gate(self, hook: str, args: tuple, kwargs: dict):
        default_fn = getattr(self._default, hook)
        if self._cowboy and self._promotion.is_live(hook):
            try:
                return await getattr(self._cowboy, hook)(*args, **kwargs)
            except Exception:
                logger.exception("cowboy %s failed; falling back to default", hook)
                return await default_fn(*args, **kwargs)
        taken = await default_fn(*args, **kwargs)
        if self._cowboy:                                  # SHADOW: act on default, record cowboy's would-be call
            asyncio.create_task(self._record(hook, args, kwargs, taken))   # writes a SHADOW_DECISION QueueEvent
        return taken

    async def select_strategy(self, *a, **k):  return await self._gate("select_strategy", a, k)
    async def predict_collision(self, *a, **k): return await self._gate("predict_collision", a, k)
    async def on_conflict(self, *a, **k):       return await self._gate("on_conflict", a, k)
    async def triage_ejection(self, *a, **k):   return await self._gate("triage_ejection", a, k)
```

### B.4 Contract invariants

1. **Every mutation emits a `QueueEvent`** (Part A.5). No queue state changes silently.
2. **`break_glass` is the only hard authz gate** — human-only, enforced in the facade (RFC §14). All
   other actions inherit repo access; the facade does not re-check.
3. **Cowboy imports `facade/` only** — `types.py`, `api.py`, `decisions.py`. It never touches
   `engine/`, `models.py`, or `router.py`. Enforced by `tach`.
4. **The deterministic defaults are the safety floor.** With `cowboy=None`, the engine is fully
   deterministic and self-sufficient; every Cowboy decision is still gated by a full-suite trial before
   merge, so a wrong/failed Cowboy call costs CI or throughput, never correctness.
5. **Shadow ⇒ act-on-default.** A hook in shadow always acts on the default and records Cowboy's
   would-be decision; promotion to live is per-hook (RFC §4.2, Cowboy §8).
