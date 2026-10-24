# Tournament fixture software development context

Build a separate Taekwondo tournament fixture application that prepares approved brackets for the existing SFTS scoring software. The fixture application decides the opening opponents, Hong/Chung assignments, BYEs and bracket positions. SFTS imports those positions, scores the matches and advances winners locally through the final.

This brief describes the implemented SFTS opening-fixture contract and a proposed scope for the new fixture application. It supersedes earlier planning assumptions about exporting a full tournament graph to SFTS. No fixture application or direct integration is implemented by this document.

## Responsibilities

| Fixture application | Existing SFTS scoring software |
| --- | --- |
| Collect and validate participant entries. | Collect event details on the Event card. |
| Separate entries into competition categories. | Validate the imported category against the active rulepack. |
| Generate the draw using the selected, documented tournament policies. | Preserve imported opponents, sides, BYEs and row order. |
| Assign opening Hong/Red and Chung/Blue positions. | Load and score bouts in bracket order. |
| Show the full projected bracket for organizer review. | Advance actual winners and BYEs without a redraw. |
| Approve and export one tournament file containing every category's opening positions. | Offer division, gender and category selection, retain each bracket's progress, and generate later-round bouts and placements. |

The fixture application may display the entire bracket with future winner references. Its SFTS export contains only the opening positions, including BYE rows. SFTS does not need to reconnect to the fixture application between rounds.

## Organizer workflow

1. Create an event: tournament name, date, venue, competition and arenas.
2. Add or import athletes with stable registration IDs, names, clubs, gender and the data needed to determine their eligible categories.
3. Assign each athlete to a valid rulepack division and weight category or group. Show ambiguous eligibility for organizer resolution.
4. Separate regular `KYORUGI` and `FRESHER KYORUGI` entries. Group within each competition by division, gender and category.
5. Select draw policies and generate a bracket for each contested category.
6. Review opponents, sides, seeds, BYEs and any unmet separation preferences. Allow manual adjustments before approval.
7. Approve the draws and export one SFTS workbook containing all categories for the selected competition. Store the approved revision and export for later reference.
8. In SFTS, enter the event details manually, import the file, choose Division → Gender → Category, review the bracket and confirm it. Score locally through the final, or select another stored category without importing again.

## Current compatibility requirements

- Initial format: single elimination, with two bronze placements derived from semifinal losers in SFTS. Other tournament formats need separate future support.
- One exported file represents one manually selected competition and may contain multiple divisions, genders and weight categories or groups on its first worksheet. Repeat the category fields on every row. SFTS groups rows by division, gender and weight category/group while preserving each group's row order.
- Export `.xlsx` as the primary format. SFTS also accepts `.xls` and `.csv`.
- The first worksheet must contain the import table. Use `Matches` as its name and put the column headers in row 1, without title rows above them.
- The established template also has `Categories` and `Instructions` worksheets after `Matches`. SFTS reads only the first worksheet. Any additional sheets are reference material.
- Export only opening positions. Each athlete appears exactly once within its category. Do not include later-round placeholders or repeat athletes in future bouts.
- Row order determines bracket connections. Bout numbers are references, not sorting instructions. Never alphabetically or numerically re-sort approved export rows.
- Hong means Red. Chung means Blue. SFTS uses the supplied assignments without randomization.
- Limits per file: 128 categories, 4096 opening rows and 4 MB. Limits per category: 512 athletes, 256 opening rows including BYEs and 511 total bracket nodes.
- Categories with zero or one athlete must be handled separately in the fixture application. The current scored-category import requires at least two actual competitors and does not accept a single-entry medal allocation.

## Category and event data

Use category definitions from the same active SFTS rulepack. The current template's `Categories` worksheet lists valid categories; `config/rules.default.json` is a repository reference for the default pack and supports JSON comments. A deployment may load a different pack.

For a weight division, export the rulepack's category name in `Weight Category` and leave `Group` blank. For a group division, export its rulepack group name in `Group` and leave `Weight Category` blank. Do not invent categories or assume weight limits are identical across genders. Normalize imported affiliation aliases for draw comparisons while preserving the approved display name.

Tournament name, date, venue, arena and competition are entered manually in SFTS and apply to all categories in the workbook. Putting them on a second sheet does not populate the Event card. Supply the operator with these details alongside the export, especially the competition type, because it is not a column in the current import table.

Use a valid date in `YYYY-MM-DD` format and an arena number from `1` to `999`. SFTS supports `KYORUGI` and `FRESHER KYORUGI` as separate competitions. Keep these in separate tournament files because competition remains a manual event setting.

## Exact export columns

Use all 14 headers below in this order. Keep bout identifiers as text so spreadsheet software preserves leading zeroes.

| Column | Content |
| --- | --- |
| Bout Number | Required, unique within its category, at most 40 characters. Duplicate comparison is case-insensitive. |
| Stage | Same opening stage on every row within its category, including BYE rows. See the size table below. |
| Division | Valid active-rulepack division ID or display label. Repeat on every row. |
| Gender | Use `MALE` or `FEMALE`. Repeat on every row. |
| Weight Category | Required for weight divisions; otherwise blank. Repeat the category on every row. |
| Group | Required for group divisions; otherwise blank. Repeat the group on every row. |
| Hong Name | Actual Red competitor's name, at most 64 characters, or `BYE`. |
| Hong Club | Required for an actual competitor, at most 64 characters; blank for a BYE. |
| Hong State Code | Optional valid SFTS Indian state/UT code; blank for a BYE. |
| Hong District | Optional, at most 48 characters; blank for a BYE. |
| Chung Name | Actual Blue competitor's name, at most 64 characters, or `BYE`. |
| Chung Club | Required for an actual competitor, at most 64 characters; blank for a BYE. |
| Chung State Code | Optional valid SFTS Indian state/UT code; blank for a BYE. |
| Chung District | Optional, at most 48 characters; blank for a BYE. |

Blank names are also accepted for BYEs, but explicit `BYE` is clearer. An empty side must have blank club, state and district fields. Both sides of a row cannot be BYEs. Do not use `TBD`, `TBA` or `Winner of Bout ...` as an opening competitor.

Current SFTS import identity uses the trimmed, uppercased combination of player name and club. Two distinct athletes with the same name and club cannot be distinguished by an extra registration-ID column. Flag this for operator resolution; adding stable participant IDs to the interchange requires an SFTS contract change. Preserve names and clubs once scoring begins.

## Bracket size, BYEs and opening stage

For `N` athletes, use the smallest power of two `B` that is at least `N`. The bracket contains `B` athlete slots, `B / 2` opening rows and `B - N` BYEs. Allocate BYEs so no opening row has two empty sides.

| Athletes | Bracket slots | Opening rows | Stage on every exported row |
| --- | --- | --- | --- |
| 2 | 2 | 1 | `FINAL` |
| 3–4 | 4 | 2 | `SEMIFINAL` |
| 5–8 | 8 | 4 | `QUARTERFINAL` |
| 9–16 | 16 | 8 | `PRELIMINARY` |
| 17–32 | 32 | 16 | `PRELIMINARY` |
| 33–64 | 64 | 32 | `PRELIMINARY` |
| 65–128 | 128 | 64 | `PRELIMINARY` |
| 129–256 | 256 | 128 | `PRELIMINARY` |
| 257–512 | 512 | 256 | `PRELIMINARY` |

Smaller categories start directly at their appropriate stage. Larger brackets can have several preliminary rounds before quarterfinals. The number of contested matches in a completed single-elimination category is `N - 1`; BYEs do not create scored match records.

The 9-athlete test category is the smallest standard bracket that exercises all four stages: seven BYEs, one contested preliminary, four quarterfinals, two semifinals and one final. It has 15 bracket nodes but only eight contested matches.

## How SFTS connects later rounds

SFTS pairs adjacent opening rows, then repeats that rule for each subsequent round:

| New bout | Hong / Red source | Chung / Blue source |
| --- | --- | --- |
| Next-round bout 1 | Winner of opening row 1 | Winner of opening row 2 |
| Next-round bout 2 | Winner of opening row 3 | Winner of opening row 4 |
| Next-round bout 3 | Winner of opening row 5 | Winner of opening row 6 |
| Next-round bout 4 | Winner of opening row 7 | Winner of opening row 8 |
| Semifinal 1, for this eight-row example | Winner of next-round bout 1 | Winner of next-round bout 2 |
| Semifinal 2, for this eight-row example | Winner of next-round bout 3 | Winner of next-round bout 4 |
| Final | Winner of semifinal 1 | Winner of semifinal 2 |

A BYE row's actual athlete is its winner and advances immediately. A competitor's side in a later round depends on the source bout's bracket position, not their previous chest-guard color. The fixture application's projected bracket must use this same convention.

SFTS creates later-round references such as `AUTO-R2-001`; it adds suffixes when needed to avoid collisions. These are generated references, not official future bout numbers imported from the fixture application. Custom event-wide numbering or a different progression graph needs a future integration change.

## Complete nine-athlete example

This is an illustrative `SENIOR / MALE / FLYWEIGHT` category. Confirm that category exists in the target deployment's active rulepack. The names and clubs are fictional sample data.

```csv
Bout Number,Stage,Division,Gender,Weight Category,Group,Hong Name,Hong Club,Hong State Code,Hong District,Chung Name,Chung Club,Chung State Code,Chung District
SM-FLY-P01,PRELIMINARY,SENIOR,MALE,FLYWEIGHT,,Arjun Sen,Falcon Taekwondo,WB,Nadia,Rohan Das,Riverfront Martial Arts,WB,Nadia
SM-FLY-P02,PRELIMINARY,SENIOR,MALE,FLYWEIGHT,,Kabir Roy,Summit Taekwondo,WB,Nadia,BYE,,,
SM-FLY-P03,PRELIMINARY,SENIOR,MALE,FLYWEIGHT,,Ishaan Ghosh,Falcon Taekwondo,WB,Nadia,BYE,,,
SM-FLY-P04,PRELIMINARY,SENIOR,MALE,FLYWEIGHT,,Vivaan Dutta,Riverfront Martial Arts,WB,Nadia,BYE,,,
SM-FLY-P05,PRELIMINARY,SENIOR,MALE,FLYWEIGHT,,Aarav Bose,Summit Taekwondo,WB,Nadia,BYE,,,
SM-FLY-P06,PRELIMINARY,SENIOR,MALE,FLYWEIGHT,,Neel Banerjee,Falcon Taekwondo,WB,Nadia,BYE,,,
SM-FLY-P07,PRELIMINARY,SENIOR,MALE,FLYWEIGHT,,Dhruv Pal,Riverfront Martial Arts,WB,Nadia,BYE,,,
SM-FLY-P08,PRELIMINARY,SENIOR,MALE,FLYWEIGHT,,Aditya Saha,Summit Taekwondo,WB,Nadia,BYE,,,
```

Here, the first quarterfinal is the winner of Arjun/Rohan versus Kabir. The second is Ishaan versus Vivaan, the third is Aarav versus Neel, and the fourth is Dhruv versus Aditya. The generator chooses these positions before export; SFTS does not redraw them. Add other categories' opening rows under the same headers to build a combined tournament file. With the default rulepack, the USB template adds three two-player finals: another category under the same division and gender, a female category within that division, and a male category in another division. Its 15 fictional players across four categories exercise all three selectors independently while retaining the full-round/BYE test.

## Draw policies to define in the fixture application

These are product decisions, not federation rules established by the SFTS import format:

- Random or seeded draw, seed placement and who receives BYEs.
- Whether Hong/Chung opening sides are randomized or follow an approved position convention.
- Club, team, district and state separation: which constraints are required, which are preferences, and how conflicts are reported.
- Eligibility cutoff dates, category assignment and organizer overrides.
- Treatment of late entries, withdrawals, walkovers and redraws.
- Arena allocation, sessions and event-wide match ordering.

Recommended implementation: store the selected policies and a reproducible draw seed with each revision. Validate required constraints first, then optimize preferences. If requirements cannot all be satisfied, explain the conflict for organizer resolution. Once approved, freeze the draw; redrawing creates a new revision rather than silently changing the exported file. Do not regenerate random opponents or sides every time the organizer downloads an approved fixture.

## Suggested internal model

Use structured records rather than treating Excel as the application database:

- Event: ID, name, date, venue, competitions, arenas and rulepack version.
- Athlete: stable ID, display name, club/affiliation, normalized club key, gender, eligibility data, category assignment, state and district.
- Category: ID, event, competition, division, gender, weight category or group, and ordered athlete IDs.
- Draw: category ID, revision, policy settings, random seed, ordered slots, approval status and timestamp.
- Bracket bout: stable ID, round, position, stage, Hong/Chung athlete or source-bout references, and BYE status.
- Export: approved draw revision, filename, export timestamp and content hash.

Maintain source-bout links internally to render the full bracket. The export adapter translates only the opening positions into the current 14-column `Matches` sheet. Stable IDs, schedules and future links kept internally are not automatically consumed by the current SFTS importer.

## Import lifecycle and integration boundaries

SFTS runs one selected category at a time and retains all imported categories on the server. Dependent division, gender and category dropdowns let the operator review and start or continue a category without rereading the file. Completed and finalized categories remain available for results review. Finish or reset any loaded or underway match before switching categories. Restart retains every category's progress and pauses the selected loaded match. The workbook is not a multi-arena event scheduler.

Operators can permanently delete a stored category from Data Import with the same bout-count confirmation used in manual entry. This removes its bracket, archived results and match-history entries while preserving other categories, and the removal survives restart. A live match must be finished or reset first. Deleting the last category returns to Event setup. The source workbook is not modified, so a later explicit reimport can reintroduce its fixtures without restoring deleted results.

The built-in Data Import wizard uses `autoAdvance: true`, validates and previews the complete file, then confirms it with a file/event digest and the selected category key. A draw stops advancement until a winner is decided. Results can be corrected only while the category is open and dependent matches have not been loaded or completed. Finalized categories remain in combined files when their recorded matches agree, but reject additional scoring. Invalid categories reject the entire file before it replaces the stored tournament.

Template export is USB-only through **SAVE TEMPLATE TO USB** on the Event card. There is no browser template download.

Initial delivery can use workbook export and manual import, without a live API connection. If direct upload is added later, use the existing host-authenticated preview/commit flow:

1. POST the file bytes to `/api/tournament/import?preview=true` with `X-SFTS-Host-Token` and `X-SFTS-Import-Event`. The latter is a URI-encoded JSON object with `eventName`, `eventDate`, `venue`, `arenaNumber`, `competition` and `autoAdvance: true`.
2. Show the returned fixture for operator review.
3. POST the same file and metadata to `/api/tournament/import`, adding `X-SFTS-Import-Digest` from the preview's `tournament.sourceDigest` and `X-SFTS-Import-Category` from the selected `workbook.categories[].key`.

The preview's `workbook.categories` contains every category's fixture for review. After commit, responses provide small category summaries. Stored categories can be reviewed with `GET /api/tournament/category/:key?workbookId=...` and activated with `POST /api/tournament/category` using `workbookId` (the workbook source digest) and `categoryKey`. Both require the host token; selection is rejected if the workbook changed or a match is busy. Full WebSocket states include `fixtureWorkbook` summaries and only the active full fixture.

Changing the file or event details requires a fresh preview. Omitting `autoAdvance: true` invokes the older explicit-match-list behavior and is unsuitable for this opening-fixture workflow. USB-only deployments use SFTS's USB import flow instead of desktop file upload. No automatic results synchronization back to the fixture application is established by this contract.

## Acceptance criteria for the first release

1. Approved draws export one compatible tournament file containing all contested categories for a competition, with valid rulepack values and all 14 headers.
2. Every athlete appears exactly once; opponents, colors and BYEs in the file match the reviewed bracket.
3. Re-exporting an approved revision preserves opponents, references, sides and row order.
4. Test categories with 2, 3, 5, 8, 9, 16 and 17 athletes produce the correct opening stage, BYE count and progression. Exercise both Hong-side and Chung-side BYEs.
5. The nine-athlete example imports into SFTS, progresses through all four stages, and produces eight scored records and the expected finalists and semifinal losers.
6. Duplicate athletes or duplicate bout references within a category, invalid categories, empty-versus-empty rows and non-power-of-two category opening row counts are blocked before export. Different categories may reuse bout references.
7. Commas and other ordinary characters in names and clubs survive spreadsheet export/import correctly. Length limits and optional location fields follow the current contract.
8. Zero/single-entry categories are clearly separated from scored-category exports.
9. The projected bracket agrees with SFTS for both Hong and Chung winners. Changing opening row order changes the projected future opponents visibly before approval.
10. The application stores approved revisions and makes it clear that changing an already scored draw is not a normal export update.
11. A combined file with interleaved category rows retains each bracket's order. Operators can switch between unfinished categories and resume their next bouts, and a restart retains active and inactive progress and finalized results.

## Context to give a coding assistant

> Build a separate Taekwondo tournament fixture application compatible with the existing SFTS scoring software. Follow this document's current import contract. The fixture application owns participant registration, category grouping, draw policies, opening opponents, Hong/Red and Chung/Blue assignments, BYEs, review and draw approval. Export one XLSX tournament file per competition, containing all divisions, genders and categories, with Matches as the first worksheet, the exact 14 headers, and only each category's ordered opening positions. SFTS keeps event details manual, groups rows into selectable categories, pairs adjacent winners within each category and continues scoring locally. Preserve approved pairings and row order on every export. Keep the internal bracket model structured with stable IDs, reproducible draw seeds and revisions. Start with single elimination; treat unconfirmed draw policies as configurable product decisions. Do not implement a full-graph SFTS import, automatic results synchronization or single-entry scored bouts without an explicit contract extension. Validate the nine-athlete, seven-BYE example and multi-category selection, switching and recovery end to end.

## Repository references

- [Current import workflow and contract](category-match-import.md).
- [Exact header definitions and row parser](../src/fixtureImport.js).
- [Bracket construction, source links and BYE advancement](../src/fixtureProgression.js).
- [Server event/category validation and template generation](../src/server.js).
- [Default rulepack](../config/rules.default.json).
- [End-to-end import and downloadable-template checks](../test/fixture-import.test.js).
- [Progression checks across supported bracket sizes](../test/fixture-progression.test.js).
