## MODIFIED Requirements

### Requirement: Structured AJTBD field on Campaign

AJTBD is the goal schema of the `custdev` campaign type within the campaign-type registry, not a field mandatory on every campaign. For campaigns of type `custdev`, the system SHALL store an AJTBD object in `campaign.goal`, validated via zod against the `custdev` type's `goal_schema` at write time, with the following shape:

```
{
  job: string,
  when: string,
  forces: {
    push: string[],
    pull: string[],
    anxieties: string[],
    habits: string[]
  },
  desired_outcome: string,
  non_goals: string[]
}
```

Campaigns of other types (e.g. `agency_sourcing`) store their own type-specific goal object and SHALL NOT be required to carry an AJTBD.

The legacy `Campaign.ajtbd` JSON column SHALL NOT exist in the database; the migration removes it after the existing rows' AJTBD values are backfilled into `Campaign.goal`. The API request/response schemas SHALL NOT expose an `ajtbd` field; the only AJTBD-carrying field is `Campaign.goal`.

#### Scenario: Valid AJTBD is accepted for custdev campaigns

- **WHEN** an admin client submits a `custdev` campaign create or update request with a well-formed AJTBD object in `campaign.goal`
- **THEN** the campaign is persisted with the supplied AJTBD

#### Scenario: Invalid AJTBD is rejected with a 400

- **WHEN** an admin client submits a `custdev` campaign whose goal fails AJTBD zod validation (wrong types, missing required keys)
- **THEN** the API responds with a 400 and a machine-readable error referencing the failing path

#### Scenario: Non-custdev campaigns are not required to carry AJTBD

- **WHEN** an admin creates an `agency_sourcing` campaign with a valid agency goal object and no AJTBD
- **THEN** the campaign is persisted and no AJTBD validation error is raised

#### Scenario: Legacy `Campaign.ajtbd` column is absent

- **WHEN** a developer inspects the schema (`packages/db/prisma/schema.prisma`) or runs `psql ... '\d "Campaign"'` on a fully-migrated database
- **THEN** no `ajtbd` column SHALL be present on `Campaign`; the only goal storage SHALL be `Campaign.goal`

#### Scenario: API surface does not expose `ajtbd`

- **WHEN** an admin client inspects the `CampaignZ` / `CreateCampaignInputZ` / `UpdateCampaignInputZ` schemas (or the OpenAPI surface)
- **THEN** no `ajtbd` field SHALL be present; the schemas are not `.strict()`, so an `ajtbd` key in a request body is silently stripped by Zod rather than rejected. It MUST NOT be persisted as a separate column, and the only AJTBD-carrying field remains `Campaign.goal`
