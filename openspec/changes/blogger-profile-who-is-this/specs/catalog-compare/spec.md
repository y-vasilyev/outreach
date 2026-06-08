## ADDED Requirements

### Requirement: Catalog search + side-by-side compare

The blogger catalog SHALL support free-text search over display name / topic / handle, and a compare mode that puts 2–4 selected bloggers side by side on the same dimensions: per-platform audience (`platformAudience`), prices per format, formats, and section freshness. This serves the standalone «collect a base → search & compare» path without requiring a brief.

#### Scenario: Search narrows the catalog

- **WHEN** the operator types a query
- **THEN** the catalog filters to bloggers whose name/topic/handle matches

#### Scenario: Compare two bloggers

- **WHEN** the operator selects two bloggers and opens compare
- **THEN** a side-by-side view shows each one's per-platform audience and prices per format on aligned rows

### Requirement: Operator controls are reachable from the UI

The inbox SHALL show a per-message extraction-status badge and a «Переанализировать» control (calling the existing reanalyze endpoint, updating live via `message.extraction_status.changed`), and the profile SHALL let an operator correct/delete a data point and add an extraction hint (calling the existing `operator-reanalyze-and-markup` endpoints). Attachments SHALL show their `ocrStatus`.

#### Scenario: Re-run from the inbox

- **WHEN** the operator clicks «Переанализировать» on an inbound
- **THEN** the message shows `pending` then the resulting status, and the profile reflects the re-extracted data

#### Scenario: Correct a wrong value

- **WHEN** the operator edits a data point to the correct value
- **THEN** the operator-origin value is written and the rolled-up profile updates
