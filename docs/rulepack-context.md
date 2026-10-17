# SFTS Rule Pack

`config/rules.default.json` is the built-in, editable competition rule pack. It is JSONC: ordinary JSON with `//` or `/* ... */` comments. The comments are supported by SFTS and are intentionally retained in the built-in pack so a future rules administrator can understand each setting.

## Safe workflow

1. Copy the default pack to a new file and update `ruleset.id`, `ruleVersion`, `effectiveFrom`, and `source`.
2. Change only a rule supported by this schema and keep normal JSON punctuation: quoted keys, quoted text values, and commas between entries.
3. Load the file from the Rules screen while no match is active. SFTS validates the complete file before changing the active pack.
4. Keep the original approved file with the event records. The resolved rule values and ruleset identity are recorded with every completed match.

An imported pack is written to the active data folder as strict JSON, so its comments are not retained in that generated copy. Keep the commented source file as the editable master.

## What the pack controls

| Section | Controls |
|---|---|
| `match` | Regulation format, rounds, timer limits, and break-duration tiers. |
| `scoring` | Normal scores, labels, technical combinations, and Gam-jeom point award. |
| `penalties.gamJeom` | Per-round loss and optional cumulative match-loss policy. |
| `decisions` | Point-gap policy, permitted manual decision codes, and result methods. |
| `tieBreak` | Golden Round, Woo-se-girok, Golden Round win thresholds, and superiority order. |
| `voting` | Strict-majority remote range. |
| `medical` | Kye-shi availability and limit. |
| `tournament` | Supported tournament grouping and bracket behavior. |

`decisions.roundTie` supports the legacy `{ "type": "DRAW" }` policy and a
rule-pack-controlled `SUPERIORITY` policy. Superiority criteria are evaluated
top to bottom, and the first unequal count decides the round. The supported
criteria are `TECHNICAL_HEAD_KICKS`, `TECHNICAL_CHEST_KICKS`, and
`NORMAL_HEAD_KICKS`. With `unresolved: "WOO_SE_GIROK"`, an unresolved tie in a
non-final regulation round opens a round-only Woo-se-girok decision. An
unresolved final regulation round is recorded as tied and follows
`tieBreak.afterRegulation`, offering Golden Round or match-level Woo-se-girok.

## Golden Round and superiority

`tieBreak.afterRegulation.options` must contain both `GOLDEN_ROUND` and `WOO_SE_GIROK`, and both options must be enabled in their own sections. This guarantees that a tied regulation match always offers Golden Round and Woo-se-girok alongside the operator's Back action.

`tieBreak.goldenRound.superiorityCriteria` is evaluated top to bottom at expiry. The supported criteria are:

- `GOLDEN_ROUND_PUNCH` — a player who recorded a punch in the Golden Round beats a player who did not.
- `GOLDEN_ROUND_HIT_COUNT` — more registered scoring hits in the Golden Round wins.
- `REGULATION_ROUNDS_WON` — more regulation-round wins wins.
- `FEWER_TOTAL_GAMJEOMS` — fewer Gam-jeoms across completed regulation rounds wins.
- `REFEREE_DECISION` — stops automatic comparison and asks the referee; it must be last.

## Limits and validation

The pack is the authority for supported competition policy, but it cannot define an entirely new mechanism that this software does not implement. `compatibility.requiredCapabilities` protects against that: an unknown requested capability is rejected with an error rather than being ignored.

The current engine supports 1–15 regulation rounds with a decisive best-of-rounds requirement, strict-majority voting with 1–4 remotes, and the decision codes listed in the default pack. Tournament format remains single-elimination. A future federation rule that needs a new game mechanism requires one engine capability to be added; once added, later changes to that mechanism can remain pack-only.

The installed referee remotes have three physical base-score controls, so `scoring.basePointValues` must remain `[1, 2, 3]`. Their labels and the resulting technical awards are pack-controlled. The validator rejects a different base-control layout instead of loading a pack that the physical remotes cannot operate correctly.

## Legacy packs

Schema v1 packs remain readable. SFTS migrates them in memory to v2 defaults for the new break and tie-break fields, then validates the result. Legacy packs that used manual tournament tie resolution are upgraded to offer both Golden Round and Woo-se-girok. Previously saved schema-v2 packs using that legacy manual setting receive the same compatibility upgrade. Save a legacy pack again through SFTS only after reviewing its v2 equivalent; the built-in v2 pack is the recommended template for future editing.

## Important operational note

Rule changes apply only between matches. Do not edit or switch packs during an active bout. Completed history stores the normalized rule snapshot used for the result; preserve the source pack separately when formal audit requirements need the original commented text too.
