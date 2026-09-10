# Official Fixture Import Context

## Status

Planning context only. No official-fixture import functionality has been implemented from this document.

## Source Fixture Reviewed

`docs/Nadia_Single_Elimination_Fixtures_2026.pdf`

The complete 21-page management-committee fixture was reviewed. It is a machine-readable ReportLab PDF with a consistent vector-text bracket layout, so this particular format can be parsed without OCR.

Fixture summary:

- 93 total Kyorugi entries.
- 17 contested categories.
- 46 athletes in contested categories.
- 47 single-entry/direct-placement categories.
- 29 total bouts implied by the contested brackets (`46 - 17`).
- Bracket positions, affiliations, BYEs, and winner progression are represented.
- Only 20 first-round bout labels are visible; nine later-round bouts are implied by the bracket geometry and winner connections.

## Core Product Decision

Do not convert the committee PDF only into the existing SFTS Players sheet and then call the current tournament generator. The current import accepts a player roster and creates a new seeded-random draw, which would discard the committee's official bracket, BYEs, and participant positions.

The recommended solution is an **Official Fixture Import** mode that constructs the existing SFTS tournament model from an explicit official bracket and bypasses random bracket generation.

Target operator workflow:

1. Upload the committee PDF or a machine-readable fixture workbook.
2. Extract players, categories, bracket positions, BYEs, and progression links.
3. Show a short review screen containing only errors and unresolved decisions.
4. Confirm Sub Junior groups, possible duplicate athletes, red/blue convention, and event running order.
5. Validate the complete tournament graph.
6. Commit the tournament to SFTS.
7. Optionally save the normalized SFTS fixture workbook to USB for audit or reuse.

## Recommended Interchange Workbook

Use a structured **SFTS Fixture Workbook** as the canonical intermediate format. Users should not be expected to prepare this workbook manually. A PDF importer or the committee's fixture generator should create it automatically.

### Players sheet

Recommended fields:

- Player ID
- Name
- Competition
- Gender
- Division
- Weight Category
- Group
- Affiliation/Club
- State Code
- District
- Source page
- Source bracket position

### Bouts sheet

Recommended fields:

- Fixture/bracket ID
- Global bout number
- Competition
- Division
- Gender
- Category or Sub Junior group
- Round
- Red player ID or red source bout number
- Blue player ID or blue source bout number
- Next bout number
- Next-bout position
- Arena
- Session/running-order position

### Direct Placements sheet

Store single-entry categories separately so they are completed as official direct placements without creating artificial matches.

### Import Review sheet

Record unresolved or corrected information, including:

- Missing or generated player IDs
- Possible duplicate names
- Sub Junior group assignments
- Competition-type mapping
- Category aliases
- Red/blue assignments
- Running-order decisions

## Compatibility With the Existing Backend

The existing tournament model already contains most of the required concepts:

- `players`
- `groups`
- `schedule`
- `byes`
- `redSourceBoutNo`
- `blueSourceBoutNo`
- bracket results and placements

An official-fixture importer should create these records directly rather than calling the existing seeded-random `generateTournament` path. The scoring engine, referee remotes, scoreboard, and match controls should remain unchanged.

Single-entry groups are already capable of becoming completed first-place results through the `ONLY_ENTRANT` placement basis, provided their competition category can be represented without colliding with another event.

## Required Data and Policy Resolutions

### Sub Junior mismatch

The reviewed PDF contains 18 Sub Junior entries divided by weight ranges, for example `14-16 kg`, `29-32 kg`, and `50-60 kg`.

The agreed SFTS rule is different:

- Division name: `SUB JUNIOR`.
- Height must not be considered.
- The operator manually supplies `GROUP 0` through `GROUP 5`.
- Groups are based on age eligibility as defined by the active rule pack.

The PDF does not contain the required group or age information, so Sub Junior entries cannot be mapped automatically. Once groups are assigned, athletes shown as single entries in different weight ranges may fall into the same group and require bouts. The management committee must therefore approve or regenerate the Sub Junior draw after group assignment. SFTS must not silently reinterpret these entries.

### Competition type

The PDF distinguishes:

- `KYORUGI`
- `FRESHER KYORUGI`

The current grouping key is division, gender, and category. Ignoring competition type could merge fresher and regular athletes into the same bracket. Add a competition/event-class field and group by:

`COMPETITION + DIVISION + GENDER + CATEGORY`

This should be represented in the tournament data model and validated by the active rule pack or another approved competition configuration.

### Weight-category aliases

The PDF uses numeric labels such as `UNDER 42 KG`, `44-47 KG`, and `OVER 78 KG`, while SFTS stores category names such as `FINWEIGHT`, `WELTERWEIGHT`, and `HEAVYWEIGHT`.

For Senior, Junior, and Cadet divisions, the importer can map a PDF range to a rulepack category using division, gender, and the category limits. The mapping must be shown in the import review and rejected when it is ambiguous or outside the active rule pack.

Do not treat a numeric range as sufficient for Sub Junior, because Sub Junior uses manually supplied groups rather than weight categories.

### Player identity

The PDF does not contain stable registration/player IDs. The importer may generate deterministic temporary IDs from the source document, page, bracket, and position, but it must flag duplicate or very similar names for operator confirmation.

One reviewed bracket contains both:

- `MUKESH KUMAR THAKUR`
- `MUKESH KUMAR THAKU`

Both show the same affiliation. This may be a valid pair of athletes, a clipped name, or a duplicate entry and must not be resolved automatically.

### Bout numbering and running order

The PDF labels first-round matches within category pages, but later-round matches are represented by generic winner boxes such as `WINNER R1` and `WINNER R2`. It does not provide a complete global tournament bout order.

The importer can reconstruct the bracket graph from positions and connector geometry, but the operator or committee must supply the event-wide sequence. A future review UI should support fast ordering and, where relevant, arena assignment.

### Red and blue assignment

The bracket fixes athlete positions but does not explicitly establish scoreboard red and blue sides. Use a federation-approved rule, such as upper bracket position to RED and lower position to BLUE, or require confirmation when loading the bout. Do not make an undocumented random assignment.

### Affiliation normalization

The fixture states that affiliation aliases were normalized for draw separation. SFTS should preserve the displayed affiliation while optionally keeping a separate normalized comparison value. Truncated or inconsistent affiliation text must be shown for review rather than silently rewritten.

## Validation Requirements

Before committing an imported official fixture, require all of the following:

- Every player ID is unique.
- Every category is valid under the active competition configuration.
- Fresher and regular competition entries cannot collide.
- Every Sub Junior player has a manually confirmed group.
- Each contested single-elimination bracket with `N` players has exactly `N - 1` bouts.
- Every source-bout reference exists and points from an earlier round to a later round.
- Each non-final bout feeds exactly one later position.
- Every bracket has exactly one final path and no cycles or orphan bouts.
- BYEs reproduce the official bracket positions.
- Direct placements do not create scheduled bouts.
- The complete global bout numbering/running order is unique.
- Red and blue participants or sources are resolvable before a bout becomes scheduled.
- The import is rejected atomically if validation fails; no partial tournament state is saved.

## Preferred Source Strategy

If the committee controls the software that generated the PDF, request a companion Excel, CSV, or JSON fixture export. The ideal export includes athlete IDs, competition type, category data, bracket positions, source-bout links, BYEs, and global running order.

Support both paths:

1. **Committee machine-readable export** - preferred and most reliable.
2. **Standardized PDF parser** - fallback for the reviewed ReportLab layout, followed by operator review.

The original source PDF and a checksum should be retained with the normalized import record for auditability.

## Performance and Deployment

Parsing this vector-text PDF is lightweight and should be practical on a Raspberry Pi 3 when performed before matches. OCR is not required for this exact format. Fixture parsing and validation should not run during an active scoring match.

## Expected Future Implementation Scope

Keep future changes limited to tournament import and configuration concerns:

- A new fixture parser/import module.
- Tournament schema support for competition type and explicit official brackets.
- A fixture review/validation interface in Player Settings.
- USB export of the normalized fixture workbook.
- Rulepack or competition-configuration validation where required.
- Persistence validation/migration for the new tournament fields.
- Automated tests for official draw preservation, BYEs, direct placements, Fresher separation, Sub Junior review, duplicates, and malformed bracket graphs.

Do not change scoring rules, referee-remote behavior, scoreboard presentation, timer behavior, or existing match controls as part of this feature unless a separately verified dependency requires it.
