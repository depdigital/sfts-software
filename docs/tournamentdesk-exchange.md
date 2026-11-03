# Tournament Desk / scoreboard exchange, version 1

Organizer workflow: export a fresh **Master Excel** from Tournament Desk, import it in the scoreboard's **Player Settings / Data Import**, score matches, then choose **Save Tournament Desk results to USB**. The export button is available in the Schedule dialog and the Data Import results step. The JSON is saved directly to the connected USB drive, with no browser download. Back in Tournament Desk, use **Import scoreboard results** to read the USB file, review winners, import, and confirm medals separately.

The return file contains completed bouts across all categories still in the imported workbook, including results beyond the scoreboard's 50-entry recent-history display. It is a cumulative snapshot: export and import again as matches finish. Previously saved identical winners are skipped. Conflicts reject the entire file; corrections require organizer review and never silently replace winners. Each arena may export its own subset of divisions from the same event.

## Fixture transport

The original Matches, Schedule, Categories, Instructions and Exclusions worksheets retain their order and columns. A final, very-hidden **Tournament Desk** worksheet carries the exchange metadata. Its exact headers are `Format`, `Version`, `Chunk`, `Payload`. Each row repeats `sfts.fixtures`, version `1`, a consecutive one-based chunk number, and up to 16,000 UTF-16 code units of JSON text. Concatenate Payload cells in chunk order before JSON parsing. This supports 512-player brackets without exceeding Excel's cell limit.

The JSON object contains `format`, `version`, `event: {id, name, date}`, and `fixtures`. Each fixture includes its original `divisionId`, the four template category fields in order (division, gender, weight category, group), original opening `slots` (player `{id, name, club}` or null for BYE), every round's `matches`, and `fingerprint`.

Each match contains original `matchId`, scoreboard `bout`, `stage`, one-based `round`, zero-based round `index`, and `redSource` / `blueSource` original match IDs (both null in the opening round). The scoreboard validates all opening competitors, sides, stages, positions and winner sources against the actual imported bracket before retaining the metadata. It saves the metadata with each category and binds archived played bouts to the event ID and fixture fingerprint.

## Fingerprint

SHA-256 of the UTF-8 encoding of this compact JSON array, with exactly this field order:

```text
[
  divisionId,
  category,
  slots.map(p => p ? [p.id, p.name, p.club] : null),
  matches.map(m => [m.matchId, m.bout, m.stage, m.round, m.index, m.redSource, m.blueSource])
]
```

Names and clubs use the trimmed values sent in Matches. Hash output is 64 lowercase hexadecimal characters. Results, courts, timestamps, workbook ZIP bytes and scoreboard import digests are excluded. Re-exporting an unchanged approved bracket therefore retains its fingerprint, while regenerated matches or changed competitors invalidate old result files. Event IDs are assigned once and survive saves, reloads and backups; existing events receive an ID during the normal saved-event migration.

## Result transport

Host-authorized `POST /api/tournament/desk-results-usb` saves `sfts-tournamentdesk-results.json` to the detected USB drive on deployments with `SFTS_USB_IMPORT_ONLY=true`. Repeated exports use numbered filenames (`_1`, `_2`, etc.) to preserve earlier files. The existing USB queue serializes saves and unmount operations. Missing drives, mount errors and write failures are reported without a local-download fallback. Success returns only `ok`, `fileName`, `size` and `message`; the JSON payload stays on USB. The former `GET /api/tournament/desk-results.json` returns 403 and no result payload.

The USB file contains:

```json
{
  "format": "sfts.results",
  "version": 1,
  "eventId": "E-original-event-id",
  "exportedAt": "2026-11-01T12:00:00.000Z",
  "arenaNumber": "1",
  "fixtures": [{"divisionId": "original-division-id", "fingerprint": "64-lowercase-hex-characters"}],
  "results": [{"divisionId": "original-division-id", "matchId": "M-original-id", "hongId": "P-original-red-id", "chungId": "P-original-blue-id", "winnerId": "P-original-red-id"}]
}
```

Only `COMPLETED` played bouts are included; BYEs, pending bouts and undecided ties are excluded. IDs refer to Tournament Desk, never the scoreboard's local `P1` IDs. The `fixtures` list identifies every included category, including those with no completed bouts. The receiver checks version, event, unique fixture references, current fingerprints, match ownership, original athlete IDs, corners, winner participation, duplicate bouts and conflicts. It processes earlier rounds before later rounds, validates on a cloned state, and applies only after organizer review and a final revalidation against the current event. Imported winners do not confirm medals.

Limits: 128 fixture references, 8,192 completed bouts, and a result file below Tournament Desk's 12 MB input limit. Unknown exchange versions are rejected with an update instruction. Additive informational fields can be ignored within version 1; incompatible changes require a version increment in both apps.

## Compatibility and verification

Existing unlinked workbooks and Schedule XLSX/CSV reports continue working. Existing result JSON with `matchId` and `winnerId`, including arrays or a `results` wrapper, remains accepted. Older workbooks cannot produce the versioned JSON return file because they lack the original ID mapping; preserve already scored legacy fixtures and use their Schedule exports rather than relabeling those results. Newly linked imports reject archived bouts from a different or unlinked fixture.

From the sibling Tournament Desk checkout, run `npm run test:scoreboard` (or set `SFTS_SCOREBOARD_DIR` there to this checkout). Tests use isolated runtime folders under Tournament Desk's `.test-data`, never saved tournament data. Coverage includes real XLSX parsing, cross-app canonical hashes, metadata chunking at 512 players, namesakes, wrong events/versions/fixtures/corners/winners, missing predecessors, duplicates, conflicts, partial and repeated imports, 10-category legacy reports, and 61 real host-scored bouts across four divisions with BYEs, rest gaps, equivalent workbook reimport and two server restarts. The scoreboard's own `npm test` remains an independent regression check.
