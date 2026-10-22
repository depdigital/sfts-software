# Manual Entry - Match-Day Operator Guide

This guide explains how to enter competitors from a paper fixture, run their bouts, record the category results, and save the final report as a PDF on a USB drive.

You do not need computer or engineering knowledge to use Manual Entry.

## Before you begin

Keep the official paper fixture beside you. Confirm that it shows:

- Tournament name, date, and venue
- Arena number
- Competition type
- Division and gender
- Weight category or rulepack-defined category group
- Official bout/reference numbers
- Names and affiliations of the competitors
- Whether each bout is a preliminary, quarterfinal, semifinal, or final

Always copy names and bout numbers exactly as they appear on the official fixture.

## Important corner names

| Screen name | Chest guard | Competitor |
|---|---|---|
| **HONG** | Red | The competitor entered on the HONG side |
| **CHUNG** | Blue | The competitor entered on the CHUNG side |

Do not enter the blue competitor under HONG or the red competitor under CHUNG.

## Open Manual Entry

1. Open **SETTINGS** on the scoring screen.
2. Select **PLAYER SETTINGS**.
3. Select **MANUAL ENTRY**.

Use **DATA IMPORT** only when you have a prepared tournament spreadsheet. It is not required for a paper fixture.

Use **PRACTICE MODE** only for temporary club training. Practice matches use the normal scoring rules, but their match and corner-referee histories are not saved.

## Step 1: Create a category

At the top of Manual Entry, leave **EXISTING CATEGORY** set to **CREATE NEW CATEGORY**.

Complete the **EVENT & CATEGORY** section:

- **Tournament Name:** Enter the official event name.
- **Date:** Select the competition date.
- **Venue:** Enter the stadium, hall, or competition venue.
- **Arena No.:** Enter the mat or arena number where this category will be conducted.
- **Competition:** Select **KYORUGI** or **FRESHER KYORUGI**.
- **Division:** Select the correct division from the list.
- **Gender:** Select **MALE** or **FEMALE**.
- **Weight Category:** Select the category shown on the fixture.

The division and category lists come from the active competition rulepack. They should not be typed manually.

### Sub Junior categories

Under the default SFTS rulepack, **SUB JUNIOR** uses gender-specific weight categories. Select the exact **UNDER … KG** category shown on the fixture; the available categories change when you select MALE or FEMALE.

If an authorized custom rulepack defines a division as a category group instead, Manual Entry replaces Weight Category with **CATEGORY GROUP** and shows only that rulepack's valid groups.

The event and category details are saved when the first bout is loaded.

A category represents the complete bracket. Enter every preliminary, quarterfinal, semifinal, and final bout for that bracket under the same category. If the same category details are submitted again accidentally, SFTS reuses the existing open category instead of creating a duplicate.

## Step 2: Enter the bout

Complete the **BOUT DETAILS** section:

- **Official Bout / Reference No.:** Copy the bout number from the paper fixture.
- **Stage:** Select **PRELIMINARY**, **QUARTERFINAL**, **SEMIFINAL**, or **FINAL**.

Use a different official bout/reference number for every completed bout in the same category.

## Step 3: Enter HONG and CHUNG

Under **HONG**, enter:

- Player name
- Affiliation or club
- State code, if available
- District, if available

Under **CHUNG**, enter the same information for the blue chest-guard competitor.

The player name and affiliation/club are required. State code and district are optional.

Check the paper fixture once more before continuing:

- HONG name = red chest guard
- CHUNG name = blue chest guard
- Both names are spelled correctly
- Both affiliations are correct
- Bout number and stage are correct

## Step 4: Load or announce the bout

Choose one of these buttons:

- **SAVE & LOAD BOUT:** Loads the names onto the scoring screen without making an announcement.
- **SAVE & ANNOUNCE:** Loads the names and announces the competitors.

The announcement follows this format:

> "Player name, HONG, red chest guard, versus Player name, CHUNG, blue chest guard; contestants, prepare for the match."

The weight category is not included in the announcement.

Other useful buttons:

- **SWAP RED / BLUE:** Exchanges all HONG and CHUNG details. Use this if the competitors were entered on the wrong sides.
- **CLEAR NAMES:** Clears both competitor sections so they can be entered again.
- **BACK:** Returns to the Player Settings menu without loading a new bout.

## Step 5: Run and finish the match

Run the match normally from the scoring screen.

When the match ends, the system automatically records:

- HONG and CHUNG names and affiliations
- Arena and category details
- Official bout/reference number and stage
- Round scores and round winners
- Match winner and defeated competitor
- Method of victory
- Rulepack used for the match
- Penalties and operator score corrections
- Corner-referee button history
- Match start and finish times

You do not need to enter this information again.

### Changing details after scoring begins

Manual bout details cannot be changed after the timer starts or any score, penalty, vote, completed round, or Kye-shi activity has been recorded.

If the information is wrong, stop and reset the current match before trying to change it. Confirm with the responsible official before resetting a match that has already begun.

## Step 6: Prepare the next bout

The current match must show **MATCH END** before the next manual bout can be prepared.

1. Open **SETTINGS > PLAYER SETTINGS > MANUAL ENTRY**.
2. Select **NEXT BOUT IN THIS CATEGORY**.
3. Enter the next official bout/reference number and stage.
4. Enter the new HONG and CHUNG competitors.
5. Select **SAVE & LOAD BOUT** or **SAVE & ANNOUNCE**.

The current category remains selected automatically, including after reopening the screen. Only the bout and competitor details need to be entered again. Use **CREATE NEW CATEGORY** only when moving to a different bracket.

### Changing to another category

Choose the required category from **EXISTING CATEGORY**. Its event and category details will load automatically.

If it has not been created yet, select **CREATE NEW CATEGORY** and enter its details.

## Category results

Open **CATEGORY RESULTS** from Manual Entry.

Select the category you want to review. The report shows all completed bouts recorded for that category.

### Review medal positions

The system calculates placements from the completed final and semifinals:

- **Gold:** Winner of the final
- **Silver:** Defeated competitor in the final
- **Bronze:** Defeated competitor in the first semifinal
- **Bronze:** Defeated competitor in the second semifinal

The dropdowns remain editable. Change a calculated position only when the official fixture requires a correction; the report marks the change as an **OPERATOR OVERRIDE**.

If a semifinal position was filled by a bye and no semifinal bout was contested, there is no recorded semifinal loser for that Bronze position. Leave it as **NOT AWARDED** or select the official recipient from the dropdown.

If a medal was not awarded, leave it as **NOT AWARDED**.

- Select **SAVE PLACEMENTS** to save the current choices while keeping the category open.
- Select **FINALIZE CATEGORY** only after an authorized official has checked all bouts and medal positions.

**Warning:** A finalized category is locked. More bouts cannot be added and its placements cannot be changed from the operator screen.

## Save the result PDF to USB

The PDF always starts with the confirmed medal positions, followed by every participant recorded in the selected category. The participant list shows each player's club, state, district, bout count, and medal placement when applicable.

Choose any extra detail required for the copy you are preparing:

- **INCLUDE BOUT SUMMARY:** Selected by default and recommended for the normal official result.
- **INCLUDE FULL MATCH AUDIT:** Adds round details, penalties, and operator corrections.
- **INCLUDE CORNER-REFEREE HISTORY:** Becomes available after Full Match Audit is selected and adds every recorded corner-referee button press.

Corner-referee history is optional audit evidence and remains safely stored when it is not included.

Use **SHOW REPORT PREVIEW** to check the current medal selections and report contents. The preview can show placement changes that have not yet been saved, but the official PDF can only be exported after those changes are saved.

Before saving:

1. Confirm the correct category is selected.
2. Confirm all completed bouts are listed.
3. Confirm Gold, Silver, Bronze, and Bronze against the paper fixture.
4. Save or finalize the placements.
5. Check the report preview.
6. Insert the USB drive and select **REFRESH USB** if it is not already shown as ready.
7. Select **SAVE PDF TO USB**.
8. Wait for the saved filename to appear, then select **UNMOUNT USB SAFELY** before removing the drive.

The system writes the PDF directly to the USB drive with a unique filename. It does not open a browser print dialog or reveal File Explorer. The PDF includes signature spaces for the Technical Official, Arena Incharge, and Organizer.

## Common messages

### "Finish or reset the current match before changing manual bout details"

The current match already contains match activity. Finish it normally, or reset it only with official approval.

### "Choose a valid item from the active rulepack"

The selected division, gender, weight category, or category group is not allowed by the current rulepack. Check the fixture and choose an item from the displayed list.

### "That official bout/reference number is already completed"

That number has already been recorded in the selected category. Check whether you selected the wrong category or copied the wrong bout number.

### "This category is finalized"

The category has been locked after its results were confirmed. It cannot accept another bout.

### Announcement does not play

The bout is still loaded even if sound is unavailable. Check the device volume and speaker connection, then ask the announcer to call the competitors manually if necessary.

## Quick match-day checklist

Before every bout:

- Correct existing category selected
- Correct official bout/reference number
- Correct stage
- HONG is wearing red
- CHUNG is wearing blue
- Names and affiliations match the fixture

After the category is complete:

- All bouts appear in Category Results
- Final and semifinal results match the paper fixture
- Gold, Silver, Bronze, and Bronze are confirmed
- Category is finalized only after official approval
- Required summary or full reports are saved to USB, printed where authorized, and signed
