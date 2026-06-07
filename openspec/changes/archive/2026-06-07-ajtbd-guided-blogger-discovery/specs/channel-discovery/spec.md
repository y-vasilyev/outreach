## ADDED Requirements

### Requirement: Traceable multi-query search execution

The channel discovery search layer SHALL support execution of a planned set of web-search queries and return sanitized trace metadata for each query: exact query text, platform filter, status, result count, candidate count, error if any, and timestamps. This traceable execution SHALL be reusable by guided blogger discovery while preserving existing low-level single and batch discovery behavior.

#### Scenario: Planned queries return trace metadata
- **WHEN** a caller executes channel discovery with a list of planned queries
- **THEN** the result includes one trace record per executed query with query text, platform, status, result count, candidate count, and timestamp

#### Scenario: Query-level failure is isolated
- **WHEN** one query in the planned set fails but another succeeds
- **THEN** the search layer reports the failed query in trace metadata, returns candidates from successful queries, and does not throw away the whole planned run unless every query fails before producing candidates

#### Scenario: Existing single-search behavior remains available
- **WHEN** an admin/operator calls the existing `POST /discovery/search` endpoint
- **THEN** the endpoint still returns the existing `DiscoveryResult` shape and persists/enqueues new channels as before

### Requirement: Candidate source provenance

Every candidate produced by channel discovery SHALL retain source provenance linking it to the run/query that found it. Provenance SHALL include the original search result URL/title, normalized platform/handle, source query, and whether the channel was newly created or already known.

#### Scenario: Candidate records include source query
- **WHEN** a candidate is normalized from a Yandex result
- **THEN** the candidate payload includes the source query that found it and the original result URL/title

#### Scenario: Duplicate candidates keep useful provenance
- **WHEN** the same platform/handle is found by multiple planned queries
- **THEN** the candidate is deduplicated for persistence but the run detail preserves enough provenance to show which queries found it
