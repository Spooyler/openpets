# Control Center Overhaul — Minimal Warm Redesign

## Summary

Overhaul the Control Center UI to a minimal, warm-neutral design. Remove the large logo, strip update-checking infrastructure, add a Documentation placeholder page, and replace the blue glassmorphism theme with a warm neutral palette.

## Approach

Surgical reskin (Approach A): keep existing component structure, swap colors and header layout, remove/add targeted sections. Single-file renderer (`main.tsx`) plus CSS and i18n locale files.

---

## 1. Color & Theme (styles.css)

### Palette

| Token | Old | New |
|---|---|---|
| Background | `#f8fbff` blue-white gradient | `#faf8f5` warm off-white, subtle `radial-gradient(circle at 12% 8%, rgba(245, 235, 220, 0.6), transparent 24%)` |
| Text primary | `#102149` (navy) | `#2c2825` (warm charcoal) |
| Text secondary | slatecopy (blue-tinted) | `#78716c` (stone-500) |
| Accent/brand | `#176df2` / `#3b96ff` (blue) | `#b45309` (amber-700) / `#d97706` (amber-600) |
| Card bg | `rgba(255,255,255,0.76)` with blue borders | `rgba(255,255,255,0.72)` with `stone-200` borders |
| Active tab bg | Blue gradient `#3b96ff → #176df2` | Amber gradient `#d97706 → #b45309` |
| Hover accents | Blue-100/200 tints | Stone-100/200 tints |
| Scrollbar thumb | `rgba(96, 165, 250, 0.25)` | `rgba(168, 162, 158, 0.35)` (stone) |
| Shadows | `rgba(61,99,160,*)` | `rgba(120, 113, 108, *)` (stone-based) |

### What changes

- `body` background gradient → warm off-white
- All `blue-*` Tailwind references in `@apply` → `stone-*` / `amber-*`
- `.glass` card border/shadow → stone-tinted
- `.btn-primary` gradient → amber tones
- `.btn-secondary` border/text → amber accent
- `.nav-tab.active` → amber gradient
- `.filter.active` → amber gradient
- `.filter.original.active` stays orange (already fits)
- `.filter.featured.active` stays purple (already fits)
- `.dashboard-hero*` classes → removed entirely (Section 5 replaces hero with a simple card)
- `.dashboard-bar-track span` gradient → amber-to-warm tones
- Stat icon backgrounds → `stone-50` / `amber-50`

### Tailwind config (`tailwind.config.cjs`)

This is the palette source of truth. Update custom theme colors:

| Token | Old | New |
|---|---|---|
| `navy` | `#102149` | `#2c2825` (warm charcoal) |
| `slatecopy` | `#63708f` | `#78716c` (stone-500) |
| `brand.DEFAULT` | `#176df2` | `#b45309` (amber-700) |
| `brand.light` | `#3b96ff` | `#d97706` (amber-600) |
| `glass` shadow | `rgba(50, 104, 180, 0.18)` | `rgba(120, 113, 108, 0.15)` |

This means all existing `text-navy`, `text-slatecopy`, `text-brand`, `shadow-glass` references in JSX and CSS automatically pick up the new palette without individual edits. Only hard-coded hex values in `styles.css` need manual replacement.

Note: `slatemuted` appears once in main.tsx (line 598) but is not defined in the Tailwind config — it's a dead token. Replace with `text-slatecopy` during Stream 3 work.

### Custom property strategy

No CSS custom properties introduced (keeps the existing direct-value approach). Hard-coded color values in `styles.css` are replaced manually; Tailwind-token references update automatically via config.

---

## 2. Header → Slim Top Bar (main.tsx + styles.css)

### Remove

- `<header className="hero">` block and its children (eyebrow, h1, hero-desc, hero-logo-container, hero-brand-logo img)
- `import openPetsLogoUrl` asset import
- `routeMetadata` object (no longer rendered in header; only other consumer was `PlaceholderView` which is dead code)
- `PlaceholderView` component (dead code — defined but never called)
- CSS classes: `.hero`, `.hero-content`, `.hero h1`, `.hero-desc`, `.hero-logo-container`, `.hero-brand-logo`

### Add

New `<header className="top-bar">` containing:
- Left: inline SVG paw icon (16px) + "OpenPets" wordmark (`font-monoDisplay text-sm font-black`)
- Right: nav tabs (moved from separate `<nav className="nav-bar">` into the header bar)

CSS `.top-bar`:
```
height: 48px; display: flex; align-items: center; justify-content: space-between;
gap: 12px; padding: 0 4px; margin-bottom: 16px;
border-bottom: 1px solid rgba(168, 162, 158, 0.2);
```

The `<nav className="nav-bar">` is removed as a separate element — tabs live inside `.top-bar`.

---

## 3. Remove Update Infrastructure (main.tsx + i18n locales)

### main.tsx

- Remove `UpdateStatus` type definition
- Remove from `ControlCenterApi`: `getUpdateStatus()`, `checkForUpdates()`, `openUpdateReleasePage()`
- Remove from `DashboardSnapshot`: `updateStatus: UpdateStatus` field
- Remove `formatUpdateStatus()` helper function
- **DashboardView**: remove `updateLabel` computation, remove the "Updates" row from `dashboard-system-list`, remove the version footer `<div className="mt-auto pt-4 ...">` block
- **SettingsView**: remove `updateStatus` state, remove `api.getUpdateStatus()` from `loadSettings()`, remove the `checkForUpdates` auto-check on "checking" state, remove the entire `settings-system-footer` block (version display + check/update buttons)
- Remove i18n key references: `dashboard.update.*`, `dashboard.system.updates`, `dashboard.system.version`, `settings.general.updateAvailable`, `settings.general.checking`, `settings.general.checkForUpdates`, `settings.busy.checking`, `settings.busy.opening`, `settings.update.*`

### i18n locale files (all 7)

Remove the following key groups from each locale file:
- `dashboard.update.available`, `dashboard.update.error`, `dashboard.update.checking`, `dashboard.update.current`, `dashboard.update.notChecked`
- `dashboard.system.updates`, `dashboard.system.version`
- `settings.general.updateAvailable`, `settings.general.checking`, `settings.general.checkForUpdates`
- `settings.busy.checking`, `settings.busy.opening`
- Any `settings.update.*` keys
- `app.logo.alt` (logo removed)
- `dashboard.hero.eyebrow` (hero removed)

### Not touched

- `control-center-preload.cjs` — backend API surface stays as-is (endpoints just go unused)

---

## 4. Documentation Page (main.tsx + i18n locales)

### main.tsx

- Add `"docs"` to `Route` type union
- Add to `navTabs` array: `{ id: "docs", labelKey: "nav.docs", icon: <DocsIcon /> }`
- Add `DocsIcon` SVG component (book/document icon)
- Add `isRoute()` check for `"docs"`
- Add `DocsView` component:
  ```tsx
  function DocsView() {
    const { t } = useI18n();
    return (
      <div className="flex flex-col gap-6 h-full">
        <GlassCard className="flex h-full flex-col items-center justify-center gap-4 text-center py-16">
          <DocsIcon />
          <h2 className="...">{t("docs.title")}</h2>
          <p className="...">{t("docs.placeholder")}</p>
        </GlassCard>
      </div>
    );
  }
  ```
- Add routing case in `ControlCenter` render

### i18n locale files (all 7)

Add keys:
- `nav.docs`: "Docs" (en), localized for others
- `docs.title`: "Documentation" (en), localized for others
- `docs.placeholder`: "Coming soon — we'll add guides and references here." (en), localized for others

---

## 5. Dashboard Hero Simplification (main.tsx + styles.css)

### Remove

- The `<section className="dashboard-hero">` with its blue gradient, dot-grid overlay, and large layout
- CSS classes: `.dashboard-hero`, `.dashboard-hero::before`, `.dashboard-hero-content`, `.dashboard-hero-title`, `.dashboard-hero-desc`, `.dashboard-hero-pet`

### Replace with

A simpler card (using `GlassCard`) showing:
- Default pet sprite (smaller, `SpriteFrame` at "detail" size)
- Pet name as a heading
- "Change Pet" button
- No gradient hero banner, no eyebrow text

---

## Parallelization Plan

The following work streams touch **independent files** and can be assigned to parallel agents:

### Stream 0: Tailwind Config
**File:** `apps/desktop/tailwind.config.cjs`
**Scope:** Update custom theme color tokens (`navy`, `slatecopy`, `brand`, `glass` shadow) to warm neutral values per Section 1.
**Dependencies:** None. This is the palette source of truth — all Tailwind token references (`text-navy`, `text-brand`, etc.) in CSS and JSX automatically pick up new values.

### Stream 1: CSS Theme Overhaul
**File:** `apps/desktop/src/renderer/src/styles.css`
**Scope:** Replace hard-coded blue hex values (not covered by Tailwind tokens) with warm neutral equivalents. Add `.top-bar` class. Remove `.hero*` and `.dashboard-hero*` classes.
**Dependencies:** None (Tailwind tokens are resolved at build time; hard-coded values in CSS are independent).

### Stream 2: i18n Locale Updates
**Files (all independent of each other):**
- `apps/desktop/src/i18n/locales/en.ts`
- `apps/desktop/src/i18n/locales/es-419.ts`
- `apps/desktop/src/i18n/locales/ja.ts`
- `apps/desktop/src/i18n/locales/ko.ts`
- `apps/desktop/src/i18n/locales/pt-BR.ts`
- `apps/desktop/src/i18n/locales/zh-Hans.ts`
- `apps/desktop/src/i18n/locales/zh-Hant.ts`

**Scope:** Remove update-related i18n keys, add docs page keys (`nav.docs`, `docs.title`, `docs.placeholder`). Remove `app.logo.alt` key.
**Dependencies:** None (each locale file is independent).

### Stream 3: main.tsx Component Changes
**File:** `apps/desktop/src/renderer/src/main.tsx`
**Scope:** All structural changes:
- Remove logo import and `UpdateStatus` type/API/functions
- Replace hero header with slim top bar
- Merge nav into top bar
- Add `"docs"` route, `DocsIcon`, `DocsView` component
- Simplify dashboard hero to a card
- Remove `routeMetadata` (no longer rendered in header)
- Clean up DashboardView and SettingsView update references
- Replace Tailwind `blue-*`, `navy`, `brand`, `slatecopy` class references with warm neutral equivalents in JSX

**Dependencies:** Depends on Streams 1 and 2 being aligned on naming, but since we're using the same Tailwind classes (`stone-*`, `amber-*`) and the same i18n keys, agents can work independently as long as they follow this spec.

### Parallelization Summary

| Stream | File(s) | Can run in parallel with |
|---|---|---|
| 0: Tailwind | `tailwind.config.cjs` | All others |
| 1: CSS | `styles.css` | All others |
| 2: i18n | 7 locale files | All others (each locale is also independent) |
| 3: Components | `main.tsx` | All others |

All four streams can run **fully in parallel**. Within Stream 2, all 7 locale files can also be parallelized. Stream 3 is the largest single unit but cannot be split further since it's a single file.

---

## Out of Scope

- No changes to `control-center-preload.cjs` (backend API surface unchanged)
- No changes to `index.html`
- No file splitting / component extraction (future cleanup)
- No dark mode support (not currently implemented)
- No changes to Tailwind config or theme extension
