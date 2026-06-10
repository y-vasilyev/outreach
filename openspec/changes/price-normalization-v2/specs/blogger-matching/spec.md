## ADDED Requirements

### Requirement: Budget fit compares in normalized RUB

Budget prefilter and `budgetScore` SHALL evaluate offers via `priceRubMin`, falling back to the raw `price` when normalized columns are null (unknown currency, pre-migration rows). For an all-RUB catalog with no ranges the matching output SHALL be byte-identical to the pre-change behavior (regression fixture). `fitSignals` SHALL include `{cpmRub, currency, fxAsOf}` for cited offers and the rationale SHALL mention CPM when present; score weights are unchanged.

#### Scenario: USD offer meets a RUB budget correctly

- **WHEN** a brief has budget 30 000 ₽ and a profile's only relevant offer is $400 with USD rate 92.4
- **THEN** the offer is evaluated as 36 960 ₽ and the profile is excluded as over budget — whereas the raw comparison (400 < 30 000) would have wrongly shortlisted it

#### Scenario: All-RUB catalog is regression-safe

- **WHEN** matching runs over a catalog where every offer is RUB with `fxRateUsed=1` and no ranges
- **THEN** scores, order, and rationales are identical to the pre-change implementation

#### Scenario: CPM informs but does not rank

- **WHEN** two candidates have equal scores and different CPM
- **THEN** their relative order is unchanged by CPM, and both `fitSignals` expose their `cpmRub`
