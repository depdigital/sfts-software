# Independent category import

Data Import is a five-card workflow: **Event → File → Review → Matches → Results**. The fixture software supplies the opening round once. SFTS continues the category locally through the final, using the normal manual-entry scoring and category result records.

## Event card

Enter tournament name, date (`YYYY-MM-DD`), venue, arena number (`1`–`999`) and competition (`KYORUGI` or `FRESHER KYORUGI`). Division, gender and weight category/group come from the spreadsheet.

**Download Template** on the Event card downloads a ready-to-import test fixture with **9 dummy players and 7 BYEs** in a 16-slot bracket. This is the smallest standard bracket that includes a contested preliminary followed by four quarterfinals, two semifinals and a final (eight scored matches). The template uses a category from the active rulepack. In USB-only mode, the button saves the same template to USB.

## Opening fixture file

Only the first worksheet is read. One file contains one division/gender/category. Supply **only the opening positions**, in fixture order, with every competitor appearing exactly once. Repeat division, gender and category on every row. Bout references should be stored as text to retain leading zeroes.

| Column | Required | Values |
| --- | --- | --- |
| Bout Number | Yes | Unique reference, at most 40 characters; case-insensitive duplicate checks. |
| Stage | Yes | Same opening stage on every row; see the stage table below. |
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

Include enough BYE rows to make the opening row count a power of two. At least two actual competitors are required; single-entry direct medal allocation is outside this scored-category workflow. Maximum: **256 opening positions / 512 competitors / 511 total bouts**, and a **4 MB** source file.

Example with three competitors:

```csv
Bout Number,Stage,Division,Gender,Weight Category,Group,Hong Name,Hong Club,Hong State Code,Hong District,Chung Name,Chung Club,Chung State Code,Chung District
SF-01,SEMIFINAL,SENIOR,MALE,FLYWEIGHT,,Arjun,Capital TKD,DL,New Delhi,Rohan,Warriors TKD,UP,Noida
SF-02,SEMIFINAL,SENIOR,MALE,FLYWEIGHT,,Vikram,Cochin Club,KL,Kochi,BYE,,,
```

Vikram advances directly into the final without a scored match or fabricated match record. The SF-01 winner becomes HONG in the final; Vikram becomes CHUNG.

The downloadable/USB template remains `sfts-match-template.xlsx`. **Matches** is first, followed by **Categories** and **Instructions**. Import its eight opening rows unchanged for testing, or replace all demo rows with your actual fixture. Header matching ignores case, spacing and punctuation. Official Bout No/Bout No/Bout, Red/Blue Name/Club/State Code/District and Hong/Chung or Red/Blue Affiliation aliases remain supported. Duplicate or ambiguous headers are rejected.

## Review card

Reading a file displays the category, event details, opening HONG/CHUNG assignments, competitor count, BYEs and total matches through the final. This is a preview: it does not replace the current category. **Confirm & Start Category** checks the file/event digest again before committing. Changing the file or event details requires a fresh review.

## Match card

The next card shows stage, match number within that round, bout reference and both competitors. Choose **Load Next Match**, then score normally. After the winner screen, **Continue Category** returns to the cards. A recovered loaded match offers **Return to Scoreboard**.

Adjacent row winners meet without a redraw: row 1 winner becomes HONG and row 2 winner becomes CHUNG, then row 3 meets row 4, and so on. This repeats each round through quarterfinal, semifinal and final. Additional preliminary rounds are created when needed. Future references are generated deterministically, such as `AUTO-R2-001`, with collision checks.

Bouts run in round/position order. A later round cannot be loaded out of order. A draw blocks advancement until its winner is confirmed. A BYE advances automatically and never changes scoreboard points or creates a scored record.

**Review a Recorded Winner** allows an operator-confirmed correction while no dependent bout has been loaded/completed and the category is open. The correction updates pending competitors, medals, recent history and the archived result, and appends an audit entry. Once a dependent bout is loaded, the earlier result is locked; an unstarted loaded bout can be reset before correcting its source.

## Results card and recovery

Gold/silver come from the actual final winner/loser; bronze comes from the recorded semifinal losers. Review, operator placement overrides, finalization and PDF/USB export use the existing manual category results. Finalization is blocked until all category matches have completed and every winner is decided.

The opening fixture, generated rounds, current bout and results are saved locally. Restart restores the tournament paused, including already advanced BYEs and winner assignments. Shared manual archive records are used to reconcile saved progression; inconsistent recovery requires review before loading. Reimporting the same opening fixture reconstructs progress from completed reference numbers and rejects changed recorded competitors/stages.

Importing another category replaces the current list while retaining archived category results. Finalized categories reject further imports/loads. Existing explicit match lists and legacy generated-bracket snapshots remain recoverable, and manual-entry controls keep their original workflow.

## Implementation and Pi limits

New wizard imports send `autoAdvance: true` in the event metadata. Desktop review uses `/api/tournament/import?preview=true`, then commits with `X-SFTS-Import-Digest`. USB review uses `preview: true` alongside `fileName` and `event`, then commits with the returned `digest`. Both require the normal host session and the same bounded file worker. No server-side draft queue or polling timer is added.

Older integrations without `autoAdvance` retain explicit-match-list behavior. The automatic mode updates an ordered, bounded list when a result/load/correction changes; it does not run bracket calculations on the scoring timer. The isolated desktop/Pi workload check can be run with `node tools/backend-benchmark.js --opening-fixture`. Desktop results are not a Pi hardware certification.
