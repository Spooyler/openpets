// Water Reminder v2 (openpets.water-reminder) — escalating reminders.

export const MINUTE_MS = 60_000;
export const DAY_MS = 24 * 60 * 60_000;
export const SCHEDULE_ID = "water-reminder-next";
export const MAX_LEVEL = 4;
export const ESCALATION_MULTIPLIERS = [1, 0.66, 0.33];

export function escalationDelayMs(level, baseMinutes) {
  if (level >= 3) return MINUTE_MS;
  const multiplier = ESCALATION_MULTIPLIERS[level] ?? 1;
  return Math.round(baseMinutes * multiplier) * MINUTE_MS;
}

const BUBBLE_KEYS = ["bubble.gentle", "bubble.nudge", "bubble.insistent", "bubble.urgent", "bubble.relentless"];

export function bubbleKeyForLevel(level) {
  return BUBBLE_KEYS[Math.min(level, BUBBLE_KEYS.length - 1)];
}

function nextLocalDayMs(ms = Date.now()) {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
}

export function cleanState(value = {}) {
  const state = value && typeof value === "object" ? value : {};
  const rawLevel = Number.isFinite(state.escalationLevel) ? Math.floor(state.escalationLevel) : 0;
  return {
    lastDrinkAt: Number.isFinite(state.lastDrinkAt) ? state.lastDrinkAt : 0,
    pausedUntil: Number.isFinite(state.pausedUntil) ? state.pausedUntil : 0,
    nextDueAt: Number.isFinite(state.nextDueAt) ? state.nextDueAt : 0,
    escalationLevel: Math.max(0, Math.min(rawLevel, MAX_LEVEL)),
  };
}

async function getState(ctx) {
  return cleanState(await ctx.storage.get("state"));
}

async function saveState(ctx, state) {
  const cleaned = cleanState(state);
  await ctx.storage.set("state", cleaned);
  return cleaned;
}

async function getConfig(ctx) {
  const cfg = (await ctx.config.get()) ?? {};
  const intervalMinutes = Number.isFinite(cfg.intervalMinutes) && cfg.intervalMinutes >= 5
    ? Math.min(cfg.intervalMinutes, 120)
    : 30;
  return { intervalMinutes, extraAggressive: !!cfg.extraAggressive, customSound: cfg.customSound };
}

async function scheduleAt(ctx, target, state) {
  state ??= await getState(ctx);
  const now = Date.now();
  await ctx.schedule.cancel(SCHEDULE_ID);
  await saveState(ctx, { ...state, nextDueAt: target });
  await ctx.schedule.once(SCHEDULE_ID, Math.max(1, target - now), () => fireScheduledReminder(ctx, target));
}

async function scheduleNext(ctx, delayMs) {
  const state = await getState(ctx);
  const now = Date.now();
  const target = Math.max(now + Math.max(1, delayMs), state.pausedUntil || 0);
  await scheduleAt(ctx, target, state);
}

async function fireScheduledReminder(ctx, dueAt) {
  const state = await getState(ctx);
  if (state.nextDueAt !== dueAt) return false;
  const now = Date.now();
  if (now < dueAt) {
    await scheduleAt(ctx, dueAt, state);
    return false;
  }
  return fireReminder(ctx);
}

async function scheduleFromState(ctx) {
  const state = await getState(ctx);
  const cfg = await getConfig(ctx);
  const now = Date.now();
  const delay = escalationDelayMs(state.escalationLevel, cfg.intervalMinutes);
  const base = state.pausedUntil && state.pausedUntil > now ? state.pausedUntil : now + delay;
  await scheduleNext(ctx, Math.max(1, base - now));
}

async function recordDrink(ctx, speechKey = null) {
  const now = Date.now();
  const cfg = await getConfig(ctx);
  const newState = { lastDrinkAt: now, pausedUntil: 0, escalationLevel: 0, nextDueAt: 0 };
  await scheduleAt(ctx, now + escalationDelayMs(0, cfg.intervalMinutes), newState);
  if (speechKey) await ctx.pet.speak(ctx.t(speechKey));
  return cleanState(newState);
}

export async function pauseToday(ctx) {
  const pausedUntil = nextLocalDayMs();
  const state = { ...(await getState(ctx)), pausedUntil, nextDueAt: pausedUntil, escalationLevel: 0 };
  await scheduleAt(ctx, pausedUntil, state);
  return cleanState(state);
}

let activeAlert = null;
let wanderUnsub = null;

function makeIndicator(ctx) {
  return {
    icon: ctx.assets.icon("water"),
    label: ctx.t("indicator.water"),
    tone: "info",
    color: "#0ea5e9",
    background: "#e0f2fe",
    borderColor: "#7dd3fc",
  };
}

export async function fireReminder(ctx) {
  const state = await getState(ctx);
  const now = Date.now();
  if (state.pausedUntil && state.pausedUntil > now) {
    await scheduleNext(ctx, state.pausedUntil - now);
    return false;
  }
  if (activeAlert) {
    await scheduleNext(ctx, MINUTE_MS);
    return false;
  }

  const cfg = await getConfig(ctx);
  const level = state.escalationLevel;
  const maxLevel = cfg.extraAggressive ? MAX_LEVEL : MAX_LEVEL - 1;

  if (level >= MAX_LEVEL && cfg.extraAggressive) {
    return fireAggressiveReminder(ctx, state, cfg, maxLevel);
  }

  const alertSpec = {
    text: ctx.t(bubbleKeyForLevel(level)),
    indicator: makeIndicator(ctx),
    tone: "info",
    dismissOn: ["action", "petClick", "click"],
    actions: [
      { id: "done", label: ctx.t("action.done"), style: "primary" },
      { id: "later", label: ctx.t("action.later") },
    ],
  };
  if (cfg.customSound) alertSpec.sound = cfg.customSound;

  try {
    activeAlert = await ctx.ui.alert(alertSpec);
    activeAlert.onDismiss(async () => {
      if (!activeAlert) return;
      activeAlert = null;
      const nextLevel = Math.min(level + 1, maxLevel);
      await saveState(ctx, { ...state, escalationLevel: nextLevel });
      await scheduleNext(ctx, escalationDelayMs(nextLevel, cfg.intervalMinutes));
    });
    activeAlert.onAction(async (actionId) => {
      activeAlert = null;
      if (actionId === "done") {
        await recordDrink(ctx);
      } else if (actionId === "later") {
        const nextLevel = Math.min(level + 1, maxLevel);
        const delay = escalationDelayMs(nextLevel, cfg.intervalMinutes);
        await saveState(ctx, { ...state, escalationLevel: nextLevel });
        await scheduleNext(ctx, delay);
      }
    });
  } catch {
    activeAlert = null;
    await scheduleNext(ctx, escalationDelayMs(level, cfg.intervalMinutes));
    try {
      await ctx.pet.speak(ctx.t(bubbleKeyForLevel(level)));
    } catch {}
  }
  return true;
}

async function fireAggressiveReminder(ctx, state, cfg, maxLevel) {
  const alertSpec = {
    text: ctx.t(bubbleKeyForLevel(MAX_LEVEL)),
    indicator: makeIndicator(ctx),
    tone: "info",
    pin: true,
    dismissOn: ["action"],
    actions: [
      { id: "done", label: ctx.t("action.done"), style: "primary" },
    ],
  };
  if (cfg.customSound) alertSpec.sound = cfg.customSound;

  try {
    activeAlert = await ctx.ui.alert(alertSpec);
    startWander(ctx);
    activeAlert.onDismiss(async () => {
      if (!activeAlert) return;
      activeAlert = null;
      stopWander();
      await saveState(ctx, { ...state, escalationLevel: maxLevel });
      await scheduleNext(ctx, MINUTE_MS);
    });
    activeAlert.onAction(async (actionId) => {
      activeAlert = null;
      stopWander();
      if (actionId === "done") {
        await ctx.pets.default.moveToHome();
        await recordDrink(ctx);
      }
    });
  } catch {
    activeAlert = null;
    stopWander();
    await scheduleNext(ctx, MINUTE_MS);
    try {
      await ctx.pet.speak(ctx.t(bubbleKeyForLevel(MAX_LEVEL)));
    } catch {}
  }
  return true;
}

function startWander(ctx) {
  stopWander();
  let elapsed = 0;
  wanderUnsub = ctx.pets.default.onTick((dtMs) => {
    elapsed += dtMs;
    if (elapsed >= 5_000) {
      elapsed = 0;
      ctx.pets.default.wander().catch(() => {});
    }
  });
}

function stopWander() {
  if (wanderUnsub) {
    wanderUnsub();
    wanderUnsub = null;
  }
}

export async function reconcile(ctx) {
  await ctx.schedule.cancel(SCHEDULE_ID);
  activeAlert = null;
  stopWander();
  await scheduleFromState(ctx);
}

export function register(OpenPetsPlugin) {
  OpenPetsPlugin.register({
    async start(ctx) {
      await reconcile(ctx);

      await ctx.commands.register(
        {
          id: "test-reminder",
          title: "$t:command.testReminder.title",
          description: "$t:command.testReminder.description",
          icon: "droplet",
        },
        () => fireReminder(ctx),
      );

      await ctx.commands.register(
        {
          id: "drink-now",
          title: "$t:command.drinkNow.title",
          description: "$t:command.drinkNow.description",
          icon: "check",
        },
        () => recordDrink(ctx, "speech.done"),
      );

      await ctx.commands.register(
        {
          id: "pause-today",
          title: "$t:command.pauseToday.title",
          description: "$t:command.pauseToday.description",
          icon: "pause",
        },
        async () => {
          await pauseToday(ctx);
          await ctx.pet.speak(ctx.t("speech.paused"));
        },
      );
    },
    async stop() {
      activeAlert = null;
      stopWander();
    },
  });
}
