# Water Reminder Plugin Redesign

Redesign of `openpets.water-reminder` to add configurable intervals, escalating aggression when reminders are ignored, and an opt-in extra aggressive wandering mode.

## Config Schema

Three fields, replacing the old `pace` select:

| Field | Type | Default | Constraints | Description |
|-------|------|---------|-------------|-------------|
| `intervalMinutes` | number | 30 | min 5, max 120 | How often to remind (minutes) |
| `extraAggressive` | boolean | false | — | Pet wanders with pinned bubble at max escalation |
| `customSound` | sound | — | — | Optional sound to play with the reminder |

New permissions added to manifest: `pet:move` (wander), `pet:pin` (pinned bubble).

## State

Stored under `storage.state`:

```
lastDrinkAt: number       // epoch ms of last "Done"
pausedUntil: number       // pause-today (kept from v1)
nextDueAt: number         // schedule dedup (kept from v1)
escalationLevel: number   // 0–4
```

Streak tracking (`lastStreakCelebratedDate`, `streakDays`) removed entirely.

## Escalation Model — Level-Based State Machine

Given a user-configured base interval `B` minutes:

| Level | Delay | Example (B=30) | Bubble key | Tone |
|-------|-------|----------------|------------|------|
| 0 | B | 30 min | `bubble.gentle` | Gentle |
| 1 | round(B × 0.66) | 20 min | `bubble.nudge` | Nudging |
| 2 | round(B × 0.33) | 10 min | `bubble.insistent` | Insistent |
| 3 | 1 min | 1 min | `bubble.urgent` | Urgent |
| 4 | 1 min + wander | 1 min | `bubble.relentless` | Relentless |

Level 4 only reachable when `extraAggressive` is enabled; otherwise caps at 3.

### Transitions

- **"Done"** at any level → reset to level 0, schedule next reminder at base interval `B`.
- **"Later"** or bubble dismiss → increment level (capped at 3 or 4), schedule at new level's delay.
- **Pause for today** → cancel everything, resume tomorrow at level 0.
- **App restart / reconcile** → preserve `escalationLevel` from storage, re-schedule at that level's delay.

### Delay calculation

```
escalationDelayMs(level, baseMinutes):
  if level >= 3: return 1 minute
  multipliers = [1, 0.66, 0.33]
  return round(baseMinutes * multipliers[level]) * 60_000
```

## Bubble Behavior

### Levels 0–3: Standard alert

Same alert pattern as current plugin — `ctx.ui.alert()` with:
- Escalating text from the appropriate locale key
- Water droplet indicator (icon, color, background — unchanged)
- Two actions: **Done** (primary) and **Later**
- Optional custom sound
- `dismissOn: ["action", "petClick", "click"]`

Locale keys for escalating tone:

| Key | English |
|-----|---------|
| `bubble.gentle` | "Water break? A few sips would be nice." |
| `bubble.nudge` | "Hey, you should really drink some water." |
| `bubble.insistent` | "Your pet is getting worried. Drink water!" |
| `bubble.urgent` | "DRINK. WATER. NOW." |
| `bubble.relentless` | "I'm not going away. Drink water." |

### Level 4: Extra aggressive (opt-in)

When `extraAggressive` is on and the user ignores level 3:

1. A **pinned bubble** (`pin: true`, `sticky: true`) appears with `bubble.relentless` text.
   - Only **Done** action (no Later — no escape).
   - `dismissOn: ["action"]` only — cannot click-dismiss.
2. The pet starts **wandering** via `ctx.pets.default.wander()` called on a tick loop (~every 5 seconds via `onTick`).
3. Both persist until Done is clicked.
4. On Done: dismiss pinned bubble, stop wander tick, call `moveToHome()`, reset to level 0, schedule at base interval.

The `onTick` handler is host-managed: auto-pauses during drag/hide, no extra guards needed.

## Commands

Three commands (same ids, adjusted behavior):

| Command | Id | Behavior |
|---------|----|----------|
| Test reminder | `test-reminder` | Fires alert at current escalation level |
| I drank water | `drink-now` | Resets level to 0, schedules base interval, speaks confirmation |
| Pause for today | `pause-today` | Pauses until midnight, resets level to 0 on resume |

## Permissions

```json
["pet:speak", "pet:interact", "pet:move", "pet:pin", "audio", "schedule", "storage", "commands", "events"]
```

vs current: added `pet:move` (wander/moveToHome), `pet:pin` (pinned bubble), `events` (onTick for wander loop).

## Localization

All existing locale files (en, es-419, ja, ko, pt-BR, zh-Hans, zh-Hant) need:
- Remove: `config.pace.*`, `speech.done` (streak reference), streak-related keys
- Add: `config.intervalMinutes.*`, `config.extraAggressive.*`, `bubble.gentle`, `bubble.nudge`, `bubble.insistent`, `bubble.urgent`, `bubble.relentless`, `speech.done` (without streak), `speech.reset`
- Keep: `plugin.*`, `indicator.*`, `command.*`, `action.*`, `config.customSound.*`, `speech.paused`

Only `en.json` will be fully authored; other locales get the new keys with English fallback values (matching the existing pattern in the codebase).

## Migration

Old state shape (`lastStreakCelebratedDate`, `streakDays`) is silently dropped by the new `cleanState`. Old `pace` config is ignored — users get the default 30-minute interval. No explicit migration needed; `cleanState` handles unknown/missing fields gracefully.

## Tests

Rewrite `test.js` to cover:
1. Start schedules at configured interval
2. Reminder fires at base interval, shows gentle text
3. "Later" escalates: level 0→1→2→3, each with shorter delay and different bubble text
4. "Done" at any level resets to 0 and schedules base interval
5. Level caps at 3 when `extraAggressive` is off
6. Level 4 triggers pinned bubble + wander when `extraAggressive` is on
7. Done at level 4 dismisses pinned bubble, calls moveToHome, resets
8. Pause-today pauses and resets level on resume
9. Custom sound plays when configured
10. Config change (interval) takes effect on next schedule
11. Reconcile preserves escalation level across restart
