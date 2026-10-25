# SFTS scheduled fixture format v1

Use this contract to build the fixture application's Excel exporter. The fixture application owns the approved match running order. SFTS validates that order and follows it without reshuffling opponents or matches.

## Workbook layout

Export one `.xlsx` workbook per arena and competition. Event name, date, venue, arena and competition are still entered in SFTS before import. Use categories from the target machine's active rulepack. Import through Data Import, which sends `autoAdvance: true`.

1. `Matches` must be the first worksheet. It defines each category's opening bracket positions, including BYEs, using the existing 14 columns below.
2. `Schedule` must have this exact worksheet name. It defines the official running order of every scored bout through the finals. Put its headers in row 1.
3. `Categories`, `Instructions` and `Exclusions` are reference sheets. They are not imported.

The default template covers all 84 valid categories, 756 fictional players, 588 BYEs, 672 opening rows and 672 scored bouts. It alternates two categories until both finals finish. If the category count is odd, the last group contains three categories. Each category has nine players: one preliminary, four quarterfinals, two semifinals and one final. BYEs advance immediately and are excluded from Schedule.

## Matches: bracket positions

Exact columns, in order:

```text
Bout Number,Stage,Division,Gender,Weight Category,Group,Hong Name,Hong Club,Hong State Code,Hong District,Chung Name,Chung Club,Chung State Code,Chung District
```

Preserve relative row order within each category. Every player appears once in their category's opening positions. Player identity is the trimmed, uppercased name plus club. Keep names and clubs stable. Distinct players with the same name and club need distinct approved display identities; registration IDs are not part of this contract.

Use an actual name and club on each occupied side. For BYEs use `BYE` with blank club, state and district; both sides cannot be BYEs. State code and district are optional for actual players. Names/clubs have a 64-character limit, district 48, and state code must be a valid Indian state/UT code. Bout numbers are text, at most 40 characters, unique within their category without regard to case. Different categories may reuse a bout number.

Use `MALE` or `FEMALE`, and a valid rulepack division ID or label. Weight divisions require `Weight Category` and blank `Group`; group divisions require `Group` and blank `Weight Category`.

Opening row counts include BYEs and must be powers of two:

| Opening rows | Stage on every opening row |
| --- | --- |
| 1 | FINAL |
| 2 | SEMIFINAL |
| 4 | QUARTERFINAL |
| 8, 16, 32, 64, 128, 256 | PRELIMINARY |

Adjacent winners meet: opening rows 1 and 2 feed the next round's first bout, rows 3 and 4 feed its second bout, and so on. The first source feeds Hong/Red; the second feeds Chung/Blue. Repeat until the final. Larger brackets may have several preliminary rounds. Do not move Matches rows to solve a rest conflict; that changes opponents.

Round numbering starts at 1 for the opening round. Generated round 2 references are `AUTO-R2-001`, `AUTO-R2-002`, etc.; round 3 uses `AUTO-R3-001`, etc. On a case-insensitive collision with an existing reference, SFTS appends `-1`, `-2`, etc. Avoid using `AUTO-` for opening references so the exporter can reproduce generated names directly. The template shows all exact references on Schedule.

## Schedule: official arena order

Exact columns, in order:

| Column | Content |
| --- | --- |
| Match Order | Positive integer. Use every integer from 1 to total scored bout count exactly once. This is the arena running order. |
| Bout Number | Reference of an opening scored bout or a generated later-round bout. |
| Stage | Exact PRELIMINARY, QUARTERFINAL, SEMIFINAL or FINAL, matching the bracket. |
| Division | Same category definition as Matches. |
| Gender | Same category definition as Matches. |
| Weight Category | Same category definition as Matches; blank for group divisions. |
| Group | Same category definition as Matches; blank for weight divisions. |
| Hong Source | Opening scored bout: exact Hong player name. Later round: `Winner of ` followed by its Hong source bout's exact reference. |
| Chung Source | Equivalent source for Chung. |
| Minimum Match Gap | Numeric `1` on every row. |

Include every scored bout once, including future bouts whose winners are unknown. Exclude BYE bouts. Future sources can reference BYE opening rows in Matches and still use `Winner of <reference>`; SFTS resolves those winners automatically. Category fields disambiguate reused references such as `AUTO-R2-001`.

Keep rows physically in ascending Match Order for readers. SFTS follows numeric Match Order, not bout-reference sorting. Schedule sources describe the bracket, not a separate graph: the importer verifies that they agree with Matches.

## One-match rest rule

At least one other scored match must finish between any player's two appearances. BYEs, idle time, announcements, reset matches and practice matches do not supply a gap in this official schedule. The order must be valid for either winner of every source bout. SFTS checks all possible competitors rather than predicted winners.

For each category, finish all scored bouts in a round before any of its next round. Cross-category matches can occur between them. A standalone category with multiple rounds cannot provide a gap between its second semifinal and final: another category must supply the intervening match.

The template's first pair uses this sequence. A and B represent its first two categories; use the actual fields and bout references from the workbook.

| Match Order | Category A | Category B |
| --- | --- | --- |
| 1 / 2 | Preliminary | Preliminary |
| 3 / 4 | Quarterfinal 1 | Quarterfinal 1 |
| 5 / 6 | Quarterfinal 2 | Quarterfinal 2 |
| 7 / 8 | Quarterfinal 3 | Quarterfinal 3 |
| 9 / 10 | Quarterfinal 4 | Quarterfinal 4 |
| 11 / 12 | Semifinal 1 | Semifinal 1 |
| 13 / 14 | Semifinal 2 | Semifinal 2 |
| 15 / 16 | Final | Final |

The fixture application can choose another valid running order. Validate that every source precedes its dependent bout, category rounds never go backwards, and the possible competitor sets of consecutive scored bouts do not overlap. A possible competitor set is the union of the opening athletes feeding a bout, regardless of actual results. These conditions guarantee the gap for any outcome.

## Import and scoring behavior

The importer rejects incomplete schedules, duplicate/missing match orders, missing/duplicate/unknown bouts, BYE schedule entries, incorrect stages/sources, later rounds scheduled too early and possible consecutive appearances. Errors reject the whole import before replacing the active workbook.

After review and confirmation, the next-match card shows the official order number, category and actual competitors. Load Next Match selects that category and loads that exact bout. Category selectors remain available for bracket/results review but cannot bypass the official running order. A tie blocks advancement until its winner is confirmed. Result corrections retain existing dependent-match locks.

Restart retains the schedule and category progress. Reimport must preserve completed results as a prefix of the supplied running order. It cannot move an unplayed bout ahead of already scored matches. If removing a category would break the remaining rest gap, SFTS requires a revised valid schedule before deletion.

This is a single-arena schedule. Export a separate workbook for another arena. There is no automatic cross-arena rest coordination or results synchronization back to the fixture application.

## Compatibility and limits

- XLSX and XLS can carry Matches and Schedule. CSV cannot carry a second worksheet.
- Files without Schedule retain the legacy category-by-category flow and do not enforce this match-gap policy. Use the new template for scheduled tournaments.
- At most 128 categories, 4096 opening rows, 8192 Schedule rows and 4 MB per workbook. Each category supports 2–512 athletes and at most 256 opening rows.
- Template export remains Save Template to USB on the Event card. Restart the updated SFTS server before exporting/importing this format.

## Exporter acceptance checks

1. Import the supplied template and compare the next-match card against Schedule through both categories' finals.
2. Exercise Hong and Chung wins; opponents, sides and running order remain consistent.
3. Reject a schedule putting the preliminary winner straight into the next match, even if a predicted result avoids the conflict.
4. Reject a final directly after its category's second semifinal.
5. Change only Schedule order while preserving Matches positions; the bracket stays unchanged.
6. Restart after a completed bout and with a loaded bout; the official order resumes correctly.
7. Confirm that older opening-only workbooks still import through the legacy flow.
