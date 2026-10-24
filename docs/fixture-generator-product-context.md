# Fixture Generator Product Context

## Status

For the current implementation brief and exact SFTS export requirements, use [Tournament fixture software development context](tournament-fixture-development-context.md). The document below preserves the earlier product exploration; its proposed full-graph export fields are not the current opening-fixture import contract.

Planning context only. No fixture-generator or scoreboard-import functionality has been implemented from this document.

## Competitor Workflow Observed

The competitor's scoreboard system does not appear to generate tournament fixtures itself. The current observed workflow is:

1. The event organizer gives participant entries to the scoreboard operator on the night before the tournament.
2. The operator enters and formats the information in an Excel workbook using an unknown template.
3. The workbook is sent to DoSports.
4. DoSports uses separate software to generate the tournament fixtures and match brackets.
5. DoSports returns a final Excel workbook to the scoreboard operator for use during the tournament.

The exact Excel layouts and the fixture-generation rules used by DoSports are not yet known.

## Product Direction

SFTS does not need to reproduce the competitor's workflow or copy the DoSports workbook format. The preferred direction is to develop an independent fixture generator using SFTS-defined tournament logic and export a standardized Excel workbook that is directly compatible with the SFTS scoreboard.

Target workflow:

`Participant entries -> SFTS fixture generator -> Operator review and approval -> SFTS Excel export -> SFTS scoreboard import`

Excel should be treated as an interchange and audit format, not as the fixture generator's internal data model. The internal model should remain structured so that a direct database or API connection to the scoreboard can be added later.

## Expected Export Data

The exact schema will be finalized after more tournament information is collected. It is expected to include:

- Stable match and participant identifiers.
- Event, competition, division, gender, and weight category.
- Bracket and round information.
- Red-side and blue-side participants or source-match references.
- Next-match and next-position references.
- Seeds, affiliations, and byes.
- Match running order, court or arena, and scheduled time when applicable.
- Match status and any required scoreboard initialization data.

Bracket relationships should use machine-readable match references instead of relying only on display text such as `Winner of Match 5`.

## Rules Requiring Confirmation

Before implementing the generator, collect and confirm the rules for:

- Single-elimination, league, and pool-to-knockout formats.
- Seeding and random draw behavior.
- Bye allocation.
- Separation of athletes from the same club, team, district, or region.
- Red and blue side assignment.
- Court allocation and tournament-wide match ordering.
- Walkovers, withdrawals, late entries, and re-draws.
- Manual bracket adjustments and approval before publication.

## Information to Collect

Useful future reference material includes:

- Real participant-entry workbooks.
- Final fixture workbooks returned to operators.
- Printed or digital bracket examples.
- Applicable tournament rulebooks.
- Screenshots or recordings of the operator workflow.
- Required scoreboard import fields and validation behavior.

Competitor and DoSports files may be reviewed to understand practical operator needs, but they are reference material rather than the technical blueprint for SFTS.

## Current Decision

Build an SFTS-owned fixture-generation module with its own documented and testable logic, followed by an SFTS-specific Excel export that the scoreboard can validate and import. Defer implementation until sufficient real-world samples and tournament rules are available.
