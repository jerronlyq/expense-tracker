/* ── Config ────────────────────────────────────────────────────────────────── */
// No hardcoded default here on purpose — a real spreadsheet ID used to live in this
// constant, which is a real link to someone's private financial data and this repo
// is public. Every visitor (including the owner, on a fresh browser/device) pastes
// their own sheet's share link into the setup modal; it's then remembered locally
// via localStorage (STORAGE_KEY), never committed anywhere.
const DEFAULT_SHEET_URL = '';

const VARIABLE_TAB_NAME = 'Variable Expenses';
const FIXED_TAB_NAME = 'Fixed Expenses';

const STORAGE_KEY = 'expense_tracker_sheet_url';
const THEME_STORAGE_KEY = 'expense_tracker_theme';
const ROWS_PER_PAGE = 20;

const CATEGORY_COLORS = {
  // Variable Expenses categories
  'Food':          '#ff6b35',
  'Transport':     '#00aaff',
  'Taxi':          '#b06aff',
  'Groceries':     '#00e5a0',
  'Entertainment': '#ff3dac',
  'Health':        '#00c8ff',
  'Shopping':      '#ffd000',
  'Travel':        '#00f5d4',
  'Lifestyle':     '#c084fc',
  'Gifts':         '#ff4d6d',
  'Others':        '#4a6880',

  // Fixed Expenses categories
  'Insurance':     '#22c55e',
  'Taxes':         '#dc2626',
  'Membership':    '#a3e635',
  'Family':        '#818cf8',
  'Subscription':  '#e879f9',
};

const CORS_PROXIES = [
  url => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  url => `https://corsproxy.io/?${encodeURIComponent(url)}`,
  url => `https://api.codetabs.com/v1/proxy/?quest=${encodeURIComponent(url)}`,
];

/* ── State ─────────────────────────────────────────────────────────────────── */
const state = {
  allRows:       [],
  selectedMonth: null,
  selectedDay:   null,
  sortCol:       'date',
  sortDir:       'desc',
  currentPage:   1,
  lastFetched:   null,
  charts: {
    donut:  null,
    barMom: null,
    barFixed: null,
    donutFixed: null,
  },

  searchQuery: '',
  rangeMode:   false,
  rangeStart:  null,
  rangeEnd:    null,
  rangePreset: null,

  activeTab:      'variable',
  fixedSchedule:  [],
  fixedLoadError: false,
  fixedSortCol:   'startDate',
  fixedSortDir:   'desc',
};

/* ── Utilities ─────────────────────────────────────────────────────────────── */
const fmt = v =>
  new Intl.NumberFormat('en-SG', {
    style: 'currency', currency: 'SGD', minimumFractionDigits: 2,
  }).format(v);

// Category/Description (and anything else read from the sheet) are untrusted —
// they end up interpolated into innerHTML template strings all over the render
// functions below, so every such value must be escaped here first to prevent
// stored XSS (e.g. a description of `<img src=x onerror=...>` in the sheet).
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const toYYYYMM = d =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;

function formatMonthLabel(yyyymm) {
  const [y, m] = yyyymm.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleString('default', { month: 'long', year: 'numeric' });
}

function formatMonthShort(yyyymm) {
  const [, m] = yyyymm.split('-').map(Number);
  return MONTH_NAMES_SHORT[m - 1];
}

function formatDisplayDate(d) {
  return d.toLocaleDateString('en-SG', { day: '2-digit', month: 'short', year: 'numeric' });
}

function diffDaysInclusive(start, end) {
  return Math.round((end - start) / 86400000) + 1;
}

function formatRangeLabel(start, end) {
  return `${formatDisplayDate(start)} – ${formatDisplayDate(end)}`;
}

function toDateInputValue(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function getCatColor(cat) {
  return CATEGORY_COLORS[cat] || '#94a3b8';
}

/* ── Theme ─────────────────────────────────────────────────────────────────── */
function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function getEffectiveTheme() {
  const stored = localStorage.getItem(THEME_STORAGE_KEY);
  if (stored === 'light' || stored === 'dark') return stored;
  return (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches)
    ? 'light' : 'dark';
}

function applyChartDefaults() {
  if (typeof Chart === 'undefined') return;
  Chart.defaults.font.family = "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
  Chart.defaults.color = cssVar('--text-secondary');
}

function updateThemeToggleIcon() {
  const isLight = getEffectiveTheme() === 'light';
  document.getElementById('theme-icon-sun').classList.toggle('hidden', isLight);
  document.getElementById('theme-icon-moon').classList.toggle('hidden', !isLight);
}

function toggleTheme() {
  const next = getEffectiveTheme() === 'light' ? 'dark' : 'light';
  localStorage.setItem(THEME_STORAGE_KEY, next);
  document.documentElement.setAttribute('data-theme', next);
  updateThemeToggleIcon();
  applyChartDefaults();
  if (state.allRows.length) renderAll();
}

function getDaysElapsed() {
  const [y, m] = state.selectedMonth.split('-').map(Number);
  const now = new Date();
  const isCurrentMonth = now.getFullYear() === y && (now.getMonth() + 1) === m;
  if (isCurrentMonth) return now.getDate();
  return new Date(y, m, 0).getDate();
}

function getDaysInMonth() {
  const [y, m] = state.selectedMonth.split('-').map(Number);
  return new Date(y, m, 0).getDate();
}

function getPrevMonthKey() {
  const [y, m] = state.selectedMonth.split('-').map(Number);
  return toYYYYMM(new Date(y, m - 2, 1));
}

/* ── CSV Parsing ───────────────────────────────────────────────────────────── */
function splitCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else { inQuotes = !inQuotes; }
    } else if (ch === ',' && !inQuotes) {
      result.push(current); current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

function parseFlexibleDate(str) {
  str = str.trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(str)) return new Date(str + 'T00:00:00');
  if (/^\d{2}\/\d{2}\/\d{4}/.test(str)) {
    const [d, m, y] = str.split('/');
    return new Date(`${y}-${m}-${d}T00:00:00`);
  }
  const d = new Date(str);
  return isNaN(d) ? null : d;
}

function parseCSV(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').filter(Boolean);
  if (lines.length < 2) return [];

  const headers = splitCSVLine(lines[0]).map(h => h.trim().toLowerCase());
  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    const vals = splitCSVLine(lines[i]);
    const obj = {};
    headers.forEach((h, idx) => { obj[h] = (vals[idx] || '').trim(); });

    const amount = parseFloat((obj.amount || '').replace(/[^0-9.-]/g, ''));
    if (!obj.date || !amount || isNaN(amount) || amount <= 0) continue;

    const dateObj = parseFlexibleDate(obj.date);
    if (!dateObj || isNaN(dateObj)) continue;

    rows.push({
      date:        dateObj,
      dateStr:     obj.date,
      username:    obj.username || '',
      category:    obj.category || 'Others',
      description: obj.description || '',
      amount,
    });
  }

  return rows.sort((a, b) => a.date - b.date);
}

function parseFixedCSV(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').filter(Boolean);
  if (lines.length < 2) return [];

  const headers = splitCSVLine(lines[0]).map(h => h.trim().toLowerCase());
  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    const vals = splitCSVLine(lines[i]);
    const obj = {};
    headers.forEach((h, idx) => { obj[h] = (vals[idx] || '').trim(); });

    const amount = parseFloat((obj.amount || '').replace(/[^0-9.-]/g, ''));
    const startRaw = obj['start date'] || '';
    if (!startRaw || !amount || isNaN(amount) || amount <= 0) continue;

    const startDate = parseFlexibleDate(startRaw);
    if (!startDate || isNaN(startDate)) continue;

    const endRaw = obj['end date'] || '';
    const parsedEnd = endRaw ? parseFlexibleDate(endRaw) : null;
    const endDate = (parsedEnd && !isNaN(parsedEnd)) ? parsedEnd : null;

    rows.push({
      category:    obj.category || 'Others',
      description: obj.description || '',
      amount,
      startDate,
      endDate,
    });
  }

  return rows.sort((a, b) => b.startDate - a.startDate);
}

function isFixedRowActiveInMonth(row, monthKey) {
  if (toYYYYMM(row.startDate) > monthKey) return false;
  if (row.endDate && toYYYYMM(row.endDate) < monthKey) return false;
  return true;
}

function getActiveFixedRows(monthKey) {
  return state.fixedSchedule.filter(r => isFixedRowActiveInMonth(r, monthKey));
}

function computeFixedMetrics(monthKey) {
  const activeRows = getActiveFixedRows(monthKey);
  const total = activeRows.reduce((s, r) => s + r.amount, 0);
  const discontinuedCount = state.fixedSchedule.filter(r =>
    r.endDate && toYYYYMM(r.endDate) < monthKey
  ).length;

  const catTotals = {};
  activeRows.forEach(r => { catTotals[r.category] = (catTotals[r.category] || 0) + r.amount; });
  const catSorted = Object.entries(catTotals).sort((a, b) => b[1] - a[1]);

  return { total, activeCount: activeRows.length, discontinuedCount, activeRows, catSorted };
}

/* ── Fetch with CORS proxy waterfall ──────────────────────────────────────── */
async function fetchWithTimeout(url, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    return res.ok ? res : null;
  } catch {
    clearTimeout(timer);
    return null;
  }
}

function extractSpreadsheetId(url) {
  const m = (url || '').match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]{20,})/);
  return m ? m[1] : null;
}

function buildSheetTabUrl(spreadsheetId, tabName) {
  return `https://docs.google.com/spreadsheets/d/${spreadsheetId}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(tabName)}`;
}

async function fetchCsvWithFallback(url) {
  const bustedUrl = url + '&t=' + Date.now();
  let res = await fetchWithTimeout(bustedUrl, 6000);
  if (!res) {
    for (const proxyFn of CORS_PROXIES) {
      res = await fetchWithTimeout(proxyFn(bustedUrl), 7000);
      if (res) break;
    }
  }
  if (!res) return null;
  try { return await res.text(); } catch { return null; }
}

async function loadData() {
  const sheetUrl = localStorage.getItem(STORAGE_KEY) || DEFAULT_SHEET_URL;
  const spreadsheetId = extractSpreadsheetId(sheetUrl);

  showLoader(true);
  hideError();

  if (!spreadsheetId) {
    showLoader(false);
    showError("Could not find a spreadsheet ID in that link. Paste your Google Sheet's normal share link (e.g. https://docs.google.com/spreadsheets/d/XXXXX/edit).");
    return;
  }

  const csvText = await fetchCsvWithFallback(buildSheetTabUrl(spreadsheetId, VARIABLE_TAB_NAME));
  showLoader(false);

  if (csvText === null) {
    showError('Could not load expense data. Check your sheet link, sharing settings, and try again.');
    return;
  }

  state.allRows = parseCSV(csvText);
  state.lastFetched = new Date();

  if (state.allRows.length === 0) {
    showError(`No valid rows found. Make sure your sheet has a tab named "${VARIABLE_TAB_NAME}" with columns: Date, Category, Description, Amount.`);
    return;
  }

  document.getElementById('data-freshness').textContent =
    'Updated ' + state.lastFetched.toLocaleTimeString('en-SG', { hour: '2-digit', minute: '2-digit' });

  populateDateFilters();
  renderAll();

  loadFixedData();
}

async function loadFixedData() {
  const sheetUrl = localStorage.getItem(STORAGE_KEY) || DEFAULT_SHEET_URL;
  const spreadsheetId = extractSpreadsheetId(sheetUrl);

  if (!spreadsheetId) {
    state.fixedSchedule = [];
    state.fixedLoadError = true;
    renderFixedTab();
    return;
  }

  const csvText = await fetchCsvWithFallback(buildSheetTabUrl(spreadsheetId, FIXED_TAB_NAME));

  if (csvText === null) {
    state.fixedSchedule = [];
    state.fixedLoadError = true;
    renderFixedTab();
    return;
  }

  state.fixedSchedule = parseFixedCSV(csvText);
  state.fixedLoadError = false;
  renderFixedTab();
}

/* ── Year / Month Filter ───────────────────────────────────────────────────── */
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const MONTH_NAMES_SHORT = MONTH_NAMES.map(n => n.slice(0, 3));

// Populates the Year dropdown from whatever years exist in the data, picks a
// year (preserving the previous selection if still valid), then populates the
// Month dropdown for that year. Called once after a fresh data load.
function populateDateFilters() {
  const yearSel = document.getElementById('year-filter');
  const years = [...new Set(state.allRows.map(r => r.date.getFullYear()))].sort((a, b) => b - a);

  yearSel.innerHTML = '';
  years.forEach(y => {
    const opt = document.createElement('option');
    opt.value = y;
    opt.textContent = y;
    yearSel.appendChild(opt);
  });

  const prevYear = state.selectedMonth ? Number(state.selectedMonth.split('-')[0]) : null;
  const year = (prevYear && years.includes(prevYear)) ? prevYear : (years[0] ?? new Date().getFullYear());
  yearSel.value = year;

  populateMonthOptionsForYear(year);
}

// Populates the Month dropdown with all 12 months of `year` (Jan–Dec, so the
// full year is always navigable even where a given month has no data — those
// months just render as an empty state, same as any other zero-transaction
// month). Preserves the previously selected month if it falls within this
// year, otherwise defaults to the most recent month in the year that has
// data, falling back to December.
function populateMonthOptionsForYear(year) {
  const monthSel = document.getElementById('month-filter');
  monthSel.innerHTML = '';
  for (let m = 1; m <= 12; m++) {
    const key = `${year}-${String(m).padStart(2, '0')}`;
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = MONTH_NAMES_SHORT[m - 1];
    opt.title = MONTH_NAMES[m - 1];
    monthSel.appendChild(opt);
  }

  const monthsWithData = [...new Set(
    state.allRows.filter(r => r.date.getFullYear() === year).map(r => toYYYYMM(r.date))
  )].sort().reverse();

  if (state.selectedMonth && state.selectedMonth.startsWith(`${year}-`)) {
    monthSel.value = state.selectedMonth;
  } else {
    monthSel.value = monthsWithData[0] || `${year}-12`;
  }
  state.selectedMonth = monthSel.value;
}

/* ── Derived Data Helpers ─────────────────────────────────────────────────── */
function getMonthRows(month) {
  const key = month || state.selectedMonth;
  return state.allRows.filter(r => toYYYYMM(r.date) === key);
}

function getCategoryTotals(month) {
  const totals = {};
  getMonthRows(month).forEach(r => {
    totals[r.category] = (totals[r.category] || 0) + r.amount;
  });
  return totals;
}

// All 12 months (Jan–Dec) of `year`, for the "full calendar year" bar charts.
function getYearMonths(year) {
  const months = [];
  for (let m = 1; m <= 12; m++) months.push(`${year}-${String(m).padStart(2, '0')}`);
  return months;
}

// For each month in `months`, compares its total (via getTotalForMonth) against the
// preceding calendar month's total — even if that preceding month falls outside
// `months` itself (e.g. the oldest bar in a 6-month window). Returns null per-entry
// when there's no prior data to compare against.
function computeMoMForMonths(months, getTotalForMonth) {
  return months.map(mo => {
    const [y, m] = mo.split('-').map(Number);
    const prevKey = toYYYYMM(new Date(y, m - 2, 1));
    const total = getTotalForMonth(mo);
    const prevTotal = getTotalForMonth(prevKey);
    if (prevTotal <= 0) return null;
    const delta = total - prevTotal;
    return { delta, pct: (delta / prevTotal) * 100 };
  });
}

function getDailyTotals() {
  const totals = {};
  const byDay = {};
  getMonthRows().forEach(r => {
    const d = r.date.getDate();
    totals[d] = (totals[d] || 0) + r.amount;
    if (!byDay[d]) byDay[d] = [];
    byDay[d].push(r);
  });
  return { totals, byDay };
}

function getRangeRows() {
  if (!state.rangeStart || !state.rangeEnd) return [];
  return state.allRows.filter(r => r.date >= state.rangeStart && r.date <= state.rangeEnd);
}

function getFilteredRows() {
  let rows = state.rangeMode ? getRangeRows() : getMonthRows();
  const q = state.searchQuery.trim().toLowerCase();
  if (q) {
    rows = rows.filter(r =>
      r.description.toLowerCase().includes(q) || r.category.toLowerCase().includes(q)
    );
  }
  return rows;
}

/* ── Metrics Computation ──────────────────────────────────────────────────── */
function computeMetrics() {
  const rows = getMonthRows();
  const total = rows.reduce((s, r) => s + r.amount, 0);
  const daysElapsed = getDaysElapsed();
  const daysInMonth = getDaysInMonth();
  const avgDaily = daysElapsed > 0 ? total / daysElapsed : 0;
  const pace = avgDaily * daysInMonth;

  // Category totals (sorted)
  const catTotals = getCategoryTotals();
  const catSorted = Object.entries(catTotals).sort((a, b) => b[1] - a[1]);
  const topCat = catSorted[0]?.[0] || '—';
  const topCatAmt = catSorted[0]?.[1] || 0;

  // MoM
  const prevKey = getPrevMonthKey();
  const prevRows = getMonthRows(prevKey);
  const prevTotal = prevRows.reduce((s, r) => s + r.amount, 0);
  const momDelta = prevTotal > 0 ? total - prevTotal : null;
  const momPct = prevTotal > 0 ? ((total - prevTotal) / prevTotal) * 100 : null;

  // Biggest single expense
  const biggest = [...rows].sort((a, b) => b.amount - a.amount)[0] || null;

  // Most expensive day
  const dailyMap = {};
  rows.forEach(r => {
    const k = r.dateStr;
    dailyMap[k] = (dailyMap[k] || 0) + r.amount;
  });
  const busiestEntry = Object.entries(dailyMap).sort((a, b) => b[1] - a[1])[0];
  const busiestDay = busiestEntry?.[0] || null;
  const busiestAmt = busiestEntry?.[1] || 0;

  // Weekday vs weekend
  let weekdayTotal = 0, weekendTotal = 0;
  rows.forEach(r => {
    const dow = r.date.getDay();
    if (dow === 0 || dow === 6) weekendTotal += r.amount;
    else weekdayTotal += r.amount;
  });
  const weekdayPct = total > 0 ? Math.round(weekdayTotal / total * 100) : 0;
  const weekendPct = total > 0 ? Math.round(weekendTotal / total * 100) : 0;

  return {
    total, avgDaily, pace, txnCount: rows.length,
    topCat, topCatAmt,
    catTotals, catSorted,
    momDelta, momPct, prevTotal,
    biggest,
    busiestDay, busiestAmt,
    weekdayPct, weekendPct,
    daysElapsed, daysInMonth,
  };
}

/* ── View Metrics (search + date-range aware) ─────────────────────────────── */
function computeViewMetrics() {
  const rows = getFilteredRows();
  const total = rows.reduce((s, r) => s + r.amount, 0);

  const catTotals = {};
  rows.forEach(r => { catTotals[r.category] = (catTotals[r.category] || 0) + r.amount; });
  const catSorted = Object.entries(catTotals).sort((a, b) => b[1] - a[1]);
  const topCat = catSorted[0]?.[0] || '—';
  const topCatAmt = catSorted[0]?.[1] || 0;

  const biggest = [...rows].sort((a, b) => b.amount - a.amount)[0] || null;

  const dailyMap = {};
  rows.forEach(r => { dailyMap[r.dateStr] = (dailyMap[r.dateStr] || 0) + r.amount; });
  const busiestEntry = Object.entries(dailyMap).sort((a, b) => b[1] - a[1])[0];
  const busiestDay = busiestEntry?.[0] || null;
  const busiestAmt = busiestEntry?.[1] || 0;

  let weekdayTotal = 0, weekendTotal = 0;
  rows.forEach(r => {
    const dow = r.date.getDay();
    if (dow === 0 || dow === 6) weekendTotal += r.amount;
    else weekdayTotal += r.amount;
  });
  const weekdayPct = total > 0 ? Math.round(weekdayTotal / total * 100) : 0;
  const weekendPct = total > 0 ? Math.round(weekendTotal / total * 100) : 0;

  const daysInView = state.rangeMode ? diffDaysInclusive(state.rangeStart, state.rangeEnd) : getDaysElapsed();
  const avgDaily = daysInView > 0 ? total / daysInView : 0;

  return {
    rows, total, avgDaily, daysInView, txnCount: rows.length,
    topCat, topCatAmt, catTotals, catSorted,
    biggest, busiestDay, busiestAmt, weekdayPct, weekendPct,
  };
}

/* ── Render: Summary Cards ────────────────────────────────────────────────── */
function renderSummaryCards(vm) {
  document.getElementById('val-total').textContent = fmt(vm.total);
  document.getElementById('sub-total').textContent = state.rangeMode
    ? formatRangeLabel(state.rangeStart, state.rangeEnd)
    : formatMonthLabel(state.selectedMonth);

  document.getElementById('val-avg-daily').textContent = fmt(vm.avgDaily);
  document.getElementById('sub-avg-daily').textContent =
    `Over ${vm.daysInView} day${vm.daysInView !== 1 ? 's' : ''}`;

  document.getElementById('val-txn-count').textContent = vm.txnCount;
  document.getElementById('sub-txn-count').textContent = 'transactions recorded';

  document.getElementById('val-top-cat').textContent = vm.topCat;
  document.getElementById('sub-top-cat').textContent =
    vm.topCatAmt > 0 ? fmt(vm.topCatAmt) + ' spent' : '';
}

/* ── Render: MoM Card ─────────────────────────────────────────────────────── */
function renderMoMCard(m) {
  const deltaEl = document.getElementById('mom-delta');
  const pctEl   = document.getElementById('mom-pct');
  const detailEl = document.getElementById('mom-detail');

  deltaEl.className = 'mom-delta';

  if (m.momDelta === null) {
    deltaEl.textContent = 'No prior data';
    deltaEl.classList.add('neutral');
    pctEl.textContent = '';
    detailEl.textContent = '';
    return;
  }

  const sign = m.momDelta >= 0 ? '+' : '';
  deltaEl.textContent = sign + fmt(m.momDelta);
  deltaEl.classList.add(m.momDelta >= 0 ? 'positive' : 'negative');
  pctEl.textContent = `(${sign}${m.momPct.toFixed(1)}%)`;
  detailEl.textContent = `Last month: ${fmt(m.prevTotal)}`;
}

/* ── Render: Charts ───────────────────────────────────────────────────────── */
function destroyChart(key) {
  if (state.charts[key]) { state.charts[key].destroy(); state.charts[key] = null; }
}

// Shared custom tooltip for the monthly bar charts — Chart.js's default canvas
// tooltip can't render per-line colored text, so this renders an HTML tooltip
// showing the total plus a colored MoM %/amount with an up/down arrow.
// `momData` is a per-bar array from computeMoMForMonths(), parallel to the chart's labels.
function monthlyBarTooltipHandler(momData) {
  return (context) => {
    const { chart, tooltip } = context;
    let el = document.getElementById('chart-tooltip');
    if (!el) {
      el = document.createElement('div');
      el.id = 'chart-tooltip';
      el.className = 'chart-tooltip';
      document.body.appendChild(el);
    }

    if (tooltip.opacity === 0 || !tooltip.dataPoints || !tooltip.dataPoints.length) {
      el.style.opacity = 0;
      return;
    }

    const dp = tooltip.dataPoints[0];
    const mom = momData[dp.dataIndex];

    let html = `<div class="chart-tooltip-total">${fmt(dp.raw)}</div>`;
    if (mom) {
      const isUp = mom.delta >= 0;
      const arrow = isUp ? '↑' : '↓';
      const sign = isUp ? '+' : '';
      const cls = isUp ? 'up' : 'down';
      html += `<div class="chart-tooltip-mom chart-tooltip-mom--${cls}">${arrow} ${sign}${fmt(mom.delta)} (${sign}${mom.pct.toFixed(1)}%) vs last month</div>`;
    } else {
      html += `<div class="chart-tooltip-mom chart-tooltip-mom--neutral">No prior data</div>`;
    }
    el.innerHTML = html;

    const canvasRect = chart.canvas.getBoundingClientRect();
    el.style.opacity = 1;
    el.style.left = (canvasRect.left + window.pageXOffset + tooltip.caretX) + 'px';
    el.style.top = (canvasRect.top + window.pageYOffset + tooltip.caretY) + 'px';
  };
}

function renderDonutChart(vm) {
  destroyChart('donut');
  if (!vm.catSorted.length) return;

  const labels = vm.catSorted.map(([k]) => k);
  const values = vm.catSorted.map(([, v]) => v);
  const total  = vm.total;
  const colors = labels.map(getCatColor);

  state.charts.donut = new Chart(
    document.getElementById('chart-donut').getContext('2d'), {
      type: 'doughnut',
      data: {
        labels,
        datasets: [{
          data: values,
          backgroundColor: colors,
          borderWidth: 2,
          borderColor: cssVar('--chart-segment-gap'),
          hoverOffset: 6,
        }],
      },
      options: {
        cutout: '70%',
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            position: 'bottom',
            labels: { padding: 14, usePointStyle: true, pointStyleWidth: 8, font: { size: 12 } },
          },
          tooltip: {
            callbacks: {
              label: ctx => {
                const pct = total > 0 ? (ctx.raw / total * 100).toFixed(1) : 0;
                return ` ${ctx.label}: ${fmt(ctx.raw)} (${pct}%)`;
              },
            },
          },
        },
      },
    }
  );
}

function renderMoMBarChart() {
  destroyChart('barMom');
  const year = Number(state.selectedMonth.split('-')[0]);
  document.getElementById('heading-bar-mom').textContent = `Monthly Overview — ${year}`;
  const months = getYearMonths(year);
  const labels = months.map(formatMonthShort);
  const getTotalForMonth = mo =>
    state.allRows.filter(r => toYYYYMM(r.date) === mo).reduce((s, r) => s + r.amount, 0);
  const totals = months.map(getTotalForMonth);
  const momData = computeMoMForMonths(months, getTotalForMonth);
  const colors = months.map(mo =>
    mo === state.selectedMonth ? 'rgba(70,184,212,0.6)' : 'rgba(70,184,212,0.15)'
  );
  const borderColors = months.map(mo =>
    mo === state.selectedMonth ? 'rgba(70,184,212,0.9)' : 'rgba(70,184,212,0.35)'
  );

  state.charts.barMom = new Chart(
    document.getElementById('chart-bar-mom').getContext('2d'), {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          data: totals,
          backgroundColor: colors,
          borderColor: borderColors,
          borderWidth: 1.5,
          borderRadius: 6,
          borderSkipped: false,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            enabled: false,
            external: monthlyBarTooltipHandler(momData),
          },
        },
        scales: {
          x: { grid: { display: false }, ticks: { font: { size: 11 } } },
          y: {
            grid: { color: cssVar('--chart-grid-line') },
            ticks: {
              font: { size: 11 },
              callback: v => `S$${v >= 1000 ? (v / 1000).toFixed(1) + 'k' : v}`,
            },
          },
        },
      },
    }
  );
}

/* ── Render: Calendar ─────────────────────────────────────────────────────── */
const DOW_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function renderCalendar() {
  const grid = document.getElementById('calendar-grid');
  grid.innerHTML = '';

  if (!state.selectedMonth) return;

  const [y, m] = state.selectedMonth.split('-').map(Number);
  const daysInMonth = new Date(y, m, 0).getDate();
  const firstDow = new Date(y, m - 1, 1).getDay(); // 0 = Sunday

  const { totals: dailyTotals, byDay } = getDailyTotals();

  // Heat map scale
  const spendValues = Object.values(dailyTotals);
  const maxSpend = spendValues.length ? Math.max(...spendValues) : 1;

  // Today
  const now = new Date();
  const isCurrentMonth = now.getFullYear() === y && (now.getMonth() + 1) === m;
  const todayNum = isCurrentMonth ? now.getDate() : -1;

  // Render DOW header row (always 7 cells)
  DOW_LABELS.forEach(label => {
    const el = document.createElement('div');
    el.className = 'cal-dow';
    el.textContent = label;
    grid.appendChild(el);
  });

  // Leading empty cells
  for (let i = 0; i < firstDow; i++) {
    const el = document.createElement('div');
    el.className = 'cal-cell cal-cell--empty';
    grid.appendChild(el);
  }

  // Day cells
  for (let day = 1; day <= daysInMonth; day++) {
    const spend = dailyTotals[day] || 0;
    const dateStr = `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

    const cell = document.createElement('div');
    const classes = ['cal-cell'];

    if (spend > 0) {
      classes.push('cal-cell--has-spend');
      const ratio = spend / maxSpend;
      if (ratio < 0.25)      classes.push('cal-cell--heat-low');
      else if (ratio < 0.5)  classes.push('cal-cell--heat-medium');
      else if (ratio < 0.75) classes.push('cal-cell--heat-high');
      else                   classes.push('cal-cell--heat-max');
    }
    if (day === todayNum) classes.push('cal-cell--today');
    if (state.selectedDay === dateStr) classes.push('cal-cell--selected');

    cell.className = classes.join(' ');
    cell.dataset.date = dateStr;

    // Date number
    const numEl = document.createElement('span');
    numEl.className = 'cal-date-num';
    numEl.textContent = day;
    cell.appendChild(numEl);

    if (spend > 0) {
      // Amount
      const amtEl = document.createElement('span');
      amtEl.className = 'cal-amount';
      amtEl.textContent = fmt(spend);
      cell.appendChild(amtEl);

      // Category dots
      const cats = [...new Set((byDay[day] || []).map(r => r.category))];
      if (cats.length) {
        const dotsEl = document.createElement('div');
        dotsEl.className = 'cal-cat-dots';
        cats.slice(0, 6).forEach(cat => {
          const dot = document.createElement('span');
          dot.className = 'cal-cat-dot';
          dot.style.background = getCatColor(cat);
          dot.title = cat;
          dotsEl.appendChild(dot);
        });
        cell.appendChild(dotsEl);
      }

      cell.addEventListener('click', () => openDayDetail(dateStr));
    }

    grid.appendChild(cell);
  }
}

function openDayDetail(dateStr) {
  // Toggle off if same date clicked again
  if (state.selectedDay === dateStr) {
    closeDayDetail();
    return;
  }

  state.selectedDay = dateStr;

  // Update selected state on cells
  document.querySelectorAll('.cal-cell').forEach(c => c.classList.remove('cal-cell--selected'));
  const target = document.querySelector(`.cal-cell[data-date="${dateStr}"]`);
  if (target) target.classList.add('cal-cell--selected');

  // Gather rows for this day
  const dayRows = state.allRows
    .filter(r => {
      const d = r.date;
      return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}` === dateStr;
    })
    .sort((a, b) => b.amount - a.amount);

  const total = dayRows.reduce((s, r) => s + r.amount, 0);

  // Header
  const dateObj = new Date(dateStr + 'T00:00:00');
  document.getElementById('dd-date').textContent =
    dateObj.toLocaleDateString('en-SG', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  document.getElementById('dd-total').textContent =
    `${fmt(total)} total · ${dayRows.length} transaction${dayRows.length !== 1 ? 's' : ''}`;

  // Rows
  const tbody = document.getElementById('dd-tbody');
  tbody.innerHTML = '';
  dayRows.forEach(r => {
    const color = getCatColor(r.category);
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><span class="cat-badge" style="--cat-color:${color}">${escapeHtml(r.category)}</span></td>
      <td style="color:var(--text-secondary)">${escapeHtml(r.description) || '—'}</td>
      <td class="text-right amount-cell">${fmt(r.amount)}</td>
    `;
    tbody.appendChild(tr);
  });

  const panel = document.getElementById('day-detail-panel');
  panel.classList.remove('hidden');
  // Smooth scroll the panel into view on mobile
  setTimeout(() => panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 50);
}

function closeDayDetail() {
  state.selectedDay = null;
  document.querySelectorAll('.cal-cell').forEach(c => c.classList.remove('cal-cell--selected'));
  document.getElementById('day-detail-panel').classList.add('hidden');
}

/* ── Custom Date Range Mode ───────────────────────────────────────────────── */
function activateRangeMode(start, end, presetKey) {
  state.rangeMode = true;
  state.rangeStart = start;
  state.rangeEnd = end;
  state.rangePreset = presetKey;
  state.currentPage = 1;
  closeDayDetail();
  syncRangeControlsUI();
  renderAll();
}

function deactivateRangeMode() {
  state.rangeMode = false;
  state.rangePreset = null;
  state.currentPage = 1;
  syncRangeControlsUI();
  renderAll();
}

function syncRangeControlsUI() {
  document.querySelectorAll('#range-presets .chip-btn').forEach(btn => {
    btn.classList.toggle('active', state.rangeMode && btn.dataset.preset === state.rangePreset);
  });
  document.getElementById('range-clear-btn').classList.toggle('hidden', !state.rangeMode);
  document.getElementById('month-filter').disabled = state.rangeMode;
  document.getElementById('year-filter').disabled = state.rangeMode;
  document.getElementById('date-filter-bar').classList.toggle('is-active', state.rangeMode);
  if (state.rangeStart) document.getElementById('range-start').value = toDateInputValue(state.rangeStart);
  if (state.rangeEnd)   document.getElementById('range-end').value   = toDateInputValue(state.rangeEnd);
}

function updateRangeModeVisibility() {
  const showMonthSections = !state.rangeMode;
  document.getElementById('card-mom').classList.toggle('hidden', !showMonthSections);
  document.querySelector('.two-col-row').classList.toggle('is-range-mode', !showMonthSections);
  document.getElementById('calendar-card').classList.toggle('hidden', !showMonthSections);
  document.getElementById('insight-pace').classList.toggle('hidden', !showMonthSections);
  document.getElementById('insights-strip').classList.toggle('pace-hidden', !showMonthSections);
}

/* ── Render: Category Table ───────────────────────────────────────────────── */
function renderCategoryTable(vm) {
  const tbody = document.getElementById('cat-tbody');
  tbody.innerHTML = '';
  const total = vm.total;

  vm.catSorted.forEach(([cat, amt]) => {
    const pct = total > 0 ? (amt / total * 100).toFixed(1) : '0.0';
    const count = vm.rows.filter(r => r.category === cat).length;
    const color = getCatColor(cat);
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><span class="cat-badge" style="--cat-color:${color}">${escapeHtml(cat)}</span></td>
      <td class="text-right">${fmt(amt)}</td>
      <td class="text-right">${pct}%</td>
      <td class="text-right">${count}</td>
    `;
    tbody.appendChild(tr);
  });

  if (!vm.catSorted.length) {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td colspan="4" style="text-align:center;color:var(--text-muted);padding:2rem">No data for this selection</td>';
    tbody.appendChild(tr);
  }
}

/* ── Render: Insights ─────────────────────────────────────────────────────── */
function renderInsights(monthMetrics, vm) {
  // Spending pace (month-relative only, hidden entirely in range mode)
  document.getElementById('iv-pace').innerHTML =
    `On pace for <strong>${fmt(monthMetrics.pace)}</strong> this month`;

  // Biggest expense
  if (vm.biggest) {
    const desc = escapeHtml(vm.biggest.description || vm.biggest.category);
    document.getElementById('iv-biggest').innerHTML =
      `${desc} — <strong>${fmt(vm.biggest.amount)}</strong>`;
  } else {
    document.getElementById('iv-biggest').textContent = '—';
  }

  // Most expensive day
  if (vm.busiestDay) {
    const d = parseFlexibleDate(vm.busiestDay);
    const label = escapeHtml(d ? formatDisplayDate(d) : vm.busiestDay);
    document.getElementById('iv-busiest').innerHTML =
      `${label} — <strong>${fmt(vm.busiestAmt)}</strong>`;
  } else {
    document.getElementById('iv-busiest').textContent = '—';
  }

  // Weekday vs weekend
  document.getElementById('iv-weekend').innerHTML =
    `<strong>${vm.weekdayPct}%</strong> weekday / <strong>${vm.weekendPct}%</strong> weekend`;
}

/* ── Render: Transaction Table ────────────────────────────────────────────── */
function renderTxnTable() {
  let rows = getFilteredRows();

  // Sort
  rows = [...rows].sort((a, b) => {
    if (state.sortCol === 'category') {
      const cmp = a.category.localeCompare(b.category);
      return state.sortDir === 'asc' ? cmp : -cmp;
    }
    const aVal = state.sortCol === 'amount' ? a.amount : a.date.getTime();
    const bVal = state.sortCol === 'amount' ? b.amount : b.date.getTime();
    return state.sortDir === 'desc' ? bVal - aVal : aVal - bVal;
  });

  // Pagination
  const totalPages = Math.max(1, Math.ceil(rows.length / ROWS_PER_PAGE));
  state.currentPage = Math.min(state.currentPage, totalPages);
  const start = (state.currentPage - 1) * ROWS_PER_PAGE;
  const pageRows = rows.slice(start, start + ROWS_PER_PAGE);

  const tbody = document.getElementById('txn-tbody');
  tbody.innerHTML = '';

  if (!pageRows.length) {
    const emptyMsg = state.searchQuery.trim()
      ? 'No transactions match your search'
      : state.rangeMode
        ? 'No transactions in this date range'
        : 'No transactions for this month';
    const tr = document.createElement('tr');
    tr.innerHTML = `<td colspan="4" style="text-align:center;color:var(--text-muted);padding:2rem">${emptyMsg}</td>`;
    tbody.appendChild(tr);
  } else {
    pageRows.forEach(r => {
      const color = getCatColor(r.category);
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td style="white-space:nowrap">${formatDisplayDate(r.date)}</td>
        <td><span class="cat-badge" style="--cat-color:${color}">${escapeHtml(r.category)}</span></td>
        <td class="desc-cell">${escapeHtml(r.description) || '—'}</td>
        <td class="text-right amount-cell">${fmt(r.amount)}</td>
      `;
      tbody.appendChild(tr);
    });
  }

  const rangeEnd = Math.min(start + ROWS_PER_PAGE, rows.length);
  document.getElementById('txn-range-label').textContent =
    rows.length ? `${start + 1}–${rangeEnd} of ${rows.length}` : '';
  document.getElementById('page-indicator').textContent =
    `Page ${state.currentPage} of ${totalPages}`;
  document.getElementById('btn-prev').disabled = state.currentPage <= 1;
  document.getElementById('btn-next').disabled = state.currentPage >= totalPages;
}

/* ── Render All ───────────────────────────────────────────────────────────── */
function renderViewSections(monthMetrics, viewMetrics) {
  renderSummaryCards(viewMetrics);
  renderDonutChart(viewMetrics);
  renderCategoryTable(viewMetrics);
  renderInsights(monthMetrics, viewMetrics);
  renderTxnTable();
}

function renderAll() {
  if (!state.selectedMonth) return;
  const monthMetrics = computeMetrics();
  const viewMetrics = computeViewMetrics();

  updateRangeModeVisibility();
  renderViewSections(monthMetrics, viewMetrics);

  if (!state.rangeMode) {
    renderMoMCard(monthMetrics);
    renderMoMBarChart();
    renderCalendar();
  }

  renderFixedTab();
}

/* ── Render: Fixed Expenses Tab ───────────────────────────────────────────── */
function renderFixedDonutChart(fm) {
  destroyChart('donutFixed');
  if (!fm.catSorted.length) return;

  const labels = fm.catSorted.map(([k]) => k);
  const values = fm.catSorted.map(([, v]) => v);
  const total  = fm.total;
  const colors = labels.map(getCatColor);

  state.charts.donutFixed = new Chart(
    document.getElementById('chart-donut-fixed').getContext('2d'), {
      type: 'doughnut',
      data: {
        labels,
        datasets: [{
          data: values,
          backgroundColor: colors,
          borderWidth: 2,
          borderColor: cssVar('--chart-segment-gap'),
          hoverOffset: 6,
        }],
      },
      options: {
        cutout: '70%',
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            position: 'bottom',
            labels: { padding: 14, usePointStyle: true, pointStyleWidth: 8, font: { size: 12 } },
          },
          tooltip: {
            callbacks: {
              label: ctx => {
                const pct = total > 0 ? (ctx.raw / total * 100).toFixed(1) : 0;
                return ` ${ctx.label}: ${fmt(ctx.raw)} (${pct}%)`;
              },
            },
          },
        },
      },
    }
  );
}

function renderFixedBarChart() {
  destroyChart('barFixed');
  const year = Number(state.selectedMonth.split('-')[0]);
  document.getElementById('heading-bar-fixed').textContent = `Fixed Expenses Overview — ${year}`;
  const months = getYearMonths(year);
  const labels = months.map(formatMonthShort);
  const getTotalForMonth = mo => getActiveFixedRows(mo).reduce((s, r) => s + r.amount, 0);
  const totals = months.map(getTotalForMonth);
  const momData = computeMoMForMonths(months, getTotalForMonth);
  const colors = months.map(mo =>
    mo === state.selectedMonth ? 'rgba(70,184,212,0.6)' : 'rgba(70,184,212,0.15)'
  );
  const borderColors = months.map(mo =>
    mo === state.selectedMonth ? 'rgba(70,184,212,0.9)' : 'rgba(70,184,212,0.35)'
  );

  state.charts.barFixed = new Chart(
    document.getElementById('chart-bar-fixed').getContext('2d'), {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          data: totals,
          backgroundColor: colors,
          borderColor: borderColors,
          borderWidth: 1.5,
          borderRadius: 6,
          borderSkipped: false,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            enabled: false,
            external: monthlyBarTooltipHandler(momData),
          },
        },
        scales: {
          x: { grid: { display: false }, ticks: { font: { size: 11 } } },
          y: {
            grid: { color: cssVar('--chart-grid-line') },
            ticks: {
              font: { size: 11 },
              callback: v => `S$${v >= 1000 ? (v / 1000).toFixed(1) + 'k' : v}`,
            },
          },
        },
      },
    }
  );
}

function getSortedFixedSchedule() {
  const rows = [...state.fixedSchedule];
  const col = state.fixedSortCol;
  const dir = state.fixedSortDir;

  rows.sort((a, b) => {
    let aVal, bVal;
    switch (col) {
      case 'description': aVal = a.description.toLowerCase(); bVal = b.description.toLowerCase(); break;
      case 'category':    aVal = a.category.toLowerCase();    bVal = b.category.toLowerCase();    break;
      case 'amount':       aVal = a.amount; bVal = b.amount; break;
      case 'endDate':      aVal = a.endDate ? a.endDate.getTime() : Infinity; bVal = b.endDate ? b.endDate.getTime() : Infinity; break;
      case 'status':       aVal = a.endDate ? 0 : 1; bVal = b.endDate ? 0 : 1; break;
      case 'startDate':
      default:             aVal = a.startDate.getTime(); bVal = b.startDate.getTime();
    }
    if (typeof aVal === 'string') {
      const cmp = aVal.localeCompare(bVal);
      return dir === 'asc' ? cmp : -cmp;
    }
    return dir === 'asc' ? aVal - bVal : bVal - aVal;
  });

  return rows;
}

function renderFixedTab() {
  if (!state.selectedMonth) return;

  document.getElementById('fixed-unavailable').classList.toggle('hidden', !state.fixedLoadError);
  document.getElementById('fixed-content').classList.toggle('hidden', state.fixedLoadError);

  if (state.fixedLoadError) return;

  const fm = computeFixedMetrics(state.selectedMonth);
  document.getElementById('val-fixed-total').textContent = fmt(fm.total);
  document.getElementById('sub-fixed-total').textContent = formatMonthLabel(state.selectedMonth);
  document.getElementById('val-fixed-active').textContent = fm.activeCount;
  document.getElementById('val-fixed-discontinued').textContent = fm.discontinuedCount;

  // Chart.js can't reliably size/paint a canvas inside a display:none container,
  // so only (re)create these charts while the Fixed tab is actually visible.
  if (state.activeTab === 'fixed') {
    renderFixedDonutChart(fm);
    renderFixedBarChart();
  }

  const tbody = document.getElementById('fixed-tbody');
  tbody.innerHTML = '';

  if (!state.fixedSchedule.length) {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td colspan="6" style="text-align:center;color:var(--text-muted);padding:2rem">No fixed expenses recorded yet.</td>';
    tbody.appendChild(tr);
    return;
  }

  getSortedFixedSchedule().forEach(r => {
    const catColor = getCatColor(r.category);
    const isOngoing = !r.endDate;
    const statusClass = isOngoing ? 'active' : 'discontinued';
    const statusLabel = isOngoing ? 'Ongoing' : 'Ended';
    const endLabel = r.endDate ? formatDisplayDate(r.endDate) : '—';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapeHtml(r.description)}</td>
      <td><span class="cat-badge" style="--cat-color:${catColor}">${escapeHtml(r.category)}</span></td>
      <td class="text-right amount-cell">${fmt(r.amount)}</td>
      <td style="white-space:nowrap">${formatDisplayDate(r.startDate)}</td>
      <td style="white-space:nowrap">${endLabel}</td>
      <td><span class="status-badge status-badge--${statusClass}">${statusLabel}</span></td>
    `;
    tbody.appendChild(tr);
  });
}

/* ── Tab Switching ─────────────────────────────────────────────────────────── */
function switchTab(tab) {
  state.activeTab = tab;
  document.getElementById('tab-btn-variable').classList.toggle('active', tab === 'variable');
  document.getElementById('tab-btn-fixed').classList.toggle('active', tab === 'fixed');
  document.getElementById('tab-panel-variable').classList.toggle('hidden', tab !== 'variable');
  document.getElementById('tab-panel-fixed').classList.toggle('hidden', tab !== 'fixed');
  // Panel is now visible (if switching to it) - (re)create its charts now, not while hidden.
  if (tab === 'fixed') renderFixedTab();
}

/* ── UI Helpers ───────────────────────────────────────────────────────────── */
function showLoader(visible) {
  document.getElementById('loading-overlay').classList.toggle('hidden', !visible);
}

function showError(msg) {
  const banner = document.getElementById('error-banner');
  document.getElementById('error-text').textContent = msg;
  banner.classList.remove('hidden');
}

function hideError() {
  document.getElementById('error-banner').classList.add('hidden');
}

function showSetupModal() {
  const stored = localStorage.getItem(STORAGE_KEY) || DEFAULT_SHEET_URL;
  document.getElementById('setup-url-input').value = stored;
  document.getElementById('setup-modal').classList.remove('hidden');
  document.getElementById('setup-error').classList.add('hidden');
}

function hideSetupModal() {
  document.getElementById('setup-modal').classList.add('hidden');
}

function showSettingsModal() {
  const stored = localStorage.getItem(STORAGE_KEY) || DEFAULT_SHEET_URL;
  document.getElementById('settings-url-input').value = stored;
  document.getElementById('settings-modal').classList.remove('hidden');
  document.getElementById('settings-error').classList.add('hidden');
}

function hideSettingsModal() {
  document.getElementById('settings-modal').classList.add('hidden');
}

function isValidUrl(str) {
  try { const u = new URL(str); return u.protocol === 'https:' || u.protocol === 'http:'; }
  catch { return false; }
}

/* ── Init & Event Wiring ──────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  applyChartDefaults();
  updateThemeToggleIcon();

  document.getElementById('theme-toggle-btn').addEventListener('click', toggleTheme);

  /* ── Tab switcher ── */
  document.getElementById('tab-btn-variable').addEventListener('click', () => switchTab('variable'));
  document.getElementById('tab-btn-fixed').addEventListener('click', () => switchTab('fixed'));

  document.getElementById('fixed-setup-settings-btn').addEventListener('click', showSettingsModal);
  document.getElementById('fixed-retry-btn').addEventListener('click', loadFixedData);

  // Keep in sync with live OS theme changes when the user hasn't made an explicit choice
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
      if (!localStorage.getItem(THEME_STORAGE_KEY)) {
        updateThemeToggleIcon();
        applyChartDefaults();
        if (state.allRows.length) renderAll();
      }
    });
  }

  // Show setup modal if no URL stored, otherwise go straight to data load
  const storedUrl = localStorage.getItem(STORAGE_KEY);
  if (!storedUrl) {
    document.getElementById('setup-url-input').value = DEFAULT_SHEET_URL;
    showSetupModal();
  } else {
    loadData();
  }

  /* ── Setup modal ── */
  document.getElementById('setup-save-btn').addEventListener('click', () => {
    const val = document.getElementById('setup-url-input').value.trim();
    const errEl = document.getElementById('setup-error');
    if (!isValidUrl(val) || !extractSpreadsheetId(val)) {
      errEl.textContent = "Please paste your Google Sheet's normal share link (e.g. https://docs.google.com/spreadsheets/d/XXXXX/edit).";
      errEl.classList.remove('hidden');
      return;
    }
    errEl.classList.add('hidden');
    localStorage.setItem(STORAGE_KEY, val);
    hideSetupModal();
    loadData();
  });

  // Allow Enter key in setup input
  document.getElementById('setup-url-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('setup-save-btn').click();
  });

  /* ── Settings modal ── */
  document.getElementById('settings-btn').addEventListener('click', showSettingsModal);

  document.getElementById('settings-cancel-btn').addEventListener('click', hideSettingsModal);

  document.getElementById('settings-save-btn').addEventListener('click', () => {
    const val = document.getElementById('settings-url-input').value.trim();
    const errEl = document.getElementById('settings-error');

    if (!isValidUrl(val) || !extractSpreadsheetId(val)) {
      errEl.textContent = "Please paste your Google Sheet's normal share link (e.g. https://docs.google.com/spreadsheets/d/XXXXX/edit).";
      errEl.classList.remove('hidden');
      return;
    }
    errEl.classList.add('hidden');

    localStorage.setItem(STORAGE_KEY, val);

    hideSettingsModal();
    state.allRows = [];
    state.fixedSchedule = [];
    state.fixedLoadError = false;
    state.selectedMonth = null;
    state.rangeMode = false;
    state.rangeStart = null;
    state.rangeEnd = null;
    state.rangePreset = null;
    state.searchQuery = '';
    document.getElementById('txn-search-input').value = '';
    loadData();
  });

  document.getElementById('settings-url-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('settings-save-btn').click();
  });

  // Close modals on backdrop click
  document.getElementById('setup-modal').addEventListener('click', e => {
    if (e.target === e.currentTarget) hideSetupModal();
  });
  document.getElementById('settings-modal').addEventListener('click', e => {
    if (e.target === e.currentTarget) hideSettingsModal();
  });

  /* ── Year filter ── */
  document.getElementById('year-filter').addEventListener('change', e => {
    populateMonthOptionsForYear(Number(e.target.value));
    state.currentPage = 1;
    closeDayDetail();
    renderAll();
  });

  /* ── Month filter ── */
  document.getElementById('month-filter').addEventListener('change', e => {
    state.selectedMonth = e.target.value;
    state.currentPage = 1;
    closeDayDetail();
    renderAll();
  });

  /* ── Transaction search ── */
  document.getElementById('txn-search-input').addEventListener('input', e => {
    state.searchQuery = e.target.value;
    state.currentPage = 1;
    renderViewSections(computeMetrics(), computeViewMetrics());
  });

  /* ── Date range: presets ── */
  document.querySelectorAll('#range-presets .chip-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const days = parseInt(btn.dataset.preset, 10);
      const end = new Date(); end.setHours(0, 0, 0, 0);
      const start = new Date(end); start.setDate(start.getDate() - (days - 1));
      document.getElementById('range-error').classList.add('hidden');
      activateRangeMode(start, end, btn.dataset.preset);
    });
  });

  /* ── Date range: manual apply ── */
  document.getElementById('range-apply-btn').addEventListener('click', () => {
    const startVal = document.getElementById('range-start').value;
    const endVal   = document.getElementById('range-end').value;
    const errEl    = document.getElementById('range-error');
    const start = startVal ? new Date(startVal + 'T00:00:00') : null;
    const end   = endVal   ? new Date(endVal   + 'T00:00:00') : null;

    if (!start || !end || isNaN(start) || isNaN(end) || start > end) {
      errEl.textContent = !start || !end
        ? 'Please select both a start and end date.'
        : 'Start date must be on or before end date.';
      errEl.classList.remove('hidden');
      return;
    }
    errEl.classList.add('hidden');
    activateRangeMode(start, end, 'custom');
  });

  /* ── Date range: back to month view ── */
  document.getElementById('range-clear-btn').addEventListener('click', deactivateRangeMode);

  /* ── Day detail close ── */
  document.getElementById('dd-close-btn').addEventListener('click', closeDayDetail);

  /* ── Sort headers ── */
  document.querySelectorAll('#txn-table th.sortable').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.sort;
      if (state.sortCol === col) {
        state.sortDir = state.sortDir === 'desc' ? 'asc' : 'desc';
      } else {
        state.sortCol = col;
        state.sortDir = 'desc';
      }
      state.currentPage = 1;
      // Update classes
      document.querySelectorAll('#txn-table th.sortable').forEach(h => {
        h.classList.remove('sort-asc', 'sort-desc');
      });
      th.classList.add(state.sortDir === 'asc' ? 'sort-asc' : 'sort-desc');
      renderTxnTable();
    });
  });

  document.querySelectorAll('#fixed-table th.sortable').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.sort;
      if (state.fixedSortCol === col) {
        state.fixedSortDir = state.fixedSortDir === 'desc' ? 'asc' : 'desc';
      } else {
        state.fixedSortCol = col;
        state.fixedSortDir = 'desc';
      }
      document.querySelectorAll('#fixed-table th.sortable').forEach(h => {
        h.classList.remove('sort-asc', 'sort-desc');
      });
      th.classList.add(state.fixedSortDir === 'asc' ? 'sort-asc' : 'sort-desc');
      renderFixedTab();
    });
  });

  /* ── Pagination ── */
  document.getElementById('btn-prev').addEventListener('click', () => {
    if (state.currentPage > 1) { state.currentPage--; renderTxnTable(); }
  });
  document.getElementById('btn-next').addEventListener('click', () => {
    state.currentPage++;
    renderTxnTable();
  });

  /* ── Retry ── */
  document.getElementById('retry-btn').addEventListener('click', () => {
    hideError();
    loadData();
  });
});
