## ADDED Requirements

### Requirement: Channel scrape triggers guided-discovery review

When a `channel-scrape` job finishes — on success AND on FINAL failure — the worker SHALL, in addition to its existing behavior, trigger a guided-discovery review for every reviewable `DiscoveryRunCandidate` that references the scraped channel and belongs to a run that is still `running` or `enriching`. A candidate is reviewable when it has no review yet OR has been re-armed for a refresh (so an already-reviewed candidate that an operator re-scraped is re-reviewed rather than skipped). On success the trigger SHALL carry that public evidence is now available; on failure it SHALL carry that the scrape failed so the candidate can be closed as insufficient-evidence rather than left pending forever.

The failure trigger SHALL fire only on the scrape job's FINAL failure (after BullMQ retries are exhausted), NOT on a retryable per-attempt error, so a candidate is not marked insufficient-evidence while a subsequent retry could still succeed; discovery-originated scrapes SHALL be enqueued such that the final-failure trigger fires promptly (e.g. a single attempt). The trigger SHALL use a deterministic per-candidate review job identity so duplicate fires are deduplicated. This hook SHALL NOT alter the existing scrape outcome or the existing `contact-extract` chaining, and SHALL be best-effort (its own failure SHALL be logged and SHALL NOT fail the scrape job).

#### Scenario: Successful scrape re-reviews linked discovery candidates
- **WHEN** a `channel-scrape` job for a channel completes successfully and that channel is referenced by an unreviewed candidate of a `running`/`enriching` guided discovery run
- **THEN** the worker enqueues a guided-discovery review for that candidate (so it gets a score/recommendation), AND still enqueues the existing `contact-extract` job

#### Scenario: Final scrape failure unblocks linked discovery candidates
- **WHEN** a `channel-scrape` job reaches its FINAL failure (retries exhausted) for a channel referenced by a reviewable candidate of a `running`/`enriching` run
- **THEN** the worker enqueues a guided-discovery review marked as a scrape failure so the candidate is recorded with an insufficient-evidence reason and stops counting toward the run's pending review

#### Scenario: A retryable scrape error does not prematurely close the candidate
- **WHEN** a `channel-scrape` attempt errors but BullMQ will retry it
- **THEN** the failure trigger does NOT fire for the linked discovery candidates on that attempt, so a subsequent successful retry can still produce a real evidence-backed review

#### Scenario: Re-scraped already-reviewed candidate is re-reviewed
- **WHEN** an operator re-scrapes a channel whose linked discovery candidate was already reviewed and re-armed via `scrape_refresh`
- **THEN** the hook selects that candidate (despite its non-null prior review) and enqueues a fresh review so its score/recommendation are recomputed

#### Scenario: Hook does not affect non-guided scrapes
- **WHEN** a `channel-scrape` job finishes for a channel that is not referenced by any non-terminal guided discovery candidate
- **THEN** the worker performs its existing behavior (update channel, post-insights, enqueue `contact-extract` on success) with no guided-review jobs enqueued

#### Scenario: Hook failure does not break scraping
- **WHEN** the guided-review lookup or enqueue throws
- **THEN** the error is logged and the `channel-scrape` job's own success/failure result is unchanged
