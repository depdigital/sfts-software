# Corner Referee History and Majority Indicator Context

## Feature

Add **CORNER REFEREE HISTORY** under **Settings**. The feature applies to all
active remote modes: 1, 2, 3, and 4 corner referees.

The history is for the current match only. It remains available while the
match is in progress and is deleted automatically when the match ends and the
winner is decided.

## Corner-referee history records

Record each valid corner-referee scoring action during the match. Each record
must include:

- Match number.
- Arena number.
- Corner and side, for example `C1-RED` or `C1-BLUE`.
- Normalized button/result label.
- Awarded score.
- Exact press timestamp, displayed in a user-friendly local format such as
  `08 Sep 2026, 10:42:17 AM` while retaining the exact underlying timestamp.

The history menu must display centered columns with these headers:

`MATCH | ARENA | CORNER | BUTTON | SCORE | TIME`

Entries must be shown in chronological order. A cancel action may be shown as
side-neutral with no score.

## Button/result labels

Regular scoring actions must use these labels:

| Input | Display label | Score |
|---|---|---:|
| `RED_1` | `RED-FIST` | +1 |
| `BLUE_1` | `BLUE-FIST` | +1 |
| `RED_2` | `RED-CHEST` | +2 |
| `BLUE_2` | `BLUE-CHEST` | +2 |
| `RED_3` | `RED-HEAD` | +3 |
| `BLUE_3` | `BLUE-HEAD` | +3 |

## Technical combinations

Technical is a modifier and must not be recorded or awarded by itself.

- Technical + chest, in either order, becomes `RED-TECHNICAL-CHEST` or
  `BLUE-TECHNICAL-CHEST` for +4.
- Technical + head, in either order, becomes `RED-TECHNICAL-HEAD` or
  `BLUE-TECHNICAL-HEAD` for +6.
- Technical + fist is invalid.
- A completed technical combination must appear as one history record. The
  underlying chest/head action must not remain as a separate record.
- A technical press without a valid chest/head combination must not appear in
  history.
- The existing technical-combination timing and scoring rules remain
  unchanged.

## Majority indicators

Place a small rounded rectangle score box at each corner-referee indicator
position. The corner-referee images and C1-C4 labels are not displayed in the
final scoreboard UI. There are separate indicators for the RED and BLUE
sides.

Initial state:

- Every box is blank.
- No box is glowing.

When a score is awarded by the corner-referee majority:

- Only the corner referees whose matching vote formed the awarded majority
  glow green.
- Their boxes display the awarded score, such as `+3`, `+4`, or `+6`.
- The glow and score remain visible until the next score is awarded.
- When the next score is awarded for a side, first clear that side's previous
  score and release that side's previous green glow.
- Keep that side's indicators blank and unlit for a short 300 ms transition
  gap so the release is visibly distinguishable.
- After the transition gap, engage the new green glow and score only on the
  corners that formed the new majority for that side.
- RED and BLUE awards update their respective side indicators independently;
  a RED award must not clear or replace the current BLUE indication, and a
  BLUE award must not clear or replace the current RED indication.
- A technical award uses the final technical result, not the intermediate
  modifier or base button.
- A non-majority or rejected vote does not update the indicators.

The winning corners are all active corners matching the awarded side and final
score. If more corners agree than the minimum required, all matching corners
glow.

## Majority requirements

The active remote mode determines the required matching votes:

| Active remotes | Required votes | Possible winning groups |
|---:|---:|---|
| 1 | 1 | C1 |
| 2 | 2 | C1+C2 |
| 3 | 2 | C1+C2, C1+C3, or C2+C3; all three if all agree |
| 4 | 3 | C1+C2+C3, C1+C2+C4, C1+C3+C4, or C2+C3+C4; all four if all agree |

Examples:

- In 1-remote mode, C1 awards RED +6: C1-RED shows `+6`.
- In 4-remote mode, C1, C2, and C3 award RED technical chest while C4
  disagrees: C1, C2, and C3 show `+4`; C4 remains blank.
- If C1, C2, C3, and C4 all award BLUE +3: all four BLUE indicators show
  `+3`.
- If votes are split across sides or final score types without a majority, no
  score is awarded and the current indicators remain unchanged.

## Match lifecycle

- History and indicator state begin blank for a new match.
- History remains available across rounds within the same match.
- Starting a new match or resetting the current match clears history and
  indicators.
- Ending the match and deciding the winner clears the corner-referee history
  and indicator state.

## Acceptance criteria

- The Settings menu exposes **CORNER REFEREE HISTORY**.
- Every history row contains match, arena, side-qualified corner, normalized
  button/result, score, and exact timestamp data.
- Technical-only presses never create a history row or score indicator.
- Valid technical combinations create exactly one normalized history row and
  update the majority indicators with +4 or +6.
- Regular FIST, CHEST, and HEAD votes use the normalized labels and scores.
- All majority corner permutations for remote modes 1-4 produce the correct
  glowing boxes and score values.
- Each side's indicators persist until that side's next awarded score, visibly
  release for 300 ms, and then engage the new majority state. Scoring on the
  other side must leave the first side's indication visible.
- History and indicators are cleared after match completion/winner decision.
- Existing scoring, timing, and remote-mode behavior remains unchanged except
  for the requested history and indicator presentation.
