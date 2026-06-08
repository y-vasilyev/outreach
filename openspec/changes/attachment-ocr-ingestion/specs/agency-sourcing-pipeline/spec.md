## ADDED Requirements

### Requirement: Pre-gate and extraction account for attachment signal

For `agency_sourcing` conversations with `attachment_ocr` + `object_storage` on, the profile-extract pre-gate SHALL NOT skip a message as `no_signal` purely because its TEXT is empty when it carries an OCR-able attachment; extraction SHALL run on the OCR text. When the flags are off, the pipeline behaves exactly as today.

#### Scenario: Attachment-only reply is not pre-gated out

- **WHEN** an inbound has empty text but a price-list image, with the flags on
- **THEN** the pre-gate does not skip it; OCR runs and its text is extracted

#### Scenario: Flags off ⇒ unchanged

- **WHEN** `attachment_ocr` is off
- **THEN** attachments are not read and the pipeline behaves byte-identically to before this change
