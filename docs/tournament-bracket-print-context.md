# Printable Tournament Bracket Context

## Status

Deferred. Implement this after the planned weight-category changes are complete.

No printable-bracket code has been implemented yet.

## Goal

Replace the flat schedule table in the printable tournament output with a visual
single-elimination bracket. Keep the existing interactive schedule table for
operating the tournament.

## Existing Data Available

The tournament already provides the information needed to construct the bracket:

- Groups separated by gender and weight category.
- Bout numbers and round numbers.
- `redSourceBoutNo` and `blueSourceBoutNo` links between rounds.
- Player IDs and names on each side of a bout.
- Bout statuses, winners, and automatic byes.
- Completed category placements: 1st, 2nd, and two equal 3rd places.

## Planned Approach

1. Leave the existing on-screen schedule table unchanged.
2. Build a separate print-only bracket from `tournament.groups`,
   `tournament.schedule`, `tournament.byes`, and each group's `placements`.
3. Render one bracket section per gender and weight category.
4. Create one column for each elimination round.
5. Show red and blue player names in match cards.
6. Show `Winner of Bout ...` placeholders for unresolved future matches.
7. Show automatic advancements clearly as `BYE`.
8. Highlight completed winners and display the champion at the end of the bracket.
9. Connect matches by following `redSourceBoutNo` and `blueSourceBoutNo`, rather
   than inferring connections from bout order.
10. Use an SVG connector layer so bracket lines remain aligned and printable.
11. Show the completed category result list beneath each bracket:
    - 1st place
    - 2nd place
    - 3rd place
    - Second 3rd place
12. Use print-specific layout rules:
    - Landscape page orientation.
    - One weight category per page where practical.
    - Protected page breaks around match cards.
    - Automatic scaling for different bracket sizes.
    - Hidden buttons, actions, and interactive schedule controls.

## Expected Scope

The implementation should primarily affect:

- Tournament schedule markup in `public/index.html`.
- Bracket rendering in `public/js/app.js`.
- Print and bracket styling in `public/css/style.css`.
- Automated tests for bracket structure and printing behavior.

The tournament backend and rulepack should not require structural changes for
the basic bracket because the required source-bout relationships and category
placements already exist.

## Important Limitation

Tournament bouts currently retain their winner but do not store a compact final
score or victory reason directly on the bout record. The first bracket version
can show players, status, byes, and winners. Showing final scores or victory
reasons would require a separate backend enhancement to persist those details on
each completed tournament bout.

## Dependency

Review and update this plan after the weight-category data model and user
interface changes are finalized. The bracket grouping and printed category
headings must use the final weight-category structure.
