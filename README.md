# Taekwondo Scoring System Web App V3

This V3 is based on your V2 and includes the requested layout and rule changes.

## Main changes added
- Home page uses the supplied SFTS logo image instead of the old text heading.
- Host scoreboard shows the SFTS logo at top-left.
- Editable player names on top of both score sides.
- Removed the extra point/gam-jeom circles under the main score.
- Bottom host controls changed to 3 buttons per row and 2 rows on each side.
- +2 buttons use a chest-guard icon and +3 buttons use a head-guard icon.
- Settings now include QR code, timer edit, match history, and host-only test mode.
- A 15-point gap ends the round immediately.
- Round summary shows score, gam-jeom, +1 punch count, +2 chest count, and +3 face count.
- New Match button appears when a match ends and automatically increments the match number.
- Match history stores up to 50 completed matches while the server is running.
- Round-end whistle/buzzer lasts about 2 seconds.
- Test mode exists only on the host device; referee button presses light up the matching test joystick buttons.
- Winner slide appears in red or blue style with the winner name.
- Referee controller screen has the SFTS logo above CANCEL VOTE and removes the old HONG/RED center text.

## Existing behavior kept
- 4 referee phones maximum.
- Real-time Wi-Fi connection through one host server.
- 3-of-4 majority voting for +1 / +2 / +3.
- Host manual edit buttons for score and gam-jeom.
- Timer, play/pause, reset round timer.
- 35-second break between rounds.
- Best-of-3 round match flow.
- Five gam-jeom in a round gives the round to the opponent.

## How to run
1. Install Node.js.
2. Open Command Prompt inside this project folder.
3. Run:
   npm install
   npm start
4. Open on host laptop:
   http://localhost:8080
5. Open referee phones on the same Wi-Fi using the Wi-Fi URL printed in the terminal.

## Notes
- Match history is memory-only and resets if you stop the server.
- The included SFTS logo file is copied from the image you provided.
- Please verify official tournament rules before using this in a real competition.
