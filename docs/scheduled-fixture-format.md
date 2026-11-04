# SFTS category fixture format

The fixture application defines bracket positions and match order **within each category**. SFTS stays in the operator's selected Division, Gender and Weight Category/Group. Category changes are always manual.

## Workbook

Export XLSX with headers in row 1:

1. **Matches** first: opening bracket positions, including BYEs.
2. **Schedule**: every scored bout through the final, grouped by category.
3. **Categories**, **Instructions**, **Exclusions**: reference sheets, not imported.

Enter event name, date, venue, arena and competition in SFTS before import. Use the active rulepack. Keep KYORUGI and FRESHER KYORUGI in separate files.

The default template covers 84 categories, 1,260 fictional players, 84 BYEs, 672 opening rows and 1,176 scored bouts. Each category has **15 players and exactly one preliminary BYE**: seven played preliminaries, four quarterfinals, two semifinals and one final.

## Matches columns

Keep these 14 headers:

```text
Bout Number,Stage,Division,Gender,Weight Category,Group,Hong Name,Hong Club,Hong State Code,Hong District,Chung Name,Chung Club,Chung State Code,Chung District
```

- Preserve opening row order within each category. Adjacent winners meet next: row 1 winner is Hong/Red, row 2 winner is Chung/Blue. Repeat through the bracket without a redraw.
- Each athlete appears once in their category's opening positions. Identity is the trimmed, uppercased player name plus club. Keep both stable.
- Bout Number is text, unique within its category ignoring case, at most 40 characters.
- Use a valid rulepack division ID/label and MALE or FEMALE.
- Fill Weight Category for weight divisions or Group for group divisions; leave the other blank.
- Actual players require name and club, each at most 64 characters. State code is optional but must be a valid Indian state/UT code. District is optional, at most 48 characters.
- A BYE side has name BYE and blank club/state/district. Both sides cannot be BYEs. BYEs advance without a scored record.

| Opening rows including BYEs | Stage on all opening rows |
| --- | --- |
| 1 | FINAL |
| 2 | SEMIFINAL |
| 4 | QUARTERFINAL |
| 8, 16, 32, 64, 128, 256 | PRELIMINARY |

Larger brackets may have multiple preliminary rounds. Complete each round before the next within that category.

## Schedule columns

| Column | Meaning |
| --- | --- |
| Match Order | Positive integer, unique within the category. Start at 1; the template uses 1-14 for each category. |
| Bout Number | Opening scored bout or generated later-round reference. |
| Stage | PRELIMINARY, QUARTERFINAL, SEMIFINAL or FINAL, matching the bracket. |
| Division | Same category definition as Matches. |
| Gender | Same category definition as Matches. |
| Weight Category | Same value as Matches; blank for group divisions. |
| Group | Same value as Matches; blank for weight divisions. |
| Hong Source | Opening bout: exact Hong player name. Later bout: Winner of followed by its Hong source bout reference. |
| Chung Source | Equivalent source for Chung. |
| Minimum Match Gap | Numeric 1 on every row. |

Include every scored bout once and omit BYEs. A later source may reference a BYE opening row using Winner of followed by its reference; SFTS resolves that winner automatically.

Generated round 2 references are AUTO-R2-001, AUTO-R2-002, etc.; round 3 uses AUTO-R3-001, etc. On collision, SFTS adds -1, -2, etc. Avoid AUTO- for opening references. Category fields disambiguate repeated future references.

| Category Match Order | Stage |
| --- | --- |
| 1-7 | Preliminary |
| 8-11 | Quarterfinal |
| 12-13 | Semifinal |
| 14 | Final; requires a manually supplied rest match after semifinal 2 |

Schedule controls only the selected category. It never selects another category or creates an arena-wide sequence. Older files with globally unique order numbers remain readable; their rows are followed within the selected category.

## Rest and manual switching

A player needs at least one other completed official match between appearances. For workbooks containing Schedule, SFTS checks both proposed players against the most recent recorded match for the same event, arena and competition. BYEs, waiting, practice and resetting do not supply a gap.

The 15-player template provides rest naturally through the semifinals. Before the final, or earlier in a smaller bracket:

1. The next-match card stays in the current category and shows **REST REQUIRED**. Loading that match is blocked.
2. Choose **Select Another Category**, select its division/gender/category, then start or continue it.
3. Complete one or two matches.
4. Select the previous category again. Its waiting match is retained and becomes loadable once the gap is satisfied.

When an immediate match is necessary, the operator can choose **OVERRIDE REST** on the waiting match card and confirm the affected competitors and bout. This loads only that match without the one-match gap and records **REST OVERRIDE** in its operator history. All other loading checks still apply. The normal rest rule remains enabled for later matches; resetting and reloading the same waiting bout requires a new override if rest is still outstanding.

Nothing switches automatically. Results stay in the correct category. After the final, SFTS shows that category's results; the operator chooses the next category.

## Validation and recovery

SFTS rejects missing/repeated/unknown bouts, duplicate order numbers within a category, incorrect stages/sources, invalid categories and rounds or dependencies out of order. All sheets validate before replacing the active workbook.

Completed results must remain a prefix of **each category's** order. Categories can have independent partial progress. Preserve recorded bout Match Order when revising the same scheduled event.

Restart retains the selected category, every category's progress and archived records used for rest checks. Loaded matches resume paused. Result-correction and finalization rules remain unchanged.

Opening-only XLSX/XLS/CSV files retain their legacy flow without Schedule. Use this template for schedule and rest enforcement. CSV cannot contain Schedule. Limits: 128 categories, 4,096 opening rows, 8,192 Schedule rows, 4 MB per workbook, 512 athletes per category.

Export a separate workbook for another arena. Cross-arena coordination and automatic result synchronization to the fixture application are outside this contract.

## Exporter checks

- Verify 15 players, one BYE and 14 scored bouts per sample category.
- Complete seven preliminaries before quarterfinals, staying in the selected category after every winner.
- Verify both Hong and Chung wins preserve opponents and advancement.
- Confirm the final is blocked after semifinal 2; manually score another category and return to finish it.
- Restart while a final needs rest; it must retain its progress and rest requirement.
- Complete/finalize results without automatically activating another category.
