## ADDED Requirements

### Requirement: Offer rows carry normalized comparison columns

`placement_offer` SHALL gain nullable derived columns `priceRubMin`, `priceRubMax`, `fxRateUsed`, `fxAsOf`, `cpmRub`, `viewsBasis`, `viewsSource`, populated exclusively by `normalizeOffer()` at write time and by the `offer-renormalize` job. `priceMax = null` with non-null `priceMin` SHALL mean an open-ended «от»-range. Raw columns remain immutable as already required.

#### Scenario: Open-ended range is representable

- **WHEN** «от 118 000 ₽» is extracted
- **THEN** the row stores `priceMin=118000`, `priceMax=null`, `rawPrice='от 118 000'`, and RUB columns mirror the same open range

#### Scenario: Write-time normalization

- **WHEN** the worker writes a new USD offer row and a USD rate exists
- **THEN** the row lands with RUB columns already filled and stamped with the rate used
