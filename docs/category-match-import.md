# Category match file contract

The fixture application decides every match, side and running order. SFTS reads explicit matches and loads them through the same official bout and category-result handling as manual entry.

## Event information entered on SFTS

Tournament name, date (`YYYY-MM-DD`), venue, arena number (`1`–`999`) and competition (`KYORUGI` or `FRESHER KYORUGI`) are entered in Data Import before importing. They apply to every row in the selected file. Division, gender and category come from the file and are shown after import.

## First worksheet: Matches

Only the first worksheet is read. The first row contains headers. Additional worksheets may contain category references and instructions. CSV uses the same headers. One file contains exactly one division/gender/category; repeat those fields on each match row. Preserve official bout/reference numbers as text, including any leading zeroes.

| Column | Required | Values |
| --- | --- | --- |
| Bout Number | Yes | Unique within the file/category; at most 40 characters. Case-insensitive duplicate detection. |
| Stage | Yes | PRELIMINARY, QUARTERFINAL, SEMIFINAL, FINAL. Spaces/hyphens in stage names are accepted. |
| Division | Yes | Active rulepack division ID or label. |
| Gender | Yes | MALE/M or FEMALE/F. |
| Weight Category | For weight divisions | Active rulepack category name. Leave blank for group divisions. |
| Group | For group divisions | Active rulepack group name. Leave blank for weight divisions. |
| Hong Name | Yes | Actual red competitor name, at most 64 characters. |
| Hong Club | Yes | Red club/affiliation, at most 64 characters. |
| Hong State Code | No | Valid Indian state/UT code. |
| Hong District | No | At most 48 characters. |
| Chung Name | Yes | Actual blue competitor name, at most 64 characters. |
| Chung Club | Yes | Blue club/affiliation, at most 64 characters. |
| Chung State Code | No | Valid Indian state/UT code. |
| Chung District | No | At most 48 characters. |

Header matching ignores case, spaces and punctuation. `Official Bout No`, `Bout No` or `Bout` can replace `Bout Number`. Red/Blue Name, Club, State Code and District aliases are accepted. Hong/Chung Affiliation and Red/Blue Affiliation can replace the corresponding Club header.

The template downloaded or saved to USB is `sfts-match-template.xlsx`; its **Categories** sheet lists the currently supported category names. Its example match must be replaced with real event data. Files are limited to 500 matches and 4 MB; existing worker memory, ZIP expansion and column limits remain in effect.

## Operation and results

Rows are retained in file order, even when official bout numbers are not numerically sorted. SFTS never swaps competitors, randomizes a draw, creates a BYE, or advances a winner. Supply actual names; BYE/TBD/TBA and winner-of-bout placeholders cannot be scored as competitors. When later-round participants become known, export an updated file with their assigned sides and import it after finishing/resetting the current match.

LOAD creates a normal official manual bout with the supplied stage and reference number. All match scoring and winner decisions use the existing manual flow. Completed matches are stored in the shared manual results archive. The recorded final winner/loser provide gold/silver, and the two recorded semifinal losers provide bronze. Category review, operator overrides, finalization and PDF/USB export are shared with manual entry.

A new import replaces only the currently imported list, preserving archived categories and completed bouts. The existing manual category identity uses tournament name, date, competition, division, gender and category. Completed bout references in that category are recognized on reimport; changes to their stage, competitors or clubs are rejected. Finalized categories reject further imports/loads. Loading is also checked against completed records, so a manually completed reference cannot be replayed from an older imported list.

The importer validates the complete file before changing the active list. Import and loading cannot replace an unfinished match. The imported list, completion states, category link and loaded bout are saved in the normal local snapshot; restart pauses the timer. Existing snapshots containing legacy generated brackets remain supported for recovery, but new imports cannot generate brackets.

The legacy `/api/tournament/import` route name is retained for compatibility with the application. Desktop uploads carry percent-encoded event JSON in `X-SFTS-Import-Event`; USB imports carry `event` alongside `fileName` in JSON. Both use the same parser and require the existing host session. Pi deployments retain USB-only import and the existing restricted file selection.
