/* ── Config ────────────────────────────────────────────────────────────────── */
const DEFAULT_SHEET_URL =
  'https://docs.google.com/spreadsheets/d/e/2PACX-1vQukvlfbVuwS7R1PizzrfK6kiK6A7ZmEywq4lBxQmjOD0sASVlJOfxVJXL1BO_eqLze6vGfL5yBm3dw/pub?gid=0&single=true&output=csv';

const STORAGE_KEY = 'expense_tracker_sheet_url';
const ROWS_PER_PAGE = 20;

const CATEGORY_COLORS = {
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
  },

  searchQuery: '',
  rangeMode:   false,
  rangeStart:  null,
  rangeEnd:    null,
  rangePreset: null,
};

/* ── Utilities ─────────────────────────────────────────────────────────────── */
const fmt = v =>
  new Intl.NumberFormat('en-SG', {
    style: 'currency', currency: 'SGD', minimumFractionDigits: 2,
  }).format(v);

const toYYYYMM = d =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;

function formatMonthLabel(yyyymm) {
  const [y, m] = yyyymm.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleString('default', { month: 'long', year: 'numeric' });
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

async function loadData() {
  const sheetUrl = localStorage.getItem(STORAGE_KEY) || DEFAULT_SHEET_URL;
  const url = sheetUrl + '&t=' + Date.now();

  showLoader(true);
  hideError();

  // Try direct fetch first
  let res = await fetchWithTimeout(url, 6000);

  // Waterfall through CORS proxies
  if (!res) {
    for (const proxyFn of CORS_PROXIES) {
      res = await fetchWithTimeout(proxyFn(url), 7000);
      if (res) break;
    }
  }

  showLoader(false);

  if (!res) {
    showError('Could not load expense data. Check your sheet URL and try again.');
    return;
  }

  let csvText;
  try { csvText = await res.text(); } catch {
    showError('Failed to read response. Please retry.');
    return;
  }

  state.allRows = parseCSV(csvText);
  state.lastFetched = new Date();

  if (state.allRows.length === 0) {
    showError('No valid rows found. Ensure your sheet has columns: Date, Category, Description, Amount.');
    return;
  }

  document.getElementById('data-freshness').textContent =
    'Updated ' + state.lastFetched.toLocaleTimeString('en-SG', { hour: '2-digit', minute: '2-digit' });

  populateMonthFilter();
  renderAll();
}

/* ── Month Filter ─────────────────────────────────────────────────────────── */
function populateMonthFilter() {
  const sel = document.getElementById('month-filter');
  const months = [...new Set(state.allRows.map(r => toYYYYMM(r.date)))].sort().reverse();

  sel.innerHTML = '';
  months.forEach(m => {
    const opt = document.createElement('option');
    opt.value = m;
    opt.textContent = formatMonthLabel(m);
    sel.appendChild(opt);
  });

  // Preserve selection if still valid
  if (state.selectedMonth && months.includes(state.selectedMonth)) {
    sel.value = state.selectedMonth;
  } else {
    state.selectedMonth = months[0] || null;
    sel.value = state.selectedMonth;
  }
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

function getLastNMonths(n) {
  const [y, m] = state.selectedMonth.split('-').map(Number);
  const months = [];
  for (let i = n - 1; i >= 0; i--) {
    months.push(toYYYYMM(new Date(y, m - 1 - i, 1)));
  }
  return months;
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
          borderColor: '#050c1c',
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
  const months = getLastNMonths(6);
  const labels = months.map(formatMonthLabel);
  const totals = months.map(mo =>
    state.allRows.filter(r => toYYYYMM(r.date) === mo).reduce((s, r) => s + r.amount, 0)
  );
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
            callbacks: {
              label: ctx => ` Total: ${fmt(ctx.raw)}`,
            },
          },
        },
        scales: {
          x: { grid: { display: false }, ticks: { font: { size: 11 } } },
          y: {
            grid: { color: 'rgba(255,255,255,0.06)' },
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
      <td><span class="cat-badge" style="--cat-color:${color}">${r.category}</span></td>
      <td style="color:var(--text-secondary)">${r.description || '—'}</td>
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
      <td><span class="cat-badge" style="--cat-color:${color}">${cat}</span></td>
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
    const desc = vm.biggest.description || vm.biggest.category;
    document.getElementById('iv-biggest').innerHTML =
      `${desc} — <strong>${fmt(vm.biggest.amount)}</strong>`;
  } else {
    document.getElementById('iv-biggest').textContent = '—';
  }

  // Most expensive day
  if (vm.busiestDay) {
    const d = parseFlexibleDate(vm.busiestDay);
    const label = d ? formatDisplayDate(d) : vm.busiestDay;
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
        <td><span class="cat-badge" style="--cat-color:${color}">${r.category}</span></td>
        <td class="desc-cell">${r.description || '—'}</td>
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
  // Chart.js global defaults
  if (typeof Chart !== 'undefined') {
    Chart.defaults.font.family = "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
    Chart.defaults.color = '#8ab0cc';
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
    if (!isValidUrl(val)) {
      document.getElementById('setup-error').classList.remove('hidden');
      return;
    }
    document.getElementById('setup-error').classList.add('hidden');
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
    if (!isValidUrl(val)) {
      document.getElementById('settings-error').classList.remove('hidden');
      return;
    }
    document.getElementById('settings-error').classList.add('hidden');
    localStorage.setItem(STORAGE_KEY, val);
    hideSettingsModal();
    state.allRows = [];
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
