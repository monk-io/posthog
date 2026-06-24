"""Flaky-test verdict behind the `FlakyOracle` abstraction (RFC §13).

The engine never judges flakiness itself — it reads a verdict. **Today** that is backed by
Mendral; **the plan** is an in-house signal in `engineering_analytics` (built on
`github_workflow_jobs.run_attempt`). The abstraction lets us cut over without touching engine
logic. A failure on a flagged-flaky test is retried and not charged to the PR; a failure on a
stable test ejects.
"""

from products.merge_queue.backend.facade.decisions import FlakyOracle


class MendralFlakyOracle:
    """Production oracle.

    TODO(RFC §13): wire to the Mendral flaky verdict, then cut over to the
    engineering_analytics flaky signal. M1 conservatively treats nothing as flaky, so every
    failure ejects (the safe direction — a real failure is never silently retried).
    """

    def is_flaky(self, repo: str, test_id: str) -> bool:
        return False


class StaticFlakyOracle:
    """A fixed set of flaky test ids — used by tests and as a manual override."""

    def __init__(self, flaky: set[str]) -> None:
        self._flaky = flaky

    def is_flaky(self, repo: str, test_id: str) -> bool:
        return test_id in self._flaky


def default_oracle() -> FlakyOracle:
    return MendralFlakyOracle()
