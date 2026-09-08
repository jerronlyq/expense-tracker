# Apex Expense Tracker — Codebase Guide

## Project overview
Personal expense tracking dashboard for a single user (@jerronlyq). Data is entered via a Telegram bot which writes to a Google Sheet. The dashboard fetches that sheet as a public CSV and renders analytics entirely client-side. Hosted on GitHub Pages.

**Live repo:** https://github.com/jerronlyq/expense-tracker/

## Stack
Plain HTML / CSS / JS — no framework, no build step, no `package.json`.  
Open `index.html` directly in a browser, or run a local server:
```
python -m http.server 8080
```
Then visit `http://localhost:8080`.

## File structure
```
expense-tracker-v2/
├── index.html      — full page markup; both tab panels, modals, chart canvases
├── style.css       — design system, layout, dark/light theme
├── app.js          — all data fetching, parsing, state, and rendering logic
├── favicon.svg     — diamond + $ sign SVG icon
└── TelegramGAS.gs  — the Telegram bot's Apps Script source. Contains live
                       secrets (bot token, spreadsheet ID) — gitignored,
                       never commit this file. Kept here for reference only.
```

---

## Data source
**One Google Sheet, two tabs, fetched by name** — no "Publish to Web" step needed. The dashboard stores a single plain share link (e.g. `https://docs.google.com/spreadsheets/d/XXXXX/edit`) and extracts the spreadsheet ID from it (`extractSpreadsheetId()` in app.js), then builds a fetch URL per tab using Google's `gviz` CSV-by-name endpoint:
```
https://docs.google.com/spreadsheets/d/<ID>/gviz/tq?tqx=out:csv&sheet=<TAB NAME>
```
(`buildSheetTabUrl()` in app.js). This requires the spreadsheet's general access to be **"Anyone with the link – Viewer"** — a different setting from "Publish to web", and one Google checks separately.

The two required tabs, matched **by exact name** (case-sensitive):
- **`Variable Expenses`** (`VARIABLE_TAB_NAME`) — the Telegram bot's transaction log. Columns: `Date`, `Username`, `Category`, `Description`, `Amount`. Parsed by `parseCSV()` into `state.allRows`.
- **`Fixed Expenses`** (`FIXED_TAB_NAME`) — a manually-maintained effective-dated schedule (see below). Columns: `Category`, `Description`, `Amount`, `Start Date`, `End Date`. Parsed by `parseFixedCSV()` into `state.fixedSchedule`.

**Date formats accepted:** `YYYY-MM-DD` (primary), `DD/MM/YYYY` (fallback), or any string parseable by `new Date()`.

**Amount parsing:** strips any non-numeric characters (e.g. `S$12.50` → `12.50`) via `replace(/[^0-9.-]/g, '')`.

The share link is saved in `localStorage` under key `expense_tracker_sheet_url`. On first visit a setup modal prompts the user to paste it. `DEFAULT_SHEET_URL` in `app.js` is intentionally left blank — it used to hold the owner's real spreadsheet link, but this repo is public, so every visitor (owner included, on any new browser/device) pastes their own sheet's link once; it's then remembered locally. **Never hardcode a real spreadsheet link back into this constant.** Pasting a URL with no extractable spreadsheet ID (e.g. an old-style "Publish to web" link, or a non-Sheets URL) is rejected with an inline error before any fetch is attempted.

**Sheet data is untrusted input.** Category/Description (and anything else read from the sheet) are rendered into `innerHTML` template strings all over the render functions, so anything derived from a row must go through `escapeHtml()` first — otherwise a description like `<img src=x onerror=...>` becomes real, executing HTML (stored XSS). Every existing call site already does this; if you add a new render path that interpolates a row's `category`/`description` (or anything else sourced from the CSV) into `innerHTML`, wrap it in `escapeHtml()` too.

### Fixed Expenses schedule model
Rather than logging a row every month, `Fixed Expenses` uses one row per "chapter" of a fixed expense's life: `Start Date` required, `End Date` blank while ongoing. A price change is modeled as ending the old row and starting a new one at the new amount — this also preserves price history for free, no separate mechanism needed.

A month's active fixed rows = `Start Date <= month` AND (`End Date` blank OR `End Date >= month`) — see `isFixedRowActiveInMonth()` / `getActiveFixedRows()` in app.js. This reconstructs accurate totals for **any** month, past or present, without monthly re-entry: switching the header's month selector to a past month correctly shows what was active back then, not today's state.

### CORS handling (`fetchCsvWithFallback()` in app.js)
Google Sheets redirects block direct browser fetches. Strategy, applied identically to both tab fetches:
1. Direct `fetch()` with 6 s timeout
2. If that fails, waterfall through three public CORS proxies (each with 7 s timeout):
   - `api.allorigins.win`
   - `corsproxy.io`
   - `api.codetabs.com`

Cache-busting `&t=Date.now()` is appended to every URL. If the Fixed Expenses fetch fails for any reason (tab doesn't exist yet, network issue), the Fixed tab shows a friendly "not available" prompt with setup instructions and a Retry button (`state.fixedLoadError`), rather than blocking the app — Variable Expenses loads and works independently.

---

## Categories
Both tabs share one `CATEGORY_COLORS` map/`--col-*` set in app.js/style.css, but use **separate taxonomies** — Variable Expenses' categories are validated by the Telegram bot (`CATEGORIES` array in `TelegramGAS.gs`) and must match exactly; Fixed Expenses' categories are free text, whatever's typed in the sheet's `Category` column. Adding a new category (either tab) requires updating **both**:
- `CATEGORY_COLORS` in `app.js`
- The corresponding CSS custom property (`--col-*`) in `style.css `:root``

An unrecognized category (typo, or a brand-new one not yet added here) falls back to a generic gray (`getCatColor()` in app.js) rather than erroring.

**Variable Expenses (11, bot-validated):**

| Category | Colour |
|---|---|
| Food | `#ff6b35` |
| Transport | `#00aaff` |
| Taxi | `#b06aff` |
| Groceries | `#00e5a0` |
| Entertainment | `#ff3dac` |
| Health | `#00c8ff` |
| Shopping | `#ffd000` |
| Travel | `#00f5d4` |
| Lifestyle | `#c084fc` |
| Gifts | `#ff4d6d` |
| Others | `#4a6880` |

**Fixed Expenses (free text, whatever's in the sheet):**

| Category | Colour |
|---|---|
| Insurance | `#22c55e` |
| Taxes | `#dc2626` |
| Membership | `#a3e635` |
| Family | `#818cf8` |
| Subscription | `#e879f9` |

---

## app.js architecture

### State object (single source of truth)
```js
const state = {
  allRows,       // all parsed Variable Expenses rows (sorted asc by date)
  selectedMonth, // 'YYYY-MM' string — shared by both tabs
  selectedDay,   // 'YYYY-MM-DD' string | null (calendar drill-down)
  sortCol,       // 'date' | 'amount' | 'category'
  sortDir,       // 'asc' | 'desc'
  currentPage,   // transaction table pagination
  lastFetched,   // Date | null
  charts: { donut, barMom, barFixed }, // Chart.js instances (null when not rendered)

  searchQuery, rangeMode, rangeStart, rangeEnd, rangePreset, // transaction search + custom date range (Variable tab only)

  activeTab,       // 'variable' | 'fixed'
  fixedSchedule,   // parsed Fixed Expenses rows: {category, description, amount, startDate, endDate|null}
  fixedLoadError,  // true if the Fixed Expenses tab fetch failed (missing tab, network, etc.)
};
```

### Data flow
```
loadData()
  └─> extractSpreadsheetId()  →  buildSheetTabUrl(id, 'Variable Expenses')
        └─> fetchCsvWithFallback()  →  parseCSV()  →  state.allRows
              └─> populateDateFilters()  →  state.selectedMonth
                    └─> renderAll()
                          ├─> computeMetrics()         — all derived numbers, month-only
                          ├─> computeViewMetrics()     — search/range-aware numbers
                          ├─> renderViewSections()     — summary cards, donut, category table, insights, txn table
                          ├─> renderMoMCard() / renderMoMBarChart() / renderCalendar()  — skipped while a custom range is active
                          └─> renderFixedTab()
                    └─> loadFixedData()  (fires after renderAll(), independently)
                          └─> buildSheetTabUrl(id, 'Fixed Expenses')  →  fetchCsvWithFallback()  →  parseFixedCSV()  →  state.fixedSchedule
                                └─> renderFixedTab()  — refreshes once Fixed data actually arrives
```

`renderAll()` is the Variable tab's re-render entry point (it also calls `renderFixedTab()` at the end, since Fixed's stats depend on `state.selectedMonth` too). It is called on:
- Initial data load
- Month filter change (also calls `closeDayDetail()`)
- Entering/leaving custom date-range mode
- Never called from sort/pagination/search — those call `renderTxnTable()` / `renderViewSections()` directly.

`switchTab('variable' | 'fixed')` just toggles which tab panel and switcher button are visible — it doesn't re-fetch or recompute anything.

### Key functions

| Function | Purpose |
|---|---|
| `computeMetrics()` | Derived values for the selected month only (totals, MoM delta, pace, busiest day, weekday split, etc.) — feeds the month-shaped sections that hide during custom range mode |
| `computeViewMetrics()` | Same shape of derived values, but sourced from `getFilteredRows()` (search + month/range aware) — feeds Summary cards, Donut, Category table, Txn table |
| `getFilteredRows()` | `getRangeRows()` or `getMonthRows()` depending on `state.rangeMode`, then applies `state.searchQuery` |
| `getMonthRows(month?)` | Filters `state.allRows` to selected (or given) month |
| `getYearMonths(year)` | Returns all 12 `'YYYY-MM'` keys (Jan–Dec) for `year` — the monthly bar charts' window |
| `populateDateFilters()` / `populateMonthOptionsForYear(year)` | Populate the Year `<select>` from years present in the data, then the Month `<select>` with Jan–Dec of whichever year is active |
| `getDailyTotals()` | Returns `{ totals: {day→amount}, byDay: {day→rows[]} }` for selected month |
| `getCategoryTotals(month?)` | Returns `{ category→amount }` map |
| `getDaysElapsed()` | Current month: today's date; past months: full month length |
| `renderCalendar()` | Builds the 7-col CSS grid calendar with heat-map cells |
| `openDayDetail(dateStr)` / `closeDayDetail()` | Day drill-down panel |
| `extractSpreadsheetId(url)` | Pulls the spreadsheet ID out of a pasted share link; `null` if not a valid Sheets URL |
| `buildSheetTabUrl(id, tabName)` | Builds the `gviz` CSV-by-name fetch URL for one tab |
| `fetchCsvWithFallback(url)` | Direct fetch + CORS-proxy waterfall, shared by both tab fetches |
| `isFixedRowActiveInMonth(row, monthKey)` / `getActiveFixedRows(monthKey)` | Effective-dated Start/End Date range check |
| `computeFixedMetrics(monthKey)` | Total / active count / discontinued count for the Fixed tab's summary cards, for any given month |
| `getEffectiveTheme()` / `toggleTheme()` | Resolves stored preference vs OS `prefers-color-scheme`; toggling persists to `localStorage` and re-renders charts with new colors |

### Chart.js usage
Charts are **destroyed then recreated** on every `renderAll()` call — this avoids canvas reuse errors. Always call `destroyChart(key)` before `new Chart(...)`.

**Gotcha:** never create a chart while its container is `display:none` (e.g. a background tab panel) — Chart.js can't reliably size/paint into a zero-size canvas, and it doesn't always repaint correctly even after the container becomes visible later. `renderFixedTab()` guards its two chart calls behind `state.activeTab === 'fixed'` for exactly this reason, and `switchTab()` re-runs `renderFixedTab()` right after unhiding the panel so the charts get created for the first time while genuinely visible.

**Monthly bar chart tooltips** (`renderMoMBarChart()` / `renderFixedBarChart()`) use a custom HTML tooltip instead of Chart.js's default canvas-rendered one — the default can't render per-line colored text, and these need a red/green MoM %+arrow alongside the total. `monthlyBarTooltipHandler(momData)` is a shared factory (`plugins.tooltip.enabled: false` + `external:` hook) that both charts pass their own precomputed `momData` (from `computeMoMForMonths()`) into; it renders into one shared `#chart-tooltip` div appended to `document.body`, styled in style.css's `.chart-tooltip*` rules. `computeMoMForMonths()` compares each bar's month against its preceding calendar month even when that month falls outside the visible window (e.g. January's bar compares against the prior December, which isn't itself one of the 12 bars shown).

Chart.js is loaded via CDN:
```html
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js"></script>
```

---

## style.css design system

### Theme
Dark futuristic / glassmorphism by default, with a light theme variant. Cards use `backdrop-filter: blur(20px)` with semi-transparent backgrounds. The page background has a faint dot-grid and a radial top glow.

Dark values live on the bare `:root` (default). Light overrides live in two places that must stay in sync — a `@media (prefers-color-scheme: light)` block (guarded by `:root:not([data-theme="dark"])`, so an explicit dark choice still wins) and a `:root[data-theme="light"]` block (explicit user choice via the header toggle, persisted to `localStorage` under `expense_tracker_theme`). An inline script in `index.html`'s `<head>` applies the stored `data-theme` attribute before first paint to avoid a flash. Chart.js colors (legend text, donut segment gaps, bar-chart grid lines) are read from CSS custom properties at render time via `cssVar()` in app.js, so they follow the active theme automatically.

### Key CSS custom properties
```css
--bg:            #060a14        /* page background */
--bg-card:       rgba(5,12,28,0.78)   /* glass card */
--bg-elevated:   rgba(8,18,42,0.88)   /* modals, selects */
--border:        rgba(100,160,200,0.1)
--border-mid:    rgba(100,160,200,0.2)
--border-bright: rgba(100,180,220,0.38)
--accent-cyan:   #46b8d4        /* primary accent */
--text-primary:  #e4eef7
--text-secondary:#8ab0cc
--text-muted:    #4a6a82
--chart-segment-gap, --chart-grid-line   /* Chart.js-only, read via cssVar() */
```
(Light theme redefines all of the above with contrast-checked values — see `:root[data-theme="light"]` in style.css.)

### Layout
- `.app-container` — flex column, max-width 1300px
- `.tab-switcher` — two `.tab-btn` pills, toggles `#tab-panel-variable` / `#tab-panel-fixed`
- `.summary-row` — `repeat(4,1fr)` grid → 2-col at 1100px; `.cols-3` modifier (Fixed tab) → `repeat(3,1fr)`, same breakpoint overrides
- `.two-col-row` — `1fr 1fr` → 1-col at 840px, or when `.is-range-mode` is active (custom date range)
- `.insights-strip` — `repeat(4,1fr)` → 2-col at 840px → 2-col at 600px; `.pace-hidden` modifier (range mode) → 3-col
- `.calendar-grid` — `repeat(7,1fr)` (fixed, matches days of week)

### Responsive breakpoints
| Breakpoint | Changes |
|---|---|
| `≤ 1100px` | Summary cards: 4→2 columns |
| `≤ 840px` | Two-col rows stack; chart height 280→240px; touch targets 44px |
| `≤ 600px` | Summary cards 2-col; header stacks; calendar cells compact; desc column hidden in txn table |
| `≤ 380px` | Summary cards go 1-col |

---

## Dashboard sections

**Header** (shared across both tabs) — app title, Year `<select>` + Month `<select>` (cascading: changing year repopulates the month list to Jan–Dec of that year and picks the most recent month with data), theme toggle, settings gear.

**Tab switcher** — `Variable Expenses` / `Fixed Expenses`, below the header.

### Variable Expenses tab
1. **Date range filter bar** — presets (7/30/90 days) + manual From/To, overrides the month filter when active; "Back to month view" restores it
2. **Search box** — live filters the transactions table by description or category
3. **Summary cards** — Total Spend, Avg Daily Spend, # Transactions, Top Category
4. **MoM delta card** — vs previous month (hidden during custom range mode)
5. **Row 2** — Donut chart (category breakdown) + Bar chart (Jan–Dec of the selected year) (bar chart hidden during range mode)
6. **Calendar** — full month grid with heat-map spend amounts; click day → detail panel (hidden during range mode)
7. **Day detail panel** — slides in below calendar; shows all transactions for selected day
8. **Category breakdown table** — Amount, Share %, # Txns per category
9. **Insights strip** — Spending pace (hidden during range mode), Biggest expense, Most expensive day, Weekday vs weekend
10. **Transactions table** — paginated (20/page), sortable by Date / Category / Amount

### Fixed Expenses tab
1. **Summary cards** — Total Fixed This Month, Active This Month, Discontinued (all scoped to the shared month selector, reconstructed historically via the Start/End Date schedule)
2. **Row 2** — Donut chart (category breakdown, active rows for the selected month) + Bar chart (Jan–Dec of the selected year)
3. **Fixed Expenses Schedule** — full ledger table (Description, Category, Amount, Start Date, End Date, Status), sortable on every column — not scoped to the selected month, always shows everything
4. **Empty/error state** (`#fixed-unavailable`) — shown instead of the above when the tab fetch fails; includes setup instructions and a Retry button

---

## Currency
All amounts formatted as SGD via:
```js
new Intl.NumberFormat('en-SG', { style: 'currency', currency: 'SGD', minimumFractionDigits: 2 })
```

---

## Favicon
`favicon.svg` — diamond shape with a centred `$` sign, cyan glow, dark rounded-rect background. Linked in `<head>` as both `rel="icon"` (SVG) and `rel="apple-touch-icon"`. Works at all sizes without a PNG fallback on modern browsers.

---

## GitHub Pages deployment
Push to `main` branch. Pages is served from repo root. No build step required — `index.html`, `style.css`, `app.js`, and `favicon.svg` are the deployed artefact. `TelegramGAS.gs` is gitignored and never deployed here.
