# Taekwondo Scoring System — Timer & Kye-shi
## User
Is the timer shows millisecond in taekwondo scoring system at the last 10 seconds of the match

## Assistant
Yes—but usually it’s **not milliseconds**. Taekwondo scoring systems commonly switch to showing **tenths of a second (0.1 s)** near the end of the round.

For example, instead of:

`00:10` → `00:09` → `00:08`

the final 10 seconds can display like:

`10.0 → 9.9 → 9.8 → … → 0.2 → 0.1 → 0.0`

So for your scoring system, I’d recommend making the timer show **MM:SS normally**, then automatically switch to **SS.t** at **10.0 seconds remaining**. That gives enough precision without showing unnecessary true milliseconds like `9.843`.

## User
Yes

## Assistant
For your scoring system, I’d use this exact timer design.

One correction to my previous answer: I can verify that **the last 10 seconds have special importance in WT officiating**, but I could **not find a WT rule that requires the scoreboard itself to display tenths/milliseconds**. So the decimal display should be treated as a **scoring-system UI feature**, not an official WT requirement.

### Timer specification

| Remaining time | Scoreboard display |
|---|---|
| 2:00.000 → 10.001 | `2:00`, `1:59` … `0:11` |
| **10.000 seconds** | **`10.0`** |
| 9.999 → 9.901 | `10.0` |
| 9.900 → 9.801 | `9.9` |
| 5.000 | `5.0` |
| 1.000 | `1.0` |
| 0.500 | `0.5` |
| 0.100 | `0.1` |
| 0 | **`0.0` + automatic round stop** |

So don't display actual milliseconds like `09.847`. Use **tenths of a second**.

The internal timer, however, should still store milliseconds:

```text
remainingMs = 120000
```

For a 2-minute round.

Use these states:

```text
READY
RUNNING
PAUSED
ROUND_END
BREAK
```

The behavior should be:

```text
START
READY → RUNNING

KAL-YEO / PAUSE
RUNNING → PAUSED
Timer freezes exactly at current remaining milliseconds.

KYE-SOK / RESUME
PAUSED → RUNNING
Continue from stored remaining time.

RESET
→ configured round time

TIME = 0
→ ROUND_END
→ stop timer
→ display 0.0
→ lock new scoring input
```

### Important developer detail

**Do not make the timer by subtracting 100 ms every 100 ms.**

That can drift:

```javascript
remaining -= 100;
```

Avoid that.

Instead calculate the remaining time from an accurate clock:

```javascript
endTime = performance.now() + remainingMs;

remainingMs = Math.max(
    0,
    endTime - performance.now()
);
```

This keeps the competition timer accurate even if the browser briefly lags.

For display formatting:

```javascript
function formatTimer(ms) {
    if (ms <= 0) {
        return "0.0";
    }

    // Final 10 seconds
    if (ms <= 10000) {
        const tenths = Math.ceil(ms / 100) / 10;
        return tenths.toFixed(1);
    }

    // Normal match time
    const totalSeconds = Math.ceil(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;

    return `${minutes}:${seconds
        .toString()
        .padStart(2, "0")}`;
}
```

That gives:

```text
2:00
1:59
...
0:12
0:11
10.0   ← automatic switch
9.9
9.8
9.7
...
1.0
0.9
0.8
...
0.2
0.1
0.0
```

For **your 4-judge Wi-Fi scoring system**, I would also make the **Main Scoreboard the master clock**. Corner referee phones should receive the timer state from the main device but should **never run an independent official match timer**. That prevents four phones from slowly becoming out of sync.

At `0.0`, the main system should automatically stop the round and reject any new judge-button presses for that round.

I would make this the timer behavior for your **Taekwondo Scoring System V2**.

## User
And how a khe-si timer works

## Assistant
Yes. **Kye-shi (계시)** is the separate **injury/medical treatment timer** in a Taekwondo match. It should not reduce the normal round clock.

Under the WT Competition Rules currently available, the athlete can generally receive necessary first-aid treatment for **up to 1 minute** after Kye-shi is declared. The one-minute count begins when the commissioned doctor enters the mat, or after waiting up to 10 seconds if the doctor is not immediately available. The referee can suspend that one-minute limit in certain situations where additional medical treatment is necessary.

For your scoring system, I recommend this workflow:

1. **Referee says “Kal-yeo”** → normal match timer pauses immediately.
2. **Referee declares “Kye-shi.”**
3. Your scoreboard opens a separate **KYE-SHI timer**.
4. When the doctor enters the mat, press **START KYE-SHI**.
5. Kye-shi counts **up from `0:00` toward `1:00`**. I prefer count-up because it makes the elapsed treatment time obvious.
6. At **40 seconds**, make the display more noticeable because WT rules say the referee begins announcing elapsed time in **5-second intervals** from that point.
7. Display:
   `0:40 → 0:45 → 0:50 → 0:55 → 1:00`
8. At `1:00`, give a clear visual/audio indication, but **do not automatically declare a winner**. The center referee controls the decision.
9. If the referee permits extra medical time, provide a protected **SUSPEND KYE-SHI** control.
10. When the referee orders continuation, close Kye-shi and resume the normal match timer from exactly where it stopped.

For example:

```text
MATCH CLOCK
01:27
  PAUSED

      KYE-SHI
       00:43

   [PAUSE KYE-SHI]
     [END KYE-SHI]
```

Your internal states could be:

```text
MATCH_RUNNING
      ↓ Kal-yeo
MATCH_PAUSED
      ↓ Kye-shi
KYESHI_WAITING_FOR_DOCTOR
      ↓ Doctor enters / Start
KYESHI_RUNNING
      ↓
KYESHI_1_MINUTE_REACHED
      ↓ Referee decision
MATCH_RESUME / MATCH_END
```

One especially important detail for your system: **Kye-shi and the normal fight clock must be two completely independent timers**. If the fight clock is stopped at `01:27.4`, after Kye-shi finishes it should still be exactly `01:27.4`; the medical timer must never alter it.

## User
Is there any other button to start it

## Assistant
Yes. In systems like **KPNP**, there are actually **two ways** related to starting Kye-shi:

- A dedicated **Kye-shi / Injury Time** button starts the Kye-shi timer.
- A separate **Call Doctor** button can **automatically start Kye-shi** when the doctor is called.

So for **your scoring system**, I’d copy that idea:

**[⏸ KAL-YEO]  [🩺 DOCTOR / KYE-SHI]  [▶ RESUME]**

Pressing **DOCTOR / KYE-SHI** would:
1. Pause the match clock if it is running.
2. Show **KYE-SHI** prominently.
3. Start the separate injury timer.
4. Keep the normal match time frozen.
5. Let the operator stop/end Kye-shi and then resume the match.

You could also keep a separate **KYE-SHI** button in the operator controls, because KPNP itself has both a **Doctor Call** function and a dedicated **Kye-shi** function.

For your system, I think **one combined `🩺 KYE-SHI` button** is cleaner and harder for the operator to press incorrectly.

## User
Make this all conversation from the start a .MD file
