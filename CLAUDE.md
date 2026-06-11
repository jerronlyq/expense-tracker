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
├── index.html     — full page markup; all sections, modals, chart canvases
├── style.css      — design system, layout, dark futuristic theme
├── app.js         — all data fetching, parsing, state, and rendering logic
└── favicon.svg    — diamond + $ sign SVG icon
```

---

## Data source
**Google Sheets CSV URL** (public, published via File → Share → Publish to Web):
```
https://docs.google.com/spreadsheets/d/e/2PACX-1v.../pub?gid=0&single=true&output=csv
```

**CSV columns:** `Date`, `Username`, `Category`, `Description`, `Amount`

**Date formats accepted:** `YYYY-MM-DD` (primary), `DD/MM/YYYY` (fallback), or any string parseable by `new Date()`.

**Amount parsing:** strips any non-numeric characters (e.g. `S$12.50` → `12.50`) via `replace(/[^0-9.-]/g, '')`.

The URL is saved in `localStorage` under key `expense_tracker_sheet_url`. On first visit a setup modal prompts the user to paste their own URL. The default URL (the owner's sheet) is hardcoded as `DEFAULT_SHEET_URL` in `app.js` and pre-fills the setup input.

### CORS handling (`loadData` in app.js)
Google Sheets redirects block direct browser fetches. Strategy:
1. Direct `fetch()` with 6 s timeout
2. If that fails, waterfall through three public CORS proxies (each with 7 s timeout):
   - `api.allorigins.win`
   - `corsproxy.io`
   - `api.codetabs.com`

Cache-busting `&t=Date.now()` is appended to every URL.

---

## Categories
Exactly 11 categories. Adding a new one requires updating **both**:
- `CATEGORY_COLORS` in `app.js`
- The corresponding CSS custom property (`--col-*`) in `style.css `:root``

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

---

## app.js architecture

### State object (single source of truth)
```js
const state = {
  allRows,       // all parsed CSV rows (sorted asc by date)
  selectedMonth, // 'YYYY-MM' string
  selectedDay,   // 'YYYY-MM-DD' string | null (calendar drill-down)
  sortCol,       // 'date' | 'amount' | 'category'
  sortDir,       // 'asc' | 'desc'
  currentPage,   // transaction table pagination
  lastFetched,   // Date | null
  charts: { donut, barMom }, // Chart.js instances (null when not rendered)
};
```

### Data flow
```
loadData()
  └─> parseCSV()  →  state.allRows
        └─> populateMonthFilter()  →  state.selectedMonth
              └─> renderAll()
                    ├─> computeMetrics()         — all derived numbers
                    ├─> renderSummaryCards()
                    ├─> renderMoMCard()
                    ├─> renderDonutChart()        — Chart.js, destroys+recreates
                    ├─> renderMoMBarChart()       — Chart.js, destroys+recreates
                    ├─> renderCalendar()          — plain DOM, no Chart.js
                    ├─> renderCategoryTable()
                    ├─> renderInsights()
                    └─> renderTxnTable()          — paginated, sortable
```

`renderAll()` is the single re-render entry point. It is called on:
- Initial data load
- Month filter change (also calls `closeDayDetail()`)
- Never called from sort/pagination — those call `renderTxnTable()` directly.

### Key functions

| Function | Purpose |
|---|---|
| `computeMetrics()` | Returns all derived values for selected month (totals, MoM delta, pace, busiest day, weekday split, etc.) |
| `getMonthRows(month?)` | Filters `state.allRows` to selected (or given) month |
| `getLastNMonths(n)` | Returns array of N `'YYYY-MM'` keys ending at selected month |
| `getDailyTotals()` | Returns `{ totals: {day→amount}, byDay: {day→rows[]} }` for selected month |
| `getCategoryTotals(month?)` | Returns `{ category→amount }` map |
| `getDaysElapsed()` | Current month: today's date; past months: full month length |
| `renderCalendar()` | Builds the 7-col CSS grid calendar with heat-map cells |
| `openDayDetail(dateStr)` | Shows the day drill-down panel; toggles off if same date clicked |
| `closeDayDetail()` | Hides the panel, clears `state.selectedDay` |
| `fetchWithTimeout(url, ms)` | Single fetch with `AbortController` timeout |

### Chart.js usage
Charts are **destroyed then recreated** on every `renderAll()` call — this avoids canvas reuse errors. Always call `destroyChart(key)` before `new Chart(...)`.

Chart.js is loaded via CDN:
```html
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js"></script>
```

---

## style.css design system

### Theme
Dark futuristic / glassmorphism. Cards use `backdrop-filter: blur(20px)` with semi-transparent backgrounds. The page background has a faint dot-grid and a radial top glow.

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
```

### Layout
- `.app-container` — flex column, max-width 1300px
- `.summary-row` — `repeat(4,1fr)` grid → 2-col at 1100px
- `.two-col-row` — `1fr 1fr` → 1-col at 840px
- `.insights-strip` — `repeat(4,1fr)` → 2-col at 840px → 2-col at 600px
- `.calendar-grid` — `repeat(7,1fr)` (fixed, matches days of week)

### Responsive breakpoints
| Breakpoint | Changes |
|---|---|
| `≤ 1100px` | Summary cards: 4→2 columns |
| `≤ 840px` | Two-col rows stack; chart height 280→240px; touch targets 44px |
| `≤ 600px` | Summary cards 2-col; header stacks; calendar cells compact; desc column hidden in txn table |
| `≤ 380px` | Summary cards go 1-col |

---

## Dashboard sections (top → bottom)

1. **Header** — app title + month/year `<select>` + settings gear (opens URL modal)
2. **Summary cards** — Total Spend, Avg Daily Spend, # Transactions, Top Category
3. **MoM delta card** — vs previous month (S$ + %, red if up, green if down)
4. **Row 2** — Donut chart (category breakdown) + Bar chart (last 6 months)
5. **Calendar** — full month grid with heat-map spend amounts; click day → detail panel
6. **Day detail panel** — slides in below calendar; shows all transactions for selected day
7. **Category breakdown table** — Amount, Share %, # Txns per category
8. **Insights strip** — Spending pace, Biggest expense, Most expensive day, Weekday vs weekend
9. **Transactions table** — paginated (20/page), sortable by Date / Category / Amount

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
Push to `main` branch. Pages is served from repo root. No build step required — all three source files are the deployed artefact.
