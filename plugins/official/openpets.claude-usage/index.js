// Claude Usage (openpets.claude-usage) — always-on Claude usage HUD.
// Consumes the host's `agent:usage` senses event: limit buckets from the
// Claude OAuth usage API plus per-model 5-hour session usage from transcripts.

const runtimeStates = new WeakMap();

const bucketIcons = { session: "timer", weekly_all: "sun" };

export function toneForUtilization(utilization, stale) {
  if (stale) return "slate";
  if (utilization >= 90) return "red";
  if (utilization >= 70) return "amber";
  return "blue";
}

export function hudItemsFromPayload(payload) {
  const buckets = payload && Array.isArray(payload.buckets) ? payload.buckets : [];
  const stale = payload?.stale === true;
  return buckets.slice(0, 4).map((bucket) => ({
    icon: bucketIcons[bucket.id] ?? "star",
    value: Math.max(0, Math.min(100, Math.round(Number(bucket.utilization) || 0))),
    tone: toneForUtilization(Number(bucket.utilization) || 0, stale),
    label: String(bucket.label ?? bucket.id ?? ""),
  }));
}

export function modelDisplayName(model) {
  const parts = String(model).split("-");
  if (parts[0] !== "claude" || parts.length < 2) return String(model);
  const withoutDate = /^\d{8}$/.test(parts[parts.length - 1]) ? parts.slice(0, -1) : parts;
  const name = withoutDate[1].charAt(0).toUpperCase() + withoutDate[1].slice(1);
  const version = withoutDate.slice(2).join(".");
  return version ? `${name} ${version}` : name;
}

export function formatTokens(count) {
  const n = Number(count) || 0;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function panelMessageFromPayload(payload, theme) {
  return {
    type: "usage",
    theme,
    payload,
    models: (Array.isArray(payload?.models) ? payload.models : []).map((model) => ({
      ...model,
      displayName: modelDisplayName(model.model),
    })),
  };
}

async function currentTheme(ctx) {
  try {
    return (await ctx.system.info()).theme === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

async function dismissHud(state) {
  if (!state.hudBubble) return;
  try { await state.hudBubble.dismiss(); } catch {}
  state.hudBubble = null;
}

// Standalone mode pins the HUD to a dedicated spawned pet instead of the
// default pet; leaving the mode closes that pet again.
async function ensureWidgetPet(ctx, state) {
  if (!state.standalone) {
    if (state.widgetPet) {
      try { await state.widgetPet.close(); } catch {}
      state.widgetPet = null;
    }
    return;
  }
  if (state.widgetPet) return;
  try {
    state.widgetPet = await ctx.pets.spawn({ petId: "usage-widget", name: "Claude Usage" });
  } catch {
    state.widgetPet = null;
  }
}

async function updateHud(ctx, state) {
  if (state.hudHidden) {
    await dismissHud(state);
    return;
  }
  const items = hudItemsFromPayload(state.payload);
  if (items.length === 0) return;
  await ensureWidgetPet(ctx, state);
  const spec = { tone: "info", sticky: true, pin: true, dismissOn: [], priority: "normal", hud: { items } };

  if (state.hudBubble) {
    try {
      await state.hudBubble.update(spec);
      return;
    } catch {
      state.hudBubble = null;
    }
  }
  try {
    const bubble = state.widgetPet ? await state.widgetPet.speak(spec) : await ctx.ui.bubble(spec);
    bubble.onDismiss(() => {
      if (state.hudBubble?.id === bubble.id) state.hudBubble = null;
    });
    state.hudBubble = bubble;
  } catch {}
}

async function sendToPanel(ctx, state) {
  if (!state.panel || !state.payload) return;
  try {
    await state.panel.postMessage(panelMessageFromPayload(state.payload, await currentTheme(ctx)));
  } catch {}
}

async function onUsage(ctx, state, payload) {
  state.payload = payload;
  await updateHud(ctx, state);
  await sendToPanel(ctx, state);
}

async function openDetails(ctx, state) {
  if (state.panel) {
    try {
      await state.panel.show();
      await sendToPanel(ctx, state);
      return;
    } catch {
      state.panel = null;
    }
  }
  try {
    const panel = await ctx.ui.panel({ panel: "details", title: ctx.t("panel.title"), width: 400, height: 460 });
    panel.onMessage((msg) => {
      if (msg && msg.type === "ready") void sendToPanel(ctx, state);
      if (msg && msg.type === "close") void panel.close().then(() => { if (state.panel === panel) state.panel = null; });
    });
    state.panel = panel;
    await sendToPanel(ctx, state);
  } catch {}
}

export function register(OpenPetsPlugin) {
  OpenPetsPlugin.register({
    async start(ctx) {
      const state = { payload: null, hudBubble: null, panel: null, widgetPet: null, hudHidden: false, standalone: false };
      runtimeStates.set(ctx, state);

      try { state.hudHidden = (await ctx.storage.get("hudHidden")) === true; } catch {}
      try { state.standalone = ((await ctx.config.get()) ?? {}).standaloneWidget === true; } catch {}

      ctx.events.on("agent:usage", (payload) => void onUsage(ctx, state, payload));

      ctx.config.onChange(async (cfg) => {
        const standalone = cfg?.standaloneWidget === true;
        if (standalone === state.standalone) return;
        state.standalone = standalone;
        await dismissHud(state);
        await ensureWidgetPet(ctx, state);
        await updateHud(ctx, state);
      });

      await ctx.commands.register(
        { id: "details", title: "$t:command.details.title", description: "$t:command.details.description" },
        () => openDetails(ctx, state),
      );
      await ctx.commands.register(
        { id: "toggle-widget", title: "$t:command.toggle.title", description: "$t:command.toggle.description" },
        async () => {
          state.hudHidden = !state.hudHidden;
          try { await ctx.storage.set("hudHidden", state.hudHidden); } catch {}
          await updateHud(ctx, state);
        },
      );
    },
    async stop(ctx) {
      const state = runtimeStates.get(ctx);
      if (state?.panel) {
        try { await state.panel.close(); } catch {}
        state.panel = null;
      }
      if (state?.widgetPet) {
        try { await state.widgetPet.close(); } catch {}
        state.widgetPet = null;
      }
    },
  });
}
