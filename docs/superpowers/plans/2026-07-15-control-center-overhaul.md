# Control Center Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Overhaul the Control Center to a minimal warm-neutral design — remove logo, remove update-checking, add docs page, replace blue theme with warm palette.

**Architecture:** Surgical reskin of existing single-file renderer. Four independent file streams edited in parallel: Tailwind config (palette source of truth), CSS (hard-coded colors + layout classes), i18n locales (7 files, remove/add keys), main.tsx (component structure changes).

**Tech Stack:** React 18, Tailwind CSS, Vite, Electron renderer

**Spec:** `docs/superpowers/specs/2026-07-15-control-center-overhaul-design.md`

## Global Constraints

- No changes to `control-center-preload.cjs` (backend API surface unchanged)
- No changes to `index.html`
- No file splitting / component extraction
- No dark mode
- Follow existing patterns (single-file renderer, inline SVGs, `useI18n()` hook)

---

### Task 0: Tailwind Config — Palette Source of Truth

**Files:**
- Modify: `apps/desktop/tailwind.config.cjs`

**Produces:** Updated Tailwind color tokens that all CSS/JSX `text-navy`, `text-brand`, `text-slatecopy`, `shadow-glass` references resolve against.

- [ ] **Step 1: Update color tokens**

```js
module.exports = {
  content: ["./src/renderer/**/*.{ts,tsx,html}"],
  theme: {
    extend: {
      colors: {
        navy: "#2c2825",
        slatecopy: "#78716c",
        brand: { DEFAULT: "#b45309", light: "#d97706" },
      },
      fontFamily: {
        monoDisplay: ['"SFMono-Regular"', '"Cascadia Code"', '"Roboto Mono"', "monospace"],
      },
      boxShadow: {
        glass: "0 24px 70px rgba(120, 113, 108, 0.15)",
      },
    },
  },
};
```

---

### Task 1: CSS Theme Overhaul

**Files:**
- Modify: `apps/desktop/src/renderer/src/styles.css`

**Scope:** Replace all hard-coded blue hex/rgba values with warm neutral equivalents. Remove hero/dashboard-hero classes. Add `.top-bar` class.

Key replacements (hard-coded values NOT covered by Tailwind tokens):
- `rgba(219, 234, 254, 0.9)` → `rgba(245, 235, 220, 0.6)` (body gradient)
- `#f8fbff`, `#eff7ff`, `#e9f3ff` → `#faf8f5`, `#f7f5f2`, `#f3f0ec` (body gradient stops)
- `rgba(96, 165, 250, *)` → `rgba(168, 162, 158, *)` (scrollbar)
- `rgba(126, 161, 210, *)` → `rgba(168, 162, 158, *)` (glass borders)
- `rgba(61, 99, 160, *)` → `rgba(120, 113, 108, *)` (shadows)
- `rgba(37, 99, 235, *)` → `rgba(180, 83, 9, *)` (brand-tinted borders)
- `rgba(29, 78, 216, *)` → `rgba(146, 64, 14, *)` (active borders)
- `#3b96ff` → `#d97706`, `#176df2` → `#b45309` (gradients in buttons/tabs/filters)
- `#55a6ff` → `#f59e0b` (hover gradients)
- `blue-50` → `stone-50`, `blue-100` → `stone-100`, `blue-200` → `stone-200`, `blue-300` → `stone-300` (all Tailwind @apply refs)
- `blue-50/80` → `stone-50/80`, etc. (opacity variants)
- `blue-700` → `amber-700` (text accents)
- `blue-500` → `amber-500` (solid fills)
- Remove: `.hero`, `.hero-content`, `.hero h1`, `.hero-desc`, `.hero-logo-container`, `.hero-brand-logo`, `.eyebrow`
- Remove: `.dashboard-hero`, `.dashboard-hero::before`, `.dashboard-hero-content`, `.dashboard-hero-title`, `.dashboard-hero-desc`, `.dashboard-hero-pet`
- Add: `.top-bar` class

Dashboard bar-track gradient: `from-blue-500 to-cyan-400` → `from-amber-500 to-yellow-400`

---

### Task 2: i18n Locale Updates

**Files (all 7 independent):**
- Modify: `apps/desktop/src/i18n/locales/en.ts`
- Modify: `apps/desktop/src/i18n/locales/es-419.ts`
- Modify: `apps/desktop/src/i18n/locales/ja.ts`
- Modify: `apps/desktop/src/i18n/locales/ko.ts`
- Modify: `apps/desktop/src/i18n/locales/pt-BR.ts`
- Modify: `apps/desktop/src/i18n/locales/zh-Hans.ts`
- Modify: `apps/desktop/src/i18n/locales/zh-Hant.ts`

**Remove keys** (from all 7):
- `dashboard.update.available`, `dashboard.update.error`, `dashboard.update.checking`, `dashboard.update.current`, `dashboard.update.notChecked`
- `dashboard.system.updates`, `dashboard.system.version`
- `dashboard.hero.eyebrow`
- `settings.general.updateAvailable`, `settings.general.checking`, `settings.general.checkForUpdates`
- `settings.busy.checking`, `settings.busy.opening`
- Any `settings.update.*` keys
- `app.logo.alt`

**Add keys** (to all 7):
- `nav.docs`
- `docs.title`
- `docs.placeholder`

English values: `"Docs"`, `"Documentation"`, `"Coming soon — we'll add guides and references here."`

For non-English locales, use appropriate translations.

---

### Task 3: main.tsx Component Changes

**File:**
- Modify: `apps/desktop/src/renderer/src/main.tsx`

This is the largest task. Changes grouped by area:

**A. Removals:**
1. Remove `import openPetsLogoUrl from "../../../assets/openpets.webp";`
2. Remove `UpdateStatus` type
3. Remove `getUpdateStatus()`, `checkForUpdates()`, `openUpdateReleasePage()` from `ControlCenterApi`
4. Remove `updateStatus: UpdateStatus` from `DashboardSnapshot`
5. Remove `formatUpdateStatus()` function
6. Remove `PlaceholderView` component (dead code)
7. Remove `routeMetadata` object

**B. Route additions:**
1. Add `"docs"` to `Route` type: `type Route = "dashboard" | "pets" | "sessions" | "settings" | "plugins" | "integrations" | "docs";`
2. Add `DocsIcon` SVG component (book icon)
3. Add `{ id: "docs" as const, labelKey: "nav.docs", icon: <DocsIcon /> }` to `navTabs`
4. Add `"docs"` check to `isRoute()` function
5. Add `DocsView` component (centered GlassCard with icon, title, placeholder text)

**C. ControlCenter component restructure:**
1. Replace `<header className="hero">...</header>` + `<nav className="nav-bar">...</nav>` with single `<header className="top-bar">` containing wordmark left + nav tabs right
2. Remove `currentMeta` variable (was `routeMetadata[currentRoute]`)
3. Add routing case: `currentRoute === "docs" ? <DocsView /> :`

**D. DashboardView cleanup:**
1. Remove `updateStatus` destructuring and `updateLabel` computation
2. Remove the "Updates" `dashboard-system-item` div
3. Remove version footer `<div className="mt-auto pt-4 ...">`
4. Replace `<section className="dashboard-hero">` with a simpler GlassCard showing pet sprite + name + change button

**E. SettingsView cleanup:**
1. Remove `updateStatus` state: `const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);`
2. Remove `api.getUpdateStatus()` from `loadSettings()` Promise.all and its `setUpdateStatus(nextUpdate)` assignment
3. Remove the `if (nextUpdate.state === "checking")` block
4. Remove entire `settings-system-footer` div (lines ~1506-1521)

**F. Misc:**
1. Replace `text-slatemuted` with `text-slatecopy` (line 598)
2. Replace Tailwind `blue-*` class references in JSX with `stone-*`/`amber-*` equivalents (e.g. `bg-blue-50` → `bg-stone-50`, `text-blue-700` → `text-amber-700`, `ring-blue-200/50` → `ring-stone-200/50`)

---

### Task 4: Review & Verification

After all streams complete:
- Build check: `npm run build` or equivalent
- Visual review: start dev server, inspect control center
- Verify no broken references to removed types/functions
- Verify all nav tabs work including new Docs page
