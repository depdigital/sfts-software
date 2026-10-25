# Tournament fixture import

The current template includes an official `Schedule` sheet and enforces a one-match rest gap across categories. Follow [the scheduled fixture format](scheduled-fixture-format.md) for the complete current exporter contract. The opening-position format below remains compatible; descriptions of category-only progression and first-sheet-only reading apply to legacy files without Schedule. With Schedule, SFTS also reads that sheet and Load Next Match follows its order across categories.

Data Import is a five-card workflow: **Event → File → Review → Matches → Results**. The fixture software supplies one tournament file with the opening positions for multiple divisions, genders and categories. SFTS groups the rows, preserves each category's bracket order, and continues the selected category locally through the final using the normal scoring and category result records.

## Event card

Enter tournament name, date (`YYYY-MM-DD`), venue, arena number (`1`–`999`) and competition (`KYORUGI` or `FRESHER KYORUGI`) manually. These apply to the entire file. Division, gender and weight category/group come from the spreadsheet. Competition is not taken from Excel; keep regular and fresher competitions in separate files.

**SAVE TEMPLATE TO USB** on the Event card saves the complete test template through the existing USB drive workflow. Browser template downloads are disabled. Every valid division/gender/weight-category or group combination in the active rulepack receives **9 fictional players and 7 BYEs**, the minimum needed for a contested preliminary followed by four quarterfinals, two semifinals and a final. With the default rulepack this covers **84 categories across 4 divisions**, **756 players**, **588 BYEs** and **672 opening rows**. Both Hong-side and Chung-side BYEs are included, and the contested opening position varies between categories.

## Opening fixture file

Only the first worksheet is read. One file can contain multiple divisions/genders/categories. Supply **only the opening positions** for each category, in fixture order, with every competitor appearing exactly once within that category. Repeat division, gender and category on every row. Rows from different categories can be interleaved; grouping preserves their relative order within each category. Bout references should be stored as text to retain leading zeroes.

| Column | Required | Values |
| --- | --- | --- |
| Bout Number | Yes | Unique within the category, at most 40 characters; case-insensitive duplicate checks. |
| Stage | Yes | Same opening stage on every row within a category; see the stage table below. |
| Division | Yes | Active rulepack ID or label. |
| Gender | Yes | MALE/M or FEMALE/F. |
| Weight Category | Weight divisions | Active rulepack category name; blank for group divisions. |
| Group | Group divisions | Active rulepack group name; blank for weight divisions. |
| Hong Name / Chung Name | Actual competitor | Red/blue player name, at most 64 characters. |
| Hong Club / Chung Club | Actual competitor | Club/affiliation, at most 64 characters. |
| Hong State Code / Chung State Code | No | Valid Indian state/UT code. |
| Hong District / Chung District | No | At most 48 characters. |

For a BYE, put `BYE` or leave the name blank on the empty side. Its club, state and district must also be blank. The other side must name an actual competitor. Preserve where the fixture assigns each BYE; SFTS does not shuffle or invent BYE positions.

| Opening rows, including BYE rows | Opening stage |
| --- | --- |
| 1 | FINAL |
| 2 | SEMIFINAL |
| 4 | QUARTERFINAL |
| 8, 16, 32, 64, 128, 256 | PRELIMINARY |

Within each category, include enough BYE rows to make its opening row count a power of two. At least two actual competitors per category are required; single-entry direct medal allocation is outside this scored-category workflow. Limits: **128 categories / 4096 opening rows / 4 MB per file**, and **256 opening positions / 512 competitors / 511 total bouts per category**. Invalid rows or an invalid category reject the whole file before it replaces the current tournament.

Example with three competitors:

```csv
Bout Number,Stage,Division,Gender,Weight Category,Group,Hong Name,Hong Club,Hong State Code,Hong District,Chung Name,Chung Club,Chung State Code,Chung District
SF-01,SEMIFINAL,SENIOR,MALE,FLYWEIGHT,,Arjun,Capital TKD,DL,New Delhi,Rohan,Warriors TKD,UP,Noida
SF-02,SEMIFINAL,SENIOR,MALE,FLYWEIGHT,,Vikram,Cochin Club,KL,Kochi,BYE,,,
```

Vikram advances directly into the final without a scored match or fabricated match record. The SF-01 winner becomes HONG in the final; Vikram becomes CHUNG.

The USB template remains `sfts-match-template.xlsx`. **Matches** is first, followed by **Categories**, **Instructions** and **Exclusions**. Matches contains only valid opening fixtures. Categories lists each tested combination and its expected player/BYE/round counts. Exclusions documents unsupported cross-combinations from the rulepack category names without putting invalid data in the import sheet. Import all 672 default sample rows unchanged for testing, or replace all sample rows with your tournament's opening fixtures. Header matching ignores case, spacing and punctuation. Official Bout No/Bout No/Bout, Red/Blue Name/Club/State Code/District and Hong/Chung or Red/Blue Affiliation aliases remain supported. Duplicate or ambiguous headers are rejected.

## Review card

Reading a file displays dependent **Division → Gender → Category** dropdowns, with category progress labels. Select a category to review its event details, opening HONG/CHUNG assignments, competitor count, BYEs and total matches through the final. Previewing does not replace the active tournament. **Confirm & Start Category** checks the complete file/event digest again before storing all categories and activating the selected one. Changing the file or event details requires a fresh review.

After import, **Select Another Category** uses the stored workbook. Selecting a dropdown previews that category; **Start Category**, **Continue Category** or **View Category Results** activates it. No file upload or USB reread is required. Dropdowns are disabled while a match is loaded or underway, and the server also rejects category switching until it is finished or reset. Completed and finalized categories remain visible for reviewing results.

**Delete Category** beside the selectors removes the selected stored category, its entire bracket, its archived bout records and its match-history entries. This is available after import, including for completed and finalized categories. The confirmation dialog identifies the category; saved bouts require typing `DELETE N BOUTS` (or `DELETE 1 BOUT`) using the displayed count, as in manual entry. A finalized category with no bout records requires `DELETE FINALIZED CATEGORY`. A loaded or underway match must be finished or reset first.

Deleting the selected category selects another remaining category. Deleting the final category returns Data Import to Event setup. Progress in other categories is retained, and removal is persisted across restarts. Deleting a saved category from manual entry also removes its imported bracket. No source Excel/USB file is edited; explicitly importing that file again can restore its category fixtures, but permanently deleted results are not restored.

## Match card

The next card shows stage, match number within that round, bout reference and both competitors. Choose **Load Next Match**, then score normally. After the winner screen, **Continue Category** returns to the cards. A recovered loaded match offers **Return to Scoreboard**.

Adjacent row winners meet without a redraw: row 1 winner becomes HONG and row 2 winner becomes CHUNG, then row 3 meets row 4, and so on. This repeats each round through quarterfinal, semifinal and final. Additional preliminary rounds are created when needed. Future references are generated deterministically, such as `AUTO-R2-001`, with collision checks.

Bouts run in round/position order. A later round cannot be loaded out of order. A draw blocks advancement until its winner is confirmed. A BYE advances automatically and never changes scoreboard points or creates a scored record.

**Review a Recorded Winner** allows an operator-confirmed correction while no dependent bout has been loaded/completed and the category is open. The correction updates pending competitors, medals, recent history and the archived result, and appends an audit entry. Once a dependent bout is loaded, the earlier result is locked; an unstarted loaded bout can be reset before correcting its source.

## Results card and recovery

Gold/silver come from the actual final winner/loser; bronze comes from the recorded semifinal losers. Review, operator placement overrides, finalization and PDF/USB export use the existing manual category results. Finalization is blocked until all category matches have completed and every winner is decided.

Every imported category's opening fixture, generated rounds, current bout and results are saved locally. Restart restores the selected category and pauses any loaded match, while retaining the other categories' progress, BYEs and winner assignments. Shared manual archive records reconcile each category's saved progression; inconsistent recovery requires review before loading. Reimporting the same tournament file reconstructs progress from completed reference numbers and rejects changed recorded competitors/stages.

Importing another tournament file replaces the available category list while retaining archived results. A finalized category can remain in a combined file if its recorded matches agree; it cannot load additional bouts. Incomplete categories cannot be finalized, including while another category is selected. Existing single-category files, explicit match lists and legacy generated-bracket snapshots remain recoverable, and manual-entry controls retain their original workflow.

## Implementation and Pi limits

New wizard imports send `autoAdvance: true` in the event metadata. Desktop review uses `/api/tournament/import?preview=true`, then commits with `X-SFTS-Import-Digest` and the selected `X-SFTS-Import-Category`. USB review uses `preview: true` alongside `fileName` and `event`, then commits with `digest` and `categoryKey`. Both require the normal host session and the same bounded file worker. No server-side draft queue or polling timer is added.

Preview responses include `workbook.categories` with per-category fixture details. Committed responses and full WebSocket states supply category summaries (`workbook` in HTTP responses, `fixtureWorkbook` in state). `GET /api/tournament/category/:key?workbookId=...` reviews a stored category; `POST /api/tournament/category` with `workbookId` and `categoryKey` selects it. These endpoints require host authentication and reject stale workbook selections. Only the active fixture and small category summaries are broadcast; inactive full brackets remain on the server.

`POST /api/tournament/category/delete` takes `workbookId`, `categoryKey`, `deleteRecords` and `confirmation`, using the normal host token. Stale selections, busy matches and incorrect/missing confirmations are rejected without deleting data. Category summaries include `categoryId` and `completedBoutCount` for the deletion dialog.

Older integrations without `autoAdvance` retain explicit-match-list behavior. The automatic mode updates an ordered, bounded list when a result/load/correction changes; it does not run bracket calculations on the scoring timer. The isolated desktop/Pi workload check can be run with `node tools/backend-benchmark.js --opening-fixture`. Desktop results are not a Pi hardware certification.
