import React, { useState, useEffect, useMemo, useCallback, useRef, useId } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, BarChart, Bar, ReferenceLine, ScatterChart, Scatter, Cell,
  Area, ComposedChart, ErrorBar, Customized
} from "recharts";
import { Plus, Trash2, Pencil, X, TrendingUp, TrendingDown, RotateCcw, Settings2, ChevronLeft, ChevronRight, ChevronDown, ChevronUp, ArrowLeft, Upload, Download, Sun, Moon } from "lucide-react";
import Papa from "papaparse";

// ---------- constants ----------

const DEFAULT_SETTINGS = {
  MES: { label: "Micro E-mini S&P 500", multiplier: 5, accent: "#6C93AD", category: "micro" },
  MNQ: { label: "Micro E-mini Nasdaq-100", multiplier: 2, accent: "#9385C9", category: "micro" },
  MCL: { label: "Micro WTI Crude Oil", multiplier: 100, accent: "#D9A441", category: "micro" },
  MGC: { label: "Micro Gold", multiplier: 10, accent: "#C7B15A", category: "micro" },
  M2K: { label: "Micro Russell 2000", multiplier: 5, accent: "#7FAE8E", category: "micro" },
};

const TRADES_KEY = "futures_journal_trades_v1";
const SETTINGS_KEY = "futures_journal_settings_v1";
const ACCOUNTS_KEY = "futures_journal_accounts_v1";
const NOTES_KEY = "futures_journal_notes_v1";
const THEME_KEY = "futures_journal_theme_v1";

const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

const NOTE_CATEGORIES = [
  ["general", "General"],
  ["strategy", "Strategy Change"],
  ["market", "Market Added/Removed"],
  ["account", "Account Update"],
  ["setting", "Setting Change"],
];
const NOTE_CATEGORY_LABEL = Object.fromEntries(NOTE_CATEGORIES);

// Notes store `links: [{type, key}, ...]` (multiple strategies/markets/
// accounts can be tagged on one note).
function getNoteLinks(note) {
  if (Array.isArray(note.links)) return note.links;
  if (note.entityType && note.entityKey) return [{ type: note.entityType, key: note.entityKey }];
  return [];
}

// ---------- Tradovate CSV import ----------
//
// Tradovate's "Performance" export is a round-turn report — one row per
// closed position, not one row per fill — with a totally different shape
// than our own export: no strategy/account info at all, contract symbols
// with the month code baked in (NQU6 = NQ, September), and P&L in
// accounting format ($(1,190.00) for negative).

const TRADOVATE_REQUIRED_HEADERS = ["symbol", "buyFillId", "sellFillId", "qty", "buyPrice", "sellPrice", "pnl", "boughtTimestamp", "soldTimestamp"];

// Futures month codes: F=Jan G=Feb H=Mar J=Apr K=May M=Jun N=Jul Q=Aug U=Sep V=Oct X=Nov Z=Dec
function parseTradovateSymbolRoot(symbol) {
  const m = /^([A-Z]+?)([FGHJKMNQUVXZ]\d{1,2})$/.exec((symbol || "").trim());
  return m ? m[1] : (symbol || "").trim();
}

// "08/28/2026 08:42:00" -> { date: "2026-08-28", time: "08:42", ms: <epoch> }
function parseTradovateTimestamp(str) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})$/.exec((str || "").trim());
  if (!m) return null;
  const [, mo, day, yr, hh, mm, ss] = m;
  const date = `${yr}-${mo}-${day}`;
  const time = `${hh}:${mm}`;
  const ms = new Date(`${date}T${hh}:${mm}:${ss}`).getTime();
  return { date, time, ms };
}

// "$(1,190.00)" -> -1190, "$520.00" -> 520
function parseTradovatePnl(str) {
  const s = (str || "").trim();
  const negative = s.startsWith("$(") || s.startsWith("(");
  const num = parseFloat(s.replace(/[$(),]/g, ""));
  if (Number.isNaN(num)) return null;
  return negative ? -Math.abs(num) : num;
}

// Contract specs that are stable exchange facts, not something that changes
// day to day — safe to state with confidence. Anything not in this list
// gets a placeholder multiplier of 1 and is flagged for the user to fix.
const KNOWN_MARKET_DEFAULTS = {
  NQ: { label: "E-mini Nasdaq-100", multiplier: 20, category: "mini", feePerContract: 5.76 },
  ES: { label: "E-mini S&P 500", multiplier: 50, category: "mini" },
  RTY: { label: "E-mini Russell 2000", multiplier: 50, category: "mini" },
  YM: { label: "E-mini Dow", multiplier: 5, category: "mini" },
};

// Round-trip commission/fees per contract, set per market in Contract
// Settings ($5.76 for NQ = $2.88 a side). Stored P&L everywhere in the app
// is NET of fees, so anything that creates a trade subtracts this.
function feeForTrade(settings, market, contracts) {
  const perContract = Number(settings?.[market]?.feePerContract) || 0;
  return Number((perContract * (Number(contracts) || 1)).toFixed(2));
}

// Existing saved settings predate the fee field. Seed NQ to the $5.76
// starting value only when the field has never been set, so a value the
// user later edits (even to 0) is never overwritten.
function seedFeeDefaults(settings) {
  if (settings.NQ && settings.NQ.feePerContract === undefined) {
    return { ...settings, NQ: { ...settings.NQ, feePerContract: 5.76 } };
  }
  return settings;
}

function guessMarketDefaults(root) {
  if (KNOWN_MARKET_DEFAULTS[root]) return { ...KNOWN_MARKET_DEFAULTS[root], verified: true };
  const isMicro = root.startsWith("M") && root.length > 1;
  return { label: root, multiplier: 1, category: isMicro ? "micro" : "mini", verified: false };
}

function parseTradovateRow(row) {
  const root = parseTradovateSymbolRoot(row.symbol);
  const bought = parseTradovateTimestamp(row.boughtTimestamp);
  const sold = parseTradovateTimestamp(row.soldTimestamp);
  if (!bought || !sold) return null;
  const isLong = bought.ms <= sold.ms; // bought first = entered long; sold first = entered short
  const pnl = parseTradovatePnl(row.pnl);
  if (pnl === null) return null;
  // A constant hour-offset shifts both timestamps equally, so which one
  // came first (and therefore direction and duration) is unaffected — only
  // the displayed/stored date and time change. That's computed later, once,
  // from _entryMs + whatever offset is chosen.
  const buyId = (row.buyFillId || "").toString().trim();
  const sellId = (row.sellFillId || "").toString().trim();
  return {
    _entryMs: isLong ? bought.ms : sold.ms,
    // Fill IDs are stable across re-exports, so this pair identifies the
    // round-turn and lets a re-upload skip trades already in the journal.
    _fingerprint: buyId && sellId ? `${buyId}|${sellId}` : "",
    durationSec: Math.round(Math.abs(sold.ms - bought.ms) / 1000),
    market: root,
    direction: isLong ? "Long" : "Short",
    contracts: Number(row.qty) || 1,
    entry: null, // Tradovate's per-fill prices aren't shown in the journal
    exit: null,
    fees: 0,
    pnl,
    notes: "",
    strategy: (row.strategy || "").trim(), // only present if the user manually added this column before uploading
    accounts: [],
  };
}

// Applies the hour offset to a raw entry timestamp and returns the
// date/time as our app stores them. A day can roll over (e.g. 23:40 + 1h
// = 00:40 the next day) — using a real Date object handles that correctly.
function tradovateDateTimeAt(entryMs, hourOffset) {
  const d = new Date(entryMs + hourOffset * 3600000);
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const time = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return { date, time };
}

// ---------- NinjaTrader import ----------
//
// NinjaTrader's "Trades" grid exports one row per FILL (an entry or an exit),
// not one row per closed position the way Tradovate's export does — so unlike
// Tradovate, this has to pair fills into round-turns itself. Each fill is
// explicitly tagged Entry/Exit by NinjaTrader already, which makes pairing
// straightforward: walk each (instrument, account)'s fills in time order,
// accumulate entries into an open position, and consume exits against it.
// Handles scaling in (multiple Entry fills building one position), partial
// exits (multiple Exit fills closing one position), and a same-fill reversal
// (an Exit that closes more than the open size, with the remainder opening a
// new position the other way) — all verified against a real exported file,
// including checking that a stop-out's P&L matches its point loss × multiplier.
const NINJATRADER_REQUIRED_HEADERS = ["Instrument", "Action", "Quantity", "Price", "Time", "E/X"];

// "MNQ 12-26" -> "MNQ" (NinjaTrader suffixes the contract month as "MM-YY")
function parseNinjaTraderSymbolRoot(instrument) {
  return (instrument || "").trim().split(/\s+/)[0];
}

// "9/28/2026 6:09:21 PM" -> { date: "2026-09-28", time: "18:09", ms }
function parseNinjaTraderTimestamp(str) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})\s+(AM|PM)$/i.exec((str || "").trim());
  if (!m) return null;
  const [, mo, day, yr, hh12, mm, ss, ap] = m;
  let hh = Number(hh12) % 12;
  if (/pm/i.test(ap)) hh += 12;
  const d = new Date(Number(yr), Number(mo) - 1, Number(day), hh, Number(mm), Number(ss));
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const time = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return { date, time, ms: d.getTime() };
}

// "$0.00" -> 0, "$(4.50)" -> -4.5 — looser than parseTradovatePnl since
// commission is never expected to be negative, but handled just in case.
function parseCurrencyLoose(str) {
  const s = (str || "").trim();
  if (!s) return 0;
  const negative = s.startsWith("$(") || s.startsWith("(") || s.startsWith("-");
  const num = parseFloat(s.replace(/[$(),]/g, ""));
  if (Number.isNaN(num)) return 0;
  return negative ? -Math.abs(num) : num;
}

// Groups a flat fill list (already sorted ascending by time, already scoped
// to one instrument+account) into completed round-turn positions.
function pairNinjaTraderFills(fills) {
  const completed = [];
  let open = null;
  fills.forEach((f) => {
    const dir = f.action === "Buy" ? "Long" : "Short";
    if (f.ex === "Entry") {
      if (!open) {
        open = { direction: dir, entryFills: [f], exitFills: [], remainingQty: f.qty };
      } else if (open.direction === dir) {
        open.entryFills.push(f);
        open.remainingQty += f.qty;
      } else {
        // An Entry fill while a position is open the other way shouldn't
        // happen in a normal export — treat it as starting fresh rather
        // than silently corrupting the open position's math.
        open = { direction: dir, entryFills: [f], exitFills: [], remainingQty: f.qty };
      }
    } else if (f.ex === "Exit") {
      if (!open) return; // orphan exit (position opened before this file's window) — skip
      const exitDirOk = (open.direction === "Long" && f.action === "Sell") || (open.direction === "Short" && f.action === "Buy");
      if (!exitDirOk) return;
      const consumed = Math.min(f.qty, open.remainingQty);
      open.exitFills.push({ ...f, qty: consumed });
      open.remainingQty -= consumed;
      if (open.remainingQty <= 0) {
        completed.push(open);
        const leftover = f.qty - consumed;
        open = leftover > 0 ? { direction: dir, entryFills: [{ ...f, qty: leftover }], exitFills: [], remainingQty: leftover } : null;
      }
    }
  });
  return completed;
}

function summarizeNinjaTraderPosition(pos) {
  const qty = pos.entryFills.reduce((s, f) => s + f.qty, 0);
  const entryPrice = pos.entryFills.reduce((s, f) => s + f.price * f.qty, 0) / qty;
  const exitQty = pos.exitFills.reduce((s, f) => s + f.qty, 0);
  const exitPrice = exitQty ? pos.exitFills.reduce((s, f) => s + f.price * f.qty, 0) / exitQty : null;
  const entryMs = Math.min(...pos.entryFills.map((f) => f.ms));
  const exitMs = pos.exitFills.length ? Math.max(...pos.exitFills.map((f) => f.ms)) : null;
  const commission = [...pos.entryFills, ...pos.exitFills].reduce((s, f) => s + f.commission, 0);
  const entryNames = Array.from(new Set(pos.entryFills.map((f) => f.name).filter(Boolean)));
  const exitNames = Array.from(new Set(pos.exitFills.map((f) => f.name).filter(Boolean)));
  // Order IDs are unique per fill and stable across re-exports, so a sorted
  // join of every fill's Order ID making up this position is a reliable
  // fingerprint for de-duping re-imports of the same full-history export.
  const fingerprint = [...pos.entryFills, ...pos.exitFills]
    .map((f) => f.orderId)
    .filter(Boolean)
    .sort()
    .join("|");
  return {
    root: pos.entryFills[0].root, account: pos.entryFills[0].account,
    direction: pos.direction, qty, entryPrice, exitPrice, entryMs, exitMs, commission,
    durationSec: exitMs ? Math.round((exitMs - entryMs) / 1000) : null,
    entryNames, exitNames, fingerprint,
  };
}

// Parses raw Papa-parsed rows into completed positions, grouped by
// instrument+account so simultaneous positions in different markets (or
// different sim accounts) don't get paired with each other.
function parseNinjaTraderRows(rawRows) {
  const fills = [];
  let errorCount = 0;
  rawRows.forEach((row) => {
    const ts = parseNinjaTraderTimestamp(row["Time"]);
    const qty = Number(row["Quantity"]);
    const price = Number(row["Price"]);
    const ex = (row["E/X"] || "").trim();
    const action = (row["Action"] || "").trim();
    if (!ts || !qty || !Number.isFinite(price) || (ex !== "Entry" && ex !== "Exit") || (action !== "Buy" && action !== "Sell")) {
      errorCount++;
      return;
    }
    fills.push({
      root: parseNinjaTraderSymbolRoot(row["Instrument"]),
      action, qty, price, ms: ts.ms, ex,
      commission: parseCurrencyLoose(row["Commission"]),
      account: (row["Account display name"] || row["Account name"] || "").trim(),
      name: (row["Name"] || "").trim(),
      orderId: (row["Order ID"] || "").trim(),
    });
  });

  const groups = {};
  fills.forEach((f) => {
    const key = `${f.root}__${f.account}`;
    (groups[key] = groups[key] || []).push(f);
  });

  const positions = [];
  Object.values(groups).forEach((groupFills) => {
    const sorted = [...groupFills].sort((a, b) => a.ms - b.ms);
    positions.push(...pairNinjaTraderFills(sorted));
  });

  const summaries = positions
    .map(summarizeNinjaTraderPosition)
    .filter((s) => s.exitMs !== null); // drop any position still open (no matching exit in this file)

  return { summaries, errorCount };
}

function formatDuration(sec) {
  if (sec === null || sec === undefined || Number.isNaN(sec)) return "—";
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${ss}s`;
  return `${ss}s`;
}

const DOW_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DOW_LABELS_SHORT = ["S", "M", "T", "W", "T", "F", "S"];
const DOW_LABELS_FULL = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function heatColor(value, maxAbs) {
  if (!maxAbs || value === 0 || value === null || value === undefined) return "rgba(139,146,158,0.08)";
  const intensity = Math.min(Math.abs(value) / maxAbs, 1);
  const alpha = 0.24 + intensity * 0.74;
  const [r, g, b] = value > 0 ? [110, 189, 142] : [214, 118, 91];
  return `rgba(${r},${g},${b},${alpha.toFixed(2)})`;
}

function dowOf(dateStr) {
  return new Date(`${dateStr}T00:00:00`).getDay();
}

function fmtDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

const MONTH_LABELS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function buildMonthGrid(year, month, byDate, maxAbsOverride) {
  const gridStart = new Date(year, month, 1);
  gridStart.setDate(gridStart.getDate() - gridStart.getDay());
  const lastOfMonth = new Date(year, month + 1, 0);
  const gridEnd = new Date(lastOfMonth);
  gridEnd.setDate(gridEnd.getDate() + (6 - gridEnd.getDay()));

  const days = [];
  const c = new Date(gridStart);
  while (c <= gridEnd) {
    const key = fmtDate(c);
    days.push({
      key,
      dayNum: c.getDate(),
      inMonth: c.getMonth() === month,
      ...(byDate[key] || { pnl: 0, count: 0 }),
    });
    c.setDate(c.getDate() + 1);
  }
  const weeks = [];
  for (let i = 0; i < days.length; i += 7) weeks.push(days.slice(i, i + 7));

  const monthDays = days.filter((d) => d.inMonth);
  const monthTotal = monthDays.reduce((s, d) => s + d.pnl, 0);
  const monthCount = monthDays.reduce((s, d) => s + d.count, 0);
  const maxAbs = maxAbsOverride ?? Math.max(1, ...days.map((d) => Math.abs(d.pnl)));

  return { weeks, monthTotal, monthCount, maxAbs };
}

const money = (n) => {
  const v = Number(n) || 0;
  const sign = v < 0 ? "-" : "";
  return `${sign}$${Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

const pct = (n) => `${(Number(n) || 0).toFixed(1)}%`;

// ---------- daily loss limit ----------
//
// The idea: a strategy's daily stop should scale with what it actually
// does per trade (win rate, avg win, avg loss), not an arbitrary dollar
// figure — so it updates automatically as more trades come in.
//
// Two numbers come back:
//   - a statistical limit (expectancy minus k standard deviations of a
//     typical day), which tightens or loosens with the strategy's edge
//   - a simple R-multiple limit (2-3x the average loss), the industry
//     rule-of-thumb version, as a sanity check against the first
//
// Everything is normalized to a flat 1-contract basis (pnl / contracts)
// so historical size-scaling (martingale, discretionary sizing) doesn't
// distort the estimate. Multiply the result by whatever size you actually
// intend to trade live.
function computeDailyLossLimit(trades, { kValues = [1.5, 2, 2.5], tradesPerDayOverride, minTrades = 10 } = {}) {
  if (!trades || trades.length === 0) return null;

  const perContract = trades.map((t) => t.pnl / (t.contracts || 1));
  const n = perContract.length;

  const wins = perContract.filter((p) => p > 0);
  const losses = perContract.filter((p) => p < 0);
  const winRate = wins.length / n;
  const lossRate = losses.length / n;
  const avgWin = wins.length ? wins.reduce((a, b) => a + b, 0) / wins.length : 0;
  const avgLoss = losses.length ? Math.abs(losses.reduce((a, b) => a + b, 0) / losses.length) : 0;

  // Per-trade expectancy and variance (win/loss treated as a two-point
  // distribution around the expectancy).
  const expectancy = winRate * avgWin - lossRate * avgLoss;
  const variance = winRate * (avgWin - expectancy) ** 2 + lossRate * (-avgLoss - expectancy) ** 2;
  const sigma = Math.sqrt(variance);

  const days = new Set(trades.map((t) => t.date)).size;
  const tradesPerDay = tradesPerDayOverride ?? (days ? n / days : 1);

  // Variance adds across independent trades, so a day's spread scales
  // with sqrt(trades per day), not trades per day directly.
  const expectedDayPnl = expectancy * tradesPerDay;
  const daySigma = sigma * Math.sqrt(tradesPerDay);

  const limits = {};
  kValues.forEach((k) => { limits[k] = expectedDayPnl - k * daySigma; });

  return {
    n, days, tradesPerDay, winRate, avgWin, avgLoss,
    payoffRatio: avgLoss ? avgWin / avgLoss : null,
    expectancy, sigma, expectedDayPnl, daySigma,
    limits, // e.g. { 1.5: -45.4, 2: -70.1, 2.5: -94.8 }
    rMultiple: { low: 2 * avgLoss, high: 3 * avgLoss },
    lowSample: n < minTrades,
  };
}

// ---------- risk of ruin ----------
//
// "Given this strategy's actual win rate and average win/loss, if I trade
// it N more times, how likely is a losing stretch to wipe out a buffer of
// $X?" Run via Monte Carlo (drawing simulated trades from the strategy's
// own win/loss distribution) rather than the classical symmetric-payoff
// gambler's-ruin formula, since avg win and avg loss are rarely equal in
// real trade data — the closed-form formula would understate or overstate
// risk depending on which way the asymmetry runs. Flat 1-contract basis,
// same as the daily loss limit, so martingale history doesn't distort it.
function computeRiskOfRuin(trades, { buffer, numTrades = 100, numSims = 8000, minTrades = 10 } = {}) {
  if (!trades || trades.length === 0) return null;
  const perContract = trades.map((t) => t.pnl / (t.contracts || 1));
  const n = perContract.length;
  const wins = perContract.filter((p) => p > 0);
  const losses = perContract.filter((p) => p < 0);
  const winRate = wins.length / n;
  const avgWin = wins.length ? wins.reduce((a, b) => a + b, 0) / wins.length : 0;
  const avgLoss = losses.length ? Math.abs(losses.reduce((a, b) => a + b, 0) / losses.length) : 0;

  let ruinCount = 0;
  const troughs = [];
  for (let s = 0; s < numSims; s++) {
    let cum = 0, trough = 0, ruined = false;
    for (let i = 0; i < numTrades; i++) {
      cum += Math.random() < winRate ? avgWin : -avgLoss;
      if (cum < trough) trough = cum;
      if (cum <= -buffer) { ruined = true; break; }
    }
    if (ruined) ruinCount++;
    troughs.push(trough);
  }
  troughs.sort((a, b) => a - b);

  return {
    n, winRate, avgWin, avgLoss, buffer, numTrades, numSims,
    ror: ruinCount / numSims,
    medianTrough: troughs[Math.floor(troughs.length / 2)],
    worstTrough: troughs[0],
    lowSample: n < minTrades,
  };
}

// ---------- consecutive loss streak probability ----------
//
// "Given this strategy's actual loss rate, what's the probability of
// hitting a losing streak of length L within the next N trades?" This is
// the direct mathematical reason martingale sizing is dangerous — a streak
// that "shouldn't happen" is usually far more likely than it feels. Exact
// (not simulated): a small dynamic-programming pass over streak-length
// states, verified against both a known closed-form identity and an
// independent Monte Carlo cross-check.
function streakProbability(lossRate, streakLen, numTrades) {
  const p = 1 - lossRate;
  let dp = new Array(streakLen).fill(0);
  dp[0] = 1;
  for (let i = 0; i < numTrades; i++) {
    const next = new Array(streakLen).fill(0);
    const alive = dp.reduce((a, b) => a + b, 0);
    next[0] = alive * p;
    for (let s = 1; s < streakLen; s++) next[s] = dp[s - 1] * lossRate;
    dp = next;
  }
  const stillAlive = dp.reduce((a, b) => a + b, 0);
  return 1 - stillAlive;
}

function computeStreakProbabilities(trades, { streakLens = [3, 4, 5, 6, 7, 8], numTrades = 100, minTrades = 10 } = {}) {
  if (!trades || trades.length === 0) return null;
  const perContract = trades.map((t) => t.pnl / (t.contracts || 1));
  const n = perContract.length;
  const losses = perContract.filter((p) => p < 0);
  const lossRate = losses.length / n;
  const probabilities = {};
  streakLens.forEach((L) => { probabilities[L] = streakProbability(lossRate, L, numTrades); });
  return { n, lossRate, numTrades, probabilities, lowSample: n < minTrades };
}

// Wilson score interval for a binomial proportion (k successes out of n) — used
// wherever a win rate is shown for a bucket small enough that the raw percentage
// alone would overstate how well it's actually known. Standard 95% (z=1.96)
// unless told otherwise. Verified against textbook values (k=5,n=10 -> ~[24%,76%];
// k=50,n=100 -> ~[40%,60%]) before being wired in here.
function wilsonInterval(k, n, z = 1.96) {
  if (!n) return { phat: 0, lower: 0, upper: 1 };
  const phat = k / n;
  const z2 = z * z;
  const center = (phat + z2 / (2 * n)) / (1 + z2 / n);
  const margin = (z * Math.sqrt((phat * (1 - phat)) / n + z2 / (4 * n * n))) / (1 + z2 / n);
  return { phat, lower: Math.max(0, center - margin), upper: Math.min(1, center + margin) };
}

// ---------- strategy grading ----------
//
// Student's t critical values (two-tailed, 95%) by degrees of freedom —
// used to build a confidence interval on a strategy's expectancy itself
// (not just its win rate). Verified against known table values (df=9 ->
// 2.262, df=24 -> 2.064, etc.) before being wired in. Falls back toward
// the normal-distribution value (1.96) as sample size grows.
const T_TABLE_95 = {
  1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571, 6: 2.447, 7: 2.365, 8: 2.306, 9: 2.262, 10: 2.228,
  11: 2.201, 12: 2.179, 13: 2.160, 14: 2.145, 15: 2.131, 16: 2.120, 17: 2.110, 18: 2.101, 19: 2.093, 20: 2.086,
  21: 2.080, 22: 2.074, 23: 2.069, 24: 2.064, 25: 2.060, 26: 2.056, 27: 2.052, 28: 2.048, 29: 2.045, 30: 2.042,
  40: 2.021, 60: 2.000, 120: 1.980,
};
function tCritical95(df) {
  if (df < 1) return T_TABLE_95[1];
  if (df <= 30) return T_TABLE_95[df];
  if (df <= 40) return T_TABLE_95[40];
  if (df <= 60) return T_TABLE_95[60];
  if (df <= 120) return T_TABLE_95[120];
  return 1.96;
}

// Grades a strategy on whether its edge is real (not just lucky) and, if so,
// how good it is — folding in the stats that matter most rather than one
// number in isolation:
//   - Expectancy per contract, with a Student's-t 95% confidence interval —
//     this is the "is the edge real" test. A strategy can look profitable
//     and still have a CI that straddles zero, meaning the data can't yet
//     rule out that it's breaking even or worse.
//   - Profit factor — how much bigger the wins are than the losses.
//   - Calmar-like ratio (total P&L ÷ max drawdown) — reward relative to the
//     worst equity dip actually lived through, not just the total.
//   - Sample size — reuses the same 10-trade "low sample" bar used
//     everywhere else in this app (Daily Loss Limit, Risk of Ruin,
//     Consecutive Loss). A grade can't reach A/B on fewer than that many
//     trades no matter how good the early numbers look.
// Everything is computed on the flat 1-contract-normalized trade list, so
// size doesn't distort the comparison across strategies.
function computeStrategyGrade(trades, { minTrades = 10, settings = null } = {}) {
  if (!trades || trades.length === 0) return null;
  const flat = flattenTrades(trades, 1);
  const perTrade = flat.map((t) => t.pnl);
  const n = perTrade.length;
  const mean = perTrade.reduce((a, b) => a + b, 0) / n;
  const variance = n > 1 ? perTrade.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1) : 0;
  const stdev = Math.sqrt(variance);
  const se = n > 1 ? stdev / Math.sqrt(n) : 0;
  const tcrit = tCritical95(Math.max(n - 1, 1));
  const ciLower = mean - tcrit * se;
  const ciUpper = mean + tcrit * se;
  const significance = n > 1 ? (ciLower > 0 ? "confirmed_positive" : ciUpper < 0 ? "confirmed_negative" : "inconclusive") : "inconclusive";

  const stats = calcStats(flat);
  const calmar = stats.maxDD > 0 ? stats.totalPnl / stats.maxDD : (stats.totalPnl > 0 ? Infinity : 0);
  const strongPF = stats.profitFactor === Infinity || (stats.profitFactor !== null && stats.profitFactor >= 1.5);
  const strongCalmar = calmar === Infinity || calmar >= 2;
  const lowSample = n < minTrades;

  let grade;
  const reasons = [];
  if (significance === "confirmed_negative") {
    grade = "F";
    reasons.push(`Edge confirmed negative — 95% CI on expectancy is ${money(ciLower)} to ${money(ciUpper)}/contract, entirely below zero.`);
  } else if (significance === "confirmed_positive") {
    grade = (strongPF && strongCalmar && !lowSample) ? "A" : "B";
    reasons.push(`Edge confirmed positive — 95% CI on expectancy is ${money(ciLower)} to ${money(ciUpper)}/contract.`);
    reasons.push(`Profit factor ${stats.profitFactor === Infinity ? "∞" : stats.profitFactor.toFixed(2)} (${strongPF ? "strong" : "moderate"}).`);
    reasons.push(`P&L ÷ max drawdown ${calmar === Infinity ? "∞" : calmar.toFixed(2)} (${strongCalmar ? "strong" : "moderate"}).`);
  } else {
    grade = mean >= 0 ? "C" : "D";
    reasons.push(`Edge not yet statistically distinguishable from zero — 95% CI on expectancy is ${money(ciLower)} to ${money(ciUpper)}/contract.`);
  }
  if (lowSample && (grade === "A" || grade === "B")) {
    grade = "C";
    reasons.push(`Capped at C: under ${minTrades} trades isn't a reliable enough sample to call the edge confirmed yet, whatever the CI says.`);
  }
  // Fees are already inside every number above (stored P&L is net), so the
  // grade is an after-fees grade. These lines show how much of the gross
  // edge fees took, and call out the case where fees are the whole story.
  const totalFees = trades.reduce((sum, t) => sum + (Number(t.fees) || 0), 0);
  const grossPnl = stats.totalPnl + totalFees;
  const feeShare = grossPnl > 0 ? (totalFees / grossPnl) * 100 : null;
  const grossMean = trades.reduce((sum, t) => sum + ((t.pnl + (Number(t.fees) || 0)) / (t.contracts || 1)), 0) / n;
  const missingFeeCount = settings
    ? trades.filter((t) => Number(settings[t.market]?.feePerContract) > 0 && !(Number(t.fees) > 0)).length
    : 0;
  if (totalFees > 0) {
    reasons.push(`Graded after fees: ${money(totalFees)} in fees${feeShare !== null ? ` took ${feeShare.toFixed(1)}% of ${money(grossPnl)} gross P&L` : ` on ${money(grossPnl)} gross P&L`}.`);
    if (grossMean > 0 && mean <= 0) reasons.push(`Profitable before fees (${money(grossMean)}/contract) but not after (${money(mean)}/contract) — fees are what's holding this grade down.`);
    else if (grossMean > 0 && significance !== "confirmed_positive") reasons.push(`Fees cost ${money(grossMean - mean)}/contract of a ${money(grossMean)}/contract gross edge — the after-fees edge isn't confirmed yet.`);
  }
  if (missingFeeCount > 0) reasons.push(`${missingFeeCount} trade${missingFeeCount === 1 ? "" : "s"} in a market with a fee set ${missingFeeCount === 1 ? "has" : "have"} no fee recorded, so this grade is still flattered by them — use "Apply to existing trades" in Contract Settings to include them.`);
  if (lowSample) reasons.push(`${n} trade${n === 1 ? "" : "s"} logged — treat this grade as provisional until it clears ${minTrades}.`);
  else reasons.push(`${n} trades logged.`);

  return {
    grade, n, mean, ciLower, ciUpper, significance, lowSample,
    profitFactor: stats.profitFactor, calmar, totalPnl: stats.totalPnl,
    winRate: stats.winRate, maxDD: stats.maxDD, reasons,
    totalFees, grossPnl, feeShare, grossMean, missingFeeCount,
  };
}

const GRADE_COLORS = {
  A: "#0B8F63", B: "#4FB38A", C: "#E0A100", D: "#E8761F", F: "#D5303F",
};

function GradeBadge({ grade, size = "md" }) {
  if (!grade) return null;
  const color = GRADE_COLORS[grade.grade] || "var(--text-dim)";
  const dims = size === "sm" ? { w: 22, h: 22, fs: 12 } : { w: 30, h: 30, fs: 15 };
  return (
    <span
      title={grade.reasons ? grade.reasons.join(" ") : undefined}
      style={{
        display: "inline-flex", alignItems: "center", justifyContent: "center",
        width: dims.w, height: dims.h, borderRadius: 7,
        background: `${color}26`, border: `1px solid ${color}66`, color,
        fontFamily: "'Inter', sans-serif", fontWeight: 700, fontSize: dims.fs,
        flexShrink: 0,
      }}
    >
      {grade.grade}
    </span>
  );
}

function StrategyGradePanel({ grade }) {
  const color = GRADE_COLORS[grade.grade] || "var(--text-dim)";
  const gradeName = { A: "Confirmed edge, strong", B: "Confirmed edge, moderate", C: "Inconclusive — leaning positive", D: "Inconclusive — leaning negative", F: "Confirmed negative edge" }[grade.grade] || "";

  return (
    <div className="fj-panel">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, marginBottom: 4 }}>
        <p className="fj-panel-title" style={{ margin: 0 }}>Strategy grade</p>
        {grade.lowSample && <span className="fj-badge eval" title="Under 10 trades — this grade is provisional">Low sample</span>}
      </div>
      <div className="fj-sub" style={{ marginBottom: 14 }}>
        Grades whether this strategy's edge is statistically real, not just how good the raw numbers look — a strategy can be profitable so far and still not be distinguishable from noise yet.
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 16, flexWrap: "wrap" }}>
        <span
          style={{
            display: "inline-flex", alignItems: "center", justifyContent: "center",
            width: 56, height: 56, borderRadius: 12,
            background: `${color}26`, border: `1.5px solid ${color}66`, color,
            fontFamily: "'Inter', sans-serif", fontWeight: 700, fontSize: 28,
          }}
        >
          {grade.grade}
        </span>
        <div>
          <div style={{ fontFamily: "Inter, sans-serif", fontWeight: 600, fontSize: 14, color: "var(--text-bright)" }}>{gradeName}</div>
          <div className="fj-sub" style={{ marginTop: 2 }}>
            {money(grade.mean)}/contract expectancy · 95% CI {money(grade.ciLower)} to {money(grade.ciUpper)}
          </div>
        </div>
      </div>

      <div className="fj-stat-grid" style={{ marginBottom: 14 }}>
        <div className="fj-stat-card">
          <div className="fj-stat-label">Profit factor</div>
          <div className="fj-stat-value" style={{ fontSize: 15 }}>{grade.profitFactor === null ? "—" : grade.profitFactor === Infinity ? "∞" : grade.profitFactor.toFixed(2)}</div>
        </div>
        <div className="fj-stat-card">
          <div className="fj-stat-label">P&amp;L ÷ max drawdown</div>
          <div className="fj-stat-value" style={{ fontSize: 15 }}>{grade.calmar === Infinity ? "∞" : grade.calmar.toFixed(2)}</div>
        </div>
        <div className="fj-stat-card">
          <div className="fj-stat-label">Win rate</div>
          <div className="fj-stat-value" style={{ fontSize: 15 }}>{pct(grade.winRate)}</div>
        </div>
        <div className="fj-stat-card">
          <div className="fj-stat-label">Fees paid</div>
          <div className={`fj-stat-value ${grade.totalFees > 0 ? "fj-loss" : ""}`} style={{ fontSize: 15 }}>{money(-grade.totalFees)}</div>
        </div>
        <div className="fj-stat-card">
          <div className="fj-stat-label">Fees % of gross P&amp;L</div>
          <div className="fj-stat-value" style={{ fontSize: 15 }}>{grade.feeShare === null ? "—" : `${grade.feeShare.toFixed(1)}%`}</div>
        </div>
        <div className="fj-stat-card">
          <div className="fj-stat-label">Sample size</div>
          <div className={`fj-stat-value ${grade.lowSample ? "fj-loss" : ""}`} style={{ fontSize: 15 }}>{grade.n} trade{grade.n === 1 ? "" : "s"}</div>
        </div>
      </div>

      <ul style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 4 }}>
        {grade.reasons.map((r, i) => (
          <li key={i} className="fj-sub" style={{ fontSize: 12 }}>{r}</li>
        ))}
      </ul>
    </div>
  );
}

// ---------- stats by martingale depth (1x / 2x / 4x...) ----------
//
// Buckets a strategy's trades by size relative to its own detected base size
// (same "smallest contract count actually traded" convention used by the
// Optimizer), so 1x/2x/4x lines up with the martingale steps that produced
// them regardless of what the base itself happens to be. Every per-trade
// number is normalized to a single contract (pnl / contracts) before being
// compared across buckets — a 4x trade's raw $ swing is mechanically bigger
// than a 1x trade's, so only the normalized numbers say anything about
// whether the SIZE itself is working.
function computeMartingaleDepthStats(trades, { minTrades = 10 } = {}) {
  if (!trades || trades.length === 0) return null;
  const sizes = trades.map((t) => t.contracts || 1).filter((c) => c > 0);
  const base = sizes.length ? Math.min(...sizes) : 1;

  const buckets = {};
  trades.forEach((t) => {
    const c = t.contracts || 1;
    const ratio = Math.max(c / base, 1);
    const depth = Math.max(0, Math.round(Math.log2(ratio)));
    (buckets[depth] = buckets[depth] || []).push(t);
  });

  const depths = Object.keys(buckets).map(Number).sort((a, b) => a - b);
  const overall = calcStats(trades);
  const overallExpectancyPerContract =
    trades.reduce((s, t) => s + t.pnl / (t.contracts || 1), 0) / trades.length;

  const rows = depths.map((depth) => {
    const bucketTrades = buckets[depth];
    const n = bucketTrades.length;
    const wins = bucketTrades.filter((t) => t.pnl > 0);
    const losses = bucketTrades.filter((t) => t.pnl < 0);
    const totalPnl = bucketTrades.reduce((s, t) => s + t.pnl, 0);
    const expectancyPerContract = bucketTrades.reduce((s, t) => s + t.pnl / (t.contracts || 1), 0) / n;
    const avgWinPerContract = wins.length
      ? wins.reduce((s, t) => s + t.pnl / (t.contracts || 1), 0) / wins.length
      : 0;
    const avgLossPerContract = losses.length
      ? losses.reduce((s, t) => s + t.pnl / (t.contracts || 1), 0) / losses.length
      : 0;
    const winRate = (wins.length / n) * 100;
    const ci = wilsonInterval(wins.length, n);
    return {
      depth,
      label: `${Math.pow(2, depth)}x`,
      contractsAtDepth: base * Math.pow(2, depth),
      n, wins: wins.length, losses: losses.length,
      winRate, ciLower: ci.lower * 100, ciUpper: ci.upper * 100,
      totalPnl, expectancyPerContract, avgWinPerContract, avgLossPerContract,
      lowSample: n < minTrades,
    };
  });

  return { base, overallWinRate: overall.winRate, overallExpectancyPerContract, rows };
}

// Recomputes a trade list as if every trade had been taken at a flat size
// instead of whatever it was actually sized at — the baseline every other
// comparison here (martingale impact, risk of ruin, depth sweep) is
// measured against.
function flattenTrades(trades, sizeMultiplier = 1) {
  return trades.map((t) => ({ ...t, contracts: 1, pnl: (t.pnl / (t.contracts || 1)) * sizeMultiplier }));
}

// Simulates a theoretical capped martingale on top of a strategy's own
// win/loss sequence: each trade is replayed in time order at the stated
// base size, doubling after every consecutive loss and resetting to base
// after a win, never exceeding baseContracts * capMultiplier. Each trade's
// per-contract P&L is taken from the trade itself (P&L / contracts), so
// this works whether the strategy was actually traded flat at 1 contract
// or was already martingaled — the sizing is imposed by the simulation,
// not read from what was traded. A scratch (exactly 0) leaves the streak
// unchanged.
function simulateCappedMartingale(trades, baseContracts, capMultiplier) {
  const sorted = [...trades].sort(
    (a, b) => new Date(`${a.date}T${a.time || "00:00"}`) - new Date(`${b.date}T${b.time || "00:00"}`)
  );
  let lossStreak = 0;
  return sorted.map((t) => {
    const perContract = t.pnl / (t.contracts || 1);
    const mult = Math.min(Math.pow(2, lossStreak), capMultiplier);
    const contracts = baseContracts * mult;
    if (perContract < 0) lossStreak += 1;
    else if (perContract > 0) lossStreak = 0;
    return { ...t, contracts, pnl: perContract * contracts };
  });
}

// Sweeps that simulation across caps — "max of 1x" (flat, no martingale)
// up through "max of 16x" (5-level doubling) — so you can see what each
// cap would have done to this strategy's own trade sequence.
function computeMartingaleCapSweep(trades, { baseContracts = 1, caps = [1, 2, 4, 8, 16] } = {}) {
  if (!trades || trades.length === 0) return [];
  return caps.map((capMultiplier) => {
    const simulated = simulateCappedMartingale(trades, baseContracts, capMultiplier);
    return {
      capMultiplier,
      maxContracts: baseContracts * capMultiplier,
      stats: calcStats(simulated),
    };
  });
}

// ---------- martingale depth sweep ----------
//
// Models a real capped martingale: sizing doubles (base, 2x, 4x...) up to
// a stated cap depth, and any further losses in the SAME streak stay flat
// at that cap rather than continuing to double forever. That's how a real
// "caps at 4 contracts" rule behaves — earlier versions of this assumed
// unlimited doubling, which overstated cost for streaks longer than the
// cap and doesn't match a strategy that's actually capped.
//
// Rows are indexed by streak length (how many losses in a row — the same
// thing "Longest loss streak" on the stat grid measures), not by doubling
// depth, since those aren't the same axis once a cap is in play.
function costOfCappedStreak(avgLossPerContract, baseContracts, streakLen, capDepth) {
  let units = 0;
  for (let i = 1; i <= streakLen; i++) {
    units += Math.min(Math.pow(2, i - 1), Math.pow(2, capDepth - 1));
  }
  return avgLossPerContract * baseContracts * units;
}

function computeMartingaleDepthSweep(trades, { baseContracts = 1, capDepth = 3, buffer, numTrades = 100, maxStreak = 8 } = {}) {
  if (!trades || trades.length === 0) return null;
  const flat = flattenTrades(trades, 1);
  const n = flat.length;
  const losses = flat.filter((t) => t.pnl < 0);
  const lossRate = losses.length / n;
  const avgLossPerContract = losses.length ? Math.abs(losses.reduce((a, b) => a + b.pnl, 0) / losses.length) : 0;

  const rows = [];
  for (let streakLen = 1; streakLen <= maxStreak; streakLen++) {
    const contractsAtEnd = baseContracts * Math.min(Math.pow(2, streakLen - 1), Math.pow(2, capDepth - 1));
    const streakCost = costOfCappedStreak(avgLossPerContract, baseContracts, streakLen, capDepth);
    const probability = streakProbability(lossRate, streakLen, numTrades);
    rows.push({
      streakLen, contractsAtEnd, streakCost, probability,
      fitsBuffer: buffer ? streakCost <= buffer : null,
    });
  }
  return { n, lossRate, avgLossPerContract, baseContracts, capDepth, numTrades, buffer, rows };
}

// ---------- stats ----------

function calcStats(trades) {
  const n = trades.length;
  const base = {
    n, totalPnl: 0, winRate: 0, avgWin: 0, avgLoss: 0,
    profitFactor: null, expectancy: 0, maxDD: 0,
    largestWin: 0, largestLoss: 0, wins: 0, losses: 0, scratches: 0,
    maxWinStreak: 0, maxLossStreak: 0,
    totalFees: 0, grossPnl: 0,
  };
  if (n === 0) return base;

  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl < 0);
  const scratches = trades.filter((t) => t.pnl === 0);
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  // Stored P&L is already net of fees, so fees are tracked alongside it
  // rather than subtracted again — gross is just net plus fees paid.
  const totalFees = trades.reduce((s, t) => s + (Number(t.fees) || 0), 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));

  const sorted = [...trades].sort(
    (a, b) => new Date(`${a.date}T${a.time || "00:00"}`) - new Date(`${b.date}T${b.time || "00:00"}`)
  );
  let equity = 0, peak = 0, maxDD = 0;
  let curWinStreak = 0, maxWinStreak = 0, curLossStreak = 0, maxLossStreak = 0;
  sorted.forEach((t) => {
    equity += t.pnl;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDD) maxDD = dd;

    if (t.pnl > 0) { curWinStreak += 1; curLossStreak = 0; }
    else if (t.pnl < 0) { curLossStreak += 1; curWinStreak = 0; }
    else { curWinStreak = 0; curLossStreak = 0; }
    if (curWinStreak > maxWinStreak) maxWinStreak = curWinStreak;
    if (curLossStreak > maxLossStreak) maxLossStreak = curLossStreak;
  });

  return {
    n,
    totalPnl,
    totalFees,
    grossPnl: totalPnl + totalFees,
    winRate: (wins.length / n) * 100,
    avgWin: wins.length ? grossProfit / wins.length : 0,
    avgLoss: losses.length ? grossLoss / losses.length : 0,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : null,
    expectancy: totalPnl / n,
    maxDD,
    largestWin: wins.length ? Math.max(...wins.map((t) => t.pnl)) : 0,
    largestLoss: losses.length ? Math.min(...losses.map((t) => t.pnl)) : 0,
    wins: wins.length,
    losses: losses.length,
    scratches: scratches.length,
    maxWinStreak,
    maxLossStreak,
  };
}

function equityCurve(trades) {
  if (trades.length === 0) return [];
  const sorted = [...trades].sort(
    (a, b) => new Date(`${a.date}T${a.time || "00:00"}`) - new Date(`${b.date}T${b.time || "00:00"}`)
  );
  let equity = 0;
  let gross = 0;
  const points = [{ i: 0, date: sorted[0].date, equity: 0, gross: 0 }];
  sorted.forEach((t, idx) => {
    equity += t.pnl;
    gross += t.pnl + (Number(t.fees) || 0);
    points.push({ i: idx + 1, date: t.date, equity: Number(equity.toFixed(2)), gross: Number(gross.toFixed(2)) });
  });
  return points;
}

// Builds one merged dataset for the portfolio chart: a "portfolio" series plus
// one series per strategy, all sharing the same x-axis (trade sequence).
// Each strategy's value carries forward (stays flat) between its own trades,
// so every line is defined at every point even though strategies don't trade
// on the same days.
function buildMultiEquityCurve(trades, strategyList) {
  if (!trades || trades.length === 0) return [];
  const sorted = [...trades].sort(
    (a, b) => new Date(`${a.date}T${a.time || "00:00"}`) - new Date(`${b.date}T${b.time || "00:00"}`)
  );
  let portfolioEq = 0;
  let portfolioGross = 0;
  const stratEq = {};
  strategyList.forEach((s) => { stratEq[s] = 0; });

  const firstRow = { i: 0, date: sorted[0].date, portfolio: 0, gross: 0 };
  strategyList.forEach((s) => { firstRow[s] = 0; });
  const rows = [firstRow];

  sorted.forEach((t, idx) => {
    portfolioEq += t.pnl;
    portfolioGross += t.pnl + (Number(t.fees) || 0);
    if (t.strategy && Object.prototype.hasOwnProperty.call(stratEq, t.strategy)) {
      stratEq[t.strategy] += t.pnl;
    }
    const row = { i: idx + 1, date: t.date, portfolio: Number(portfolioEq.toFixed(2)), gross: Number(portfolioGross.toFixed(2)) };
    strategyList.forEach((s) => { row[s] = Number(stratEq[s].toFixed(2)); });
    rows.push(row);
  });
  return rows;
}

// ---------- account drawdown engine ----------
//
// Common prop-firm accounts don't use a flat minimum balance — the floor
// moves. Two mechanics matter:
//  - EOD (end-of-day): the floor only recalculates once, at session close,
//    based on the highest EOD balance ever reached.
//  - Intraday: the floor recalculates continuously off the peak balance
//    (we approximate this with realized trade P&L since we don't have
//    tick-level unrealized equity — noted in the UI).
//  - Static: the floor never moves from starting balance - drawdown amount.
// Most trailing accounts also "lock" once the floor reaches a certain
// level (commonly the profit target, or the original starting balance) —
// after that point they behave like a static floor.

function buildAccountBalanceTimeline(account, trades) {
  // Excludes copied trades ("Copy to strategy" in the Trade Log) — a copy
  // defaults to the same account(s) as its original, and it isn't a second
  // real fill, so it must never move a real account's balance or drawdown.
  const taggedTrades = trades.filter((t) => !t._isCopy && (t.accounts || []).includes(account.name));
  const byDate = {};
  taggedTrades.forEach((t) => { byDate[t.date] = (byDate[t.date] || 0) + t.pnl; });

  const dates = Object.keys(byDate).sort();
  let running = account.startingBalance;
  const timeline = [];
  dates.forEach((date) => {
    running += byDate[date];
    timeline.push({ date, balance: Number(running.toFixed(2)) });
  });

  const rawCurrentBalance = timeline.length ? timeline[timeline.length - 1].balance : account.startingBalance;
  const priorDayBalance = timeline.length >= 2 ? timeline[timeline.length - 2].balance : account.startingBalance;
  const peakBalance = Math.max(account.startingBalance, ...timeline.map((t) => t.balance));
  const totalPaidOut = (account.payouts || []).reduce((s, p) => s + p.amount, 0);
  const totalAdjustments = (account.adjustments || []).reduce((s, a) => s + a.amount, 0);
  const currentBalance = Number((rawCurrentBalance - totalPaidOut + totalAdjustments).toFixed(2));

  return {
    timeline, currentBalance, priorDayBalance, peakBalance, totalPaidOut, totalAdjustments,
    tradingPnl: taggedTrades.reduce((s, t) => s + t.pnl, 0),
  };
}

// Builds the true balance-over-time curve for charting — merges trading
// P&L, payouts, and manual adjustments chronologically, one point per
// event (per trade, not per day) — same granularity as the strategy
// sparklines, so the line actually shows each trade's movement instead of
// smoothing a day's trades into a single net point. This is separate from
// buildAccountBalanceTimeline's trading-only timeline, which is kept
// isolated deliberately so the trailing-drawdown floor calc isn't affected
// by withdrawals or corrections.
function buildAccountEquityCurve(account, trades) {
  const taggedTrades = trades.filter((t) => !t._isCopy && (t.accounts || []).includes(account.name));
  const events = [
    ...taggedTrades.map((t) => ({ date: t.date, time: t.time || "00:00", amount: t.pnl })),
    ...(account.payouts || []).map((p) => ({ date: p.date, time: "00:00", amount: -p.amount })),
    ...(account.adjustments || []).map((a) => ({ date: a.date, time: "00:00", amount: a.amount })),
  ].sort((a, b) => new Date(`${a.date}T${a.time}`) - new Date(`${b.date}T${b.time}`));

  let running = account.startingBalance;
  const points = [{ i: 0, date: events[0]?.date || null, balance: Number(running.toFixed(2)) }];
  events.forEach((e, idx) => {
    running += e.amount;
    points.push({ i: idx + 1, date: e.date, balance: Number(running.toFixed(2)) });
  });
  return points;
}

function computeAccountFloor(account, timelineData) {
  const { peakBalance, totalPaidOut } = timelineData;
  const drawdownAmount = Number(account.drawdownAmount) || 0;
  const profitTarget = Number(account.profitTarget) || 0;
  const base = account.startingBalance - drawdownAmount;

  // Backward compatibility: accounts created before this feature only have
  // a flat `minimum`. If no drawdown amount is set, fall back to that.
  if (!drawdownAmount) {
    return { floor: (account.minimum || 0) - totalPaidOut, locked: true, mode: "static" };
  }

  if (account.drawdownType === "static") {
    return { floor: base - totalPaidOut, locked: true, mode: "static" };
  }

  const lockLevel =
    account.trailingLock === "starting" ? account.startingBalance
    : account.trailingLock === "none" ? Infinity
    : account.startingBalance + profitTarget; // default: lock at profit target

  const cappedPeak = Math.min(peakBalance, lockLevel);
  const dynamicFloor = cappedPeak - drawdownAmount;
  const floor = Math.max(base, dynamicFloor) - totalPaidOut;
  const locked = lockLevel !== Infinity && cappedPeak >= lockLevel;

  return { floor: Number(floor.toFixed(2)), locked, mode: account.drawdownType === "intraday" ? "intraday" : "eod" };
}

// ---------- storage ----------


async function loadJSON(key, fallback) {
  try {
    const res = await window.storage.get(key, false);
    if (res && res.value) return JSON.parse(res.value);
    return fallback;
  } catch {
    return fallback;
  }
}
async function saveJSON(key, value) {
  try {
    await window.storage.set(key, JSON.stringify(value), false);
  } catch {
    // ignore write failures silently — UI still works in-memory this session
  }
}

// ---------- main component ----------

export default function TradingJournal() {
  const [ready, setReady] = useState(false);
  const [trades, setTrades] = useState([]);
  const [showSignalImport, setShowSignalImport] = useState(false);
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [accounts, setAccounts] = useState([]);
  const [notes, setNotes] = useState([]);

  const [view, setView] = useState("home"); // home | calendar | accounts | log | timeline | optimizer
  const [selectedEntity, setSelectedEntity] = useState(null); // { type: 'strategy'|'market', key } | null
  const [showForm, setShowForm] = useState(false);
  const [showBulkForm, setShowBulkForm] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [showSettings, setShowSettings] = useState(false);

  const [importPreview, setImportPreview] = useState(null); // { parsed, errorCount, total }
  const fileInputRef = useRef(null);
  const [restorePreview, setRestorePreview] = useState(null); // { data, tradeCount, accountCount } | { error }
  const backupFileInputRef = useRef(null);
  const [tradovateImport, setTradovateImport] = useState(null); // { parsedRows, newMarkets } | { error }
  const tradovateFileInputRef = useRef(null);
  const [ninjaImport, setNinjaImport] = useState(null); // { parsedRows, newMarkets } | { error }
  const ninjaFileInputRef = useRef(null);
  const [theme, setTheme] = useState("dark"); // "dark" | "light"

  useEffect(() => {
    (async () => {
      const [t, s, a, n, th] = await Promise.all([
        loadJSON(TRADES_KEY, []),
        loadJSON(SETTINGS_KEY, DEFAULT_SETTINGS),
        loadJSON(ACCOUNTS_KEY, []),
        loadJSON(NOTES_KEY, []),
        loadJSON(THEME_KEY, "dark"),
      ]);
      setTrades(t);
      setSettings(seedFeeDefaults({ ...DEFAULT_SETTINGS, ...s }));
      setAccounts(a);
      setNotes(n);
      setTheme(th === "light" ? "light" : "dark");
      setReady(true);
    })();
  }, []);

  useEffect(() => { if (ready) saveJSON(TRADES_KEY, trades); }, [trades, ready]);
  useEffect(() => { if (ready) saveJSON(SETTINGS_KEY, settings); }, [settings, ready]);
  useEffect(() => { if (ready) saveJSON(ACCOUNTS_KEY, accounts); }, [accounts, ready]);
  useEffect(() => { if (ready) saveJSON(NOTES_KEY, notes); }, [notes, ready]);
  useEffect(() => { if (ready) saveJSON(THEME_KEY, theme); }, [theme, ready]);

  const strategies = useMemo(
    () => Array.from(new Set(trades.map((t) => t.strategy).filter(Boolean))).sort(),
    [trades]
  );

  const handleSave = (trade) => {
    setTrades((prev) => {
      if (editingId) return prev.map((t) => (t.id === editingId ? { ...t, ...trade, id: editingId } : t));
      return [...prev, { ...trade, id: uid() }];
    });
    setShowForm(false);
    setEditingId(null);
  };

  const handleDelete = (id) => setTrades((prev) => prev.filter((t) => t.id !== id));
  const startEdit = (t) => { setEditingId(t.id); setShowForm(true); };

  // Manually log several trades at once from one form, instead of opening
  // "Add trade" over and over for a single-trade-at-a-time entry.
  const handleBulkAdd = (newTrades) => {
    setTrades((prev) => [...prev, ...newTrades.map((t) => ({ ...t, id: uid() }))]);
    setShowBulkForm(false);
  };

  // Bulk-reassign fields (strategy and/or accounts) across a set of already-logged
  // trades at once — same idea as the bulk-tagging step in the Tradovate import
  // flow, but for trades already sitting in the log.
  const handleBulkUpdate = (ids, patch) => {
    const idSet = new Set(ids);
    setTrades((prev) => prev.map((t) => (idSet.has(t.id) ? { ...t, ...patch } : t)));
  };

  // Duplicates a set of trades into a new strategy (and/or account), leaving
  // the originals untouched — e.g. keep M1 NQ trades in their original
  // strategy but also see them, unmixed with anything before the change,
  // under a new strategy name after tweaking the rules. Copies are tagged
  // with _isCopy so every portfolio-wide total (overall stats, market
  // totals, account balances/drawdown) counts the underlying trade once —
  // only that trade's own strategy page counts the copy.
  // Attach signal data to the matched trades, and to any copies of them in
  // other strategies (a copy has the same entry, so the same signal).
  const applySignalData = (byId) => {
    setTrades((prev) => prev.map((t) => {
      if (byId.has(t.id)) { return { ...t, adv: byId.get(t.id) }; }
      if (t._copiedFrom && byId.has(t._copiedFrom)) return { ...t, adv: byId.get(t._copiedFrom) };
      return t;
    }));
    let c = 0;
    trades.forEach((t) => { if (!byId.has(t.id) && t._copiedFrom && byId.has(t._copiedFrom)) c++; });
    return { trades: byId.size, copies: c };
  };

  const handleBulkCopy = (ids, patch) => {
    const idSet = new Set(ids);
    setTrades((prev) => {
      const copies = prev.filter((t) => idSet.has(t.id)).map((t) => ({ ...t, ...patch, id: uid(), _isCopy: true, _copiedFrom: t.id }));
      return [...prev, ...copies];
    });
  };

  const addNote = (note) => setNotes((prev) => [...prev, { ...note, id: uid() }]);
  const updateNote = (id, patch) => setNotes((prev) => prev.map((n) => n.id === id ? { ...n, ...patch } : n));
  const deleteNote = (id) => setNotes((prev) => prev.filter((n) => n.id !== id));

  const handleExport = () => {
    const rows = trades.map((t) => ({
      date: t.date,
      time: t.time || "",
      market: t.market,
      strategy: t.strategy || "",
      accounts: (t.accounts || []).join("; "),
      direction: t.direction,
      contracts: t.contracts,
      entry: t.entry ?? "",
      exit: t.exit ?? "",
      fees: t.fees ?? 0,
      pnl: t.pnl,
      notes: t.notes || "",
    }));
    const csv = Papa.unparse(rows);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `trade-journal-export-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const triggerImport = () => fileInputRef.current?.click();

  const processImportRows = (rows) => {
    const parsed = [];
    let errorCount = 0;
    rows.forEach((row) => {
      const dateRaw = (row.date || row.Date || "").toString().trim();
      if (!dateRaw) { errorCount++; return; }
      let date = dateRaw;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        const d = new Date(dateRaw);
        if (isNaN(d.getTime())) { errorCount++; return; }
        date = d.toISOString().slice(0, 10);
      }
      const pnlRaw = row.pnl ?? row.PnL ?? row["P&L"] ?? row.PNL;
      const pnl = parseFloat(pnlRaw);
      if (Number.isNaN(pnl)) { errorCount++; return; }

      const marketRaw = (row.market || row.Market || "").toString().trim().toUpperCase();
      const direction = /short/i.test((row.direction || "").toString()) ? "Short" : "Long";
      const contracts = parseFloat(row.contracts) || 1;
      const entryVal = row.entry !== undefined && row.entry !== "" ? parseFloat(row.entry) : NaN;
      const exitVal = row.exit !== undefined && row.exit !== "" ? parseFloat(row.exit) : NaN;
      const fees = parseFloat(row.fees) || 0;

      parsed.push({
        id: uid(),
        date,
        time: (row.time || "").toString().trim(),
        market: marketRaw || "MES",
        strategy: (row.strategy || "").toString().trim(),
        accounts: (row.accounts || "").toString().split(";").map((s) => s.trim()).filter(Boolean),
        direction,
        contracts,
        entry: Number.isFinite(entryVal) ? entryVal : null,
        exit: Number.isFinite(exitVal) ? exitVal : null,
        fees,
        pnl,
        notes: (row.notes || "").toString().trim(),
      });
    });
    setImportPreview({ parsed, errorCount, total: rows.length });
  };

  const handleFileChange = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => processImportRows(results.data),
    });
    e.target.value = "";
  };

  const confirmImport = (mode) => {
    if (!importPreview) return;
    if (mode === "append") setTrades((prev) => [...prev, ...importPreview.parsed]);
    if (mode === "replace") { setTrades(importPreview.parsed); setSelectedEntity(null); setView("home"); }
    setImportPreview(null);
  };

  const triggerTradovateImport = () => tradovateFileInputRef.current?.click();

  const handleTradovateFileChange = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => {
        const headerRow = results.meta.fields || [];
        const looksLikeTradovate = TRADOVATE_REQUIRED_HEADERS.every((h) => headerRow.includes(h));
        if (!looksLikeTradovate) {
          setTradovateImport({ error: "This doesn't look like a Tradovate Performance export — expected columns like buyFillId, sellFillId, boughtTimestamp, soldTimestamp weren't found." });
          return;
        }
        const allParsedRows = [];
        let errorCount = 0;
        results.data.forEach((row) => {
          const parsed = parseTradovateRow(row);
          if (parsed) allParsedRows.push(parsed);
          else errorCount++;
        });
        if (allParsedRows.length === 0) {
          setTradovateImport({ error: `Couldn't parse any rows from this file${errorCount ? ` (${errorCount} row${errorCount === 1 ? "" : "s"} failed)` : ""}.` });
          return;
        }

        // Skip any round-turn whose fill-ID pair matches a trade already in
        // the journal, so re-uploading an overlapping export is safe.
        const alreadyImported = new Set(trades.map((t) => t._tvFingerprint).filter(Boolean));
        const parsedRows = allParsedRows.filter((r) => !r._fingerprint || !alreadyImported.has(r._fingerprint));
        const skippedCount = allParsedRows.length - parsedRows.length;
        if (parsedRows.length === 0) {
          setTradovateImport({ error: `Every trade in this file (${allParsedRows.length}) has already been imported — nothing new to add. You can safely re-export and re-upload any time; only new trades get pulled in.` });
          return;
        }
        const existingSymbols = new Set(Object.keys(settings));
        const newSymbols = Array.from(new Set(parsedRows.map((r) => r.market).filter((s) => !existingSymbols.has(s))));
        const newMarkets = newSymbols.map((symbol) => ({ symbol, ...guessMarketDefaults(symbol) }));

        // Tradovate's Performance export is gross of commissions, so apply
        // each market's per-contract fee from Contract Settings (falling
        // back to the known default for a market that's new to the journal).
        const feeFor = (r) => {
          const perContract = settings[r.market]?.feePerContract ?? newMarkets.find((m) => m.symbol === r.market)?.feePerContract ?? 0;
          return Number(((Number(perContract) || 0) * r.contracts).toFixed(2));
        };
        let feesApplied = 0;
        const rowsWithFees = parsedRows.map((r) => {
          const fees = feeFor(r);
          feesApplied += fees;
          return fees ? { ...r, fees, pnl: Number((r.pnl - fees).toFixed(2)) } : r;
        });
        setTradovateImport({ parsedRows: rowsWithFees, newMarkets, skippedCount, feesApplied: Number(feesApplied.toFixed(2)) });
      },
    });
    e.target.value = "";
  };

  const confirmTradovateImport = (finalRows) => {
    if (!tradovateImport || tradovateImport.error) return;
    const newTrades = finalRows.map((r) => ({
      id: uid(),
      date: r.date, time: r.time, market: r.market, strategy: r.strategy,
      accounts: r.accounts, direction: r.direction, contracts: r.contracts,
      entry: r.entry, exit: r.exit, fees: r.fees, pnl: r.pnl, notes: r.notes,
      durationSec: r.durationSec,
      _tvFingerprint: r._fingerprint || undefined,
    }));
    setTrades((prev) => [...prev, ...newTrades]);
    if (tradovateImport.newMarkets.length > 0) {
      setSettings((prev) => {
        const next = { ...prev };
        tradovateImport.newMarkets.forEach((m) => {
          if (!next[m.symbol]) {
            const accent = ACCENT_PALETTE[Object.keys(next).length % ACCENT_PALETTE.length];
            next[m.symbol] = { label: m.label, multiplier: m.multiplier, accent, category: m.category, feePerContract: m.feePerContract ?? 0 };
          }
        });
        return next;
      });
    }
    setTradovateImport(null);
  };

  const triggerNinjaImport = () => ninjaFileInputRef.current?.click();

  const handleNinjaFileChange = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => {
        const headerRow = results.meta.fields || [];
        const looksLikeNinjaTrader = NINJATRADER_REQUIRED_HEADERS.every((h) => headerRow.includes(h));
        if (!looksLikeNinjaTrader) {
          setNinjaImport({ error: "This doesn't look like a NinjaTrader Trades export — expected columns like Instrument, Action, Quantity, Price, Time, E/X weren't found. Make sure you exported the Trades grid, not Accounts." });
          return;
        }
        const { summaries: allSummaries, errorCount } = parseNinjaTraderRows(results.data);
        if (allSummaries.length === 0) {
          setNinjaImport({ error: `Couldn't find any completed round-turn trades in this file${errorCount ? ` (${errorCount} row${errorCount === 1 ? "" : "s"} failed to parse)` : ""}. Every trade needs both an Entry and a matching Exit fill in the export.` });
          return;
        }

        // NinjaTrader always exports the full history rather than a
        // date-filtered range, so re-uploading the same file (or a fresh
        // export that overlaps an old one) is the normal workflow. Skip
        // any position whose fingerprint (its fills' Order IDs) matches a
        // trade already sitting in the journal.
        const alreadyImported = new Set(
          trades.map((t) => t._ntFingerprint).filter(Boolean)
        );
        const summaries = allSummaries.filter((s) => !s.fingerprint || !alreadyImported.has(s.fingerprint));
        const skippedCount = allSummaries.length - summaries.length;

        if (summaries.length === 0) {
          setNinjaImport({ error: `Every completed trade in this file (${allSummaries.length}) has already been imported — nothing new to add. You can safely re-export and re-upload your full history any time; only new trades get pulled in.` });
          return;
        }

        const existingSymbols = new Set(Object.keys(settings));
        const newSymbols = Array.from(new Set(summaries.map((s) => s.root).filter((r) => !existingSymbols.has(r))));
        const newMarkets = newSymbols.map((symbol) => ({ symbol, ...guessMarketDefaults(symbol) }));
        const multiplierFor = (root) => settings[root]?.multiplier ?? newMarkets.find((m) => m.symbol === root)?.multiplier ?? 1;

        // Sim accounts export $0 commission, so fall back to the market's
        // per-contract fee from Contract Settings. A real commission in the
        // file always wins — never charge both.
        const feePerContractFor = (root) => settings[root]?.feePerContract ?? newMarkets.find((m) => m.symbol === root)?.feePerContract ?? 0;
        let feesApplied = 0;
        const parsedRows = summaries.map((s) => {
          const multiplier = multiplierFor(s.root);
          const dirSign = s.direction === "Long" ? 1 : -1;
          const fees = s.commission > 0 ? Number(s.commission.toFixed(2)) : Number(((Number(feePerContractFor(s.root)) || 0) * s.qty).toFixed(2));
          if (s.commission <= 0) feesApplied += fees;
          const pnl = Number((((s.exitPrice - s.entryPrice) * multiplier * s.qty * dirSign) - fees).toFixed(2));
          return {
            _entryMs: s.entryMs,
            _fingerprint: s.fingerprint,
            durationSec: s.durationSec,
            market: s.root,
            direction: s.direction,
            contracts: s.qty,
            entry: s.entryPrice,
            exit: s.exitPrice,
            fees,
            pnl,
            notes: [s.entryNames.join("/"), s.exitNames.join("/")].filter(Boolean).join(" → "),
            strategy: "",
            accounts: [],
          };
        });
        setNinjaImport({ parsedRows, newMarkets, skippedCount, feesApplied: Number(feesApplied.toFixed(2)) });
      },
    });
    e.target.value = "";
  };

  const confirmNinjaImport = (finalRows) => {
    if (!ninjaImport || ninjaImport.error) return;
    const newTrades = finalRows.map((r) => ({
      id: uid(),
      date: r.date, time: r.time, market: r.market, strategy: r.strategy,
      accounts: r.accounts, direction: r.direction, contracts: r.contracts,
      entry: r.entry, exit: r.exit, fees: r.fees, pnl: r.pnl, notes: r.notes,
      durationSec: r.durationSec,
      _ntFingerprint: r._fingerprint || undefined,
    }));
    setTrades((prev) => [...prev, ...newTrades]);
    if (ninjaImport.newMarkets.length > 0) {
      setSettings((prev) => {
        const next = { ...prev };
        ninjaImport.newMarkets.forEach((m) => {
          if (!next[m.symbol]) {
            const accent = ACCENT_PALETTE[Object.keys(next).length % ACCENT_PALETTE.length];
            next[m.symbol] = { label: m.label, multiplier: m.multiplier, accent, category: m.category, feePerContract: m.feePerContract ?? 0 };
          }
        });
        return next;
      });
    }
    setNinjaImport(null);
  };

  const handleBackup = () => {
    const payload = {
      kind: "position-ledger-backup",
      version: 1,
      exportedAt: new Date().toISOString(),
      trades,
      accounts,
      settings,
      notes,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `trade-journal-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const triggerRestore = () => backupFileInputRef.current?.click();

  const handleBackupFileChange = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (!data || typeof data !== "object" || (!Array.isArray(data.trades) && !Array.isArray(data.accounts))) {
          setRestorePreview({ error: "This doesn't look like a Position Ledger backup file." });
          return;
        }
        setRestorePreview({
          data,
          tradeCount: Array.isArray(data.trades) ? data.trades.length : 0,
          accountCount: Array.isArray(data.accounts) ? data.accounts.length : 0,
        });
      } catch {
        setRestorePreview({ error: "Couldn't read that file — make sure it's an unmodified backup JSON file." });
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  const confirmRestore = () => {
    if (!restorePreview || restorePreview.error) return;
    const { data } = restorePreview;
    setTrades(Array.isArray(data.trades) ? data.trades : []);
    setAccounts(Array.isArray(data.accounts) ? data.accounts : []);
    setSettings(seedFeeDefaults({ ...DEFAULT_SETTINGS, ...(data.settings || {}) }));
    setNotes(Array.isArray(data.notes) ? data.notes : []);
    setSelectedEntity(null);
    setView("home");
    setRestorePreview(null);
  };

  if (!ready) {
    return (
      <div style={{ background: "#14161B", color: "#8B929E", padding: 40, fontFamily: "monospace", minHeight: 300 }}>
        Loading journal…
      </div>
    );
  }

  const editingTrade = editingId ? trades.find((t) => t.id === editingId) : null;

  return (
    <div className="fj-root" data-theme={theme}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');

        .fj-root {
          --bg: #FFFFFF;
          --panel: #FFFFFF;
          --panel-alt: #F4F6F8;
          --border: #E3E8ED;
          --border-strong: #CBD3DB;
          --text: #1B2733;
          --text-bright: #0A1620;
          --text-dim: #66737F;
          --amber: #0B8F63;
          --accent-soft: rgba(11,143,99,0.10);
          --on-accent: #FFFFFF;
          --profit: #0B8F63;
          --loss: #D5303F;
          --profit-soft: rgba(11,143,99,0.10);
          --loss-soft: rgba(213,48,63,0.09);
          --shadow: 0 1px 2px rgba(10,22,32,0.04);
          --overlay: rgba(10,22,32,0.45);
          font-family: 'Inter', system-ui, -apple-system, sans-serif;
          font-variant-numeric: tabular-nums;
          -webkit-font-smoothing: antialiased;
          background: var(--bg);
          color: var(--text);
          padding: 0 max(20px, calc((100% - 1160px) / 2)) 56px;
          min-height: 100vh;
        }
        .fj-root[data-theme="dark"] {
          --bg: #0A0E11;
          --panel: #11161B;
          --panel-alt: #182027;
          --border: #222B33;
          --border-strong: #33404A;
          --text: #D9E1E8;
          --text-bright: #F3F6F8;
          --text-dim: #8493A0;
          --amber: #28CC95;
          --accent-soft: rgba(40,204,149,0.14);
          --on-accent: #04130D;
          --profit: #28CC95;
          --loss: #F5636F;
          --profit-soft: rgba(40,204,149,0.14);
          --loss-soft: rgba(245,99,111,0.14);
          --shadow: none;
          --overlay: rgba(0,0,0,0.6);
        }
        body { margin: 0; }
        .fj-root * { box-sizing: border-box; }
        .fj-root button, .fj-root input, .fj-root select, .fj-root textarea { font-family: inherit; }
        .fj-mono, .fj-display { font-family: 'Inter', system-ui, sans-serif; }

        /* ---- top bar ---- */
        .fj-header { display:flex; justify-content:space-between; align-items:center; padding:16px 0; flex-wrap: wrap; gap: 12px; }
        .fj-brand { display:flex; align-items:center; gap:10px; }
        .fj-brand-mark { width:30px; height:30px; border-radius:8px; background:var(--amber); display:grid; place-items:center; flex-shrink:0; }
        .fj-title { font-size:19px; font-weight:700; letter-spacing:-0.01em; margin:0; color:var(--text-bright); }
        .fj-sub { color:var(--text-dim); font-size:12.5px; margin-top:2px; }
        .fj-header-actions { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }

        .fj-btn {
          background: var(--panel); color: var(--text); border: 1px solid var(--border-strong);
          border-radius: 8px; padding: 0 14px; height: 36px; font-size: 13.5px; font-weight: 500;
          cursor: pointer; display:inline-flex; align-items:center; gap:6px; transition: background .12s, border-color .12s;
        }
        .fj-btn:hover { background: var(--panel-alt); }
        .fj-btn:focus-visible, .fj-tab:focus-visible, .fj-pill:focus-visible, .fj-seg-btn:focus-visible, .fj-menu-item:focus-visible { outline: 2px solid var(--amber); outline-offset: 2px; }
        .fj-btn.primary { background: var(--amber); color: var(--on-accent); border-color: var(--amber); font-weight:600; }
        .fj-btn.primary:hover { filter: brightness(1.07); }
        .fj-btn.icon { width:36px; padding:0; justify-content:center; }
        .fj-btn.danger:hover { border-color: var(--loss); color: var(--loss); }

        .fj-menu-wrap { position:relative; }
        .fj-menu { position:absolute; right:0; top:42px; z-index:40; min-width:240px; background:var(--panel); border:1px solid var(--border-strong);
          border-radius:12px; padding:6px; box-shadow:0 12px 32px rgba(10,22,32,0.16); }
        .fj-menu-group { font-size:11.5px; color:var(--text-dim); padding:8px 10px 4px; font-weight:500; }
        .fj-menu-item { display:flex; align-items:center; gap:10px; width:100%; background:none; border:none; color:var(--text); font-size:13.5px;
          padding:8px 10px; border-radius:8px; cursor:pointer; text-align:left; }
        .fj-menu-item:hover { background:var(--panel-alt); }
        .fj-btn-on { border-color:var(--amber); color:var(--amber); }
        .fj-count { background:var(--amber); color:var(--on-accent); border-radius:999px; font-size:11.5px; font-weight:700; padding:1px 7px; }
        .fj-menu-item input[type=checkbox] { accent-color:var(--amber); }
        .fj-menu-sep { height:1px; background:var(--border); margin:6px 4px; }

        /* ---- nav ---- */
        .fj-tabs { display:flex; gap:26px; border-bottom:1px solid var(--border); margin-bottom:24px; flex-wrap:wrap; }
        .fj-tab { background:none; border:none; color:var(--text-dim); padding:10px 0 12px; font-size:14.5px; font-weight:500;
          cursor:pointer; border-bottom:2px solid transparent; margin-bottom:-1px; }
        .fj-tab.active { color: var(--text-bright); font-weight:600; border-bottom-color: var(--text-bright); }
        .fj-tab:hover { color: var(--text-bright); }

        /* ---- pills / chips / segmented ---- */
        .fj-pills { display:flex; gap:4px; flex-wrap:wrap; }
        .fj-pill { background:none; border:none; color:var(--text-dim); font-size:13px; font-weight:600; padding:6px 12px; border-radius:999px; cursor:pointer; }
        .fj-pill:hover { background:var(--panel-alt); color:var(--text-bright); }
        .fj-pill.active { background:var(--accent-soft); color:var(--amber); }

        .fj-chip { background:var(--panel); border:1px solid var(--border-strong); color:var(--text); border-radius:999px;
          padding:4px 12px; font-size:12.5px; font-weight:500; cursor:pointer; user-select:none; }
        .fj-chip:hover { background:var(--panel-alt); }
        .fj-chip.active { color:var(--on-accent); background:var(--amber); border-color:var(--amber); font-weight:600; }
        .fj-date-input { background:var(--panel); border:1px solid var(--border-strong); color:var(--text); border-radius:8px; padding:5px 8px; font-size:12.5px; }

        .fj-seg-toggle { display:inline-flex; background:var(--panel-alt); border-radius:999px; padding:3px; gap:2px; }
        .fj-seg-btn { background:none; color:var(--text-dim); border:none; padding:5px 13px; font-size:12.5px; font-weight:600; cursor:pointer; border-radius:999px; }
        .fj-seg-btn:hover { color:var(--text-bright); }
        .fj-seg-btn.active { background:var(--panel); color:var(--text-bright); box-shadow:0 1px 3px rgba(10,22,32,0.14); }
        .fj-root[data-theme="dark"] .fj-seg-btn.active { background:var(--border-strong); box-shadow:none; }

        .fj-filterbar { display:flex; flex-wrap:wrap; gap:8px; align-items:center; background:var(--panel); border:1px solid var(--border);
          border-radius: 12px; padding: 12px 14px; margin-bottom:20px; }

        /* ---- hero ---- */
        .fj-hero { margin-bottom: 28px; }
        .fj-hero-top { display:flex; justify-content:space-between; align-items:flex-start; gap:16px; flex-wrap:wrap; }
        .fj-hero-label { font-size:14px; font-weight:500; color:var(--text-dim); }
        .fj-hero-value { font-size:44px; line-height:1.1; font-weight:700; letter-spacing:-0.025em; margin-top:4px; }
        .fj-hero-delta { display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-top:8px; font-size:14px; font-weight:600; }
        .fj-delta-chip { display:inline-flex; align-items:center; gap:4px; padding:3px 9px; border-radius:999px; font-size:13px; font-weight:600; }
        .fj-delta-chip.up { background:var(--profit-soft); color:var(--profit); }
        .fj-delta-chip.down { background:var(--loss-soft); color:var(--loss); }
        .fj-hero-meta { color:var(--text-dim); font-weight:400; font-size:13.5px; }
        .fj-hero-chart { margin-top:14px; }
        .fj-chart-bar { display:flex; justify-content:space-between; align-items:center; gap:10px 16px; flex-wrap:wrap; margin-bottom:6px; }
        .fj-chart-bar-right { display:flex; align-items:center; gap:8px 10px; flex-wrap:wrap; }
        .fj-tog { display:inline-flex; align-items:center; gap:7px; background:var(--panel); border:1px solid var(--border-strong); color:var(--text-dim); border-radius:999px; padding:4px 12px 4px 8px; font-size:12.5px; font-weight:500; cursor:pointer; }
        .fj-tog:hover { color:var(--text-bright); background:var(--panel-alt); }
        .fj-tog.on { color:var(--text-bright); border-color:var(--tog, var(--amber)); }
        .fj-tog b { font-weight:600; }
        .fj-tog-box { width:15px; height:15px; border-radius:5px; border:1.5px solid var(--border-strong); display:grid; place-items:center; flex-shrink:0; }
        .fj-tog.on .fj-tog-box { background:var(--tog, var(--amber)); border-color:var(--tog, var(--amber)); }
        .fj-hero-foot { display:flex; justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap; margin-top:6px; }

        /* ---- stats + panels ---- */
        .fj-stat-grid { display:grid; grid-template-columns: repeat(auto-fit, minmax(150px,1fr)); gap:0; margin-bottom:20px; border:1px solid var(--border); border-radius:12px; overflow:hidden; background:var(--panel); }
        .fj-stat-card { background:transparent; border:none; border-right:1px solid var(--border); border-bottom:1px solid var(--border); margin:0 -1px -1px 0; border-radius:0; padding:13px 16px; }
        .fj-stat-label { font-size:12.5px; color:var(--text-dim); font-weight:500; }
        .fj-stat-value { font-size:21px; font-weight:600; margin-top:6px; letter-spacing:-0.01em; }

        .fj-panel { background:var(--panel); border:1px solid var(--border); border-radius:14px; padding:20px; margin-bottom:20px; box-shadow:var(--shadow); }
        .fj-panel-title { font-weight:600; font-size:16px; margin:0 0 14px 0; color:var(--text-bright); letter-spacing:-0.005em; }

        table.fj-table { width:100%; border-collapse:collapse; font-size:13.5px; }
        table.fj-table th { text-align:left; color:var(--text-dim); font-weight:500; font-size:12.5px; padding:8px 10px; border-bottom:1px solid var(--border); }
        table.fj-table td { padding:10px; border-bottom:1px solid var(--border); }
        table.fj-table tr:hover td { background: var(--panel-alt); }
        table.fj-table td.actions { display:flex; gap:6px; }
        .fj-iconbtn { background:none; border:none; color:var(--text-dim); cursor:pointer; padding:5px; border-radius:6px; }
        .fj-iconbtn:hover { color: var(--text-bright); background: var(--panel-alt); }

        .fj-section-head { display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px; margin:30px 0 14px; }
        .fj-section-label { font-weight:700; font-size:19px; color:var(--text-bright); margin:0; letter-spacing:-0.015em; }
        .fj-section-hint { font-size:13px; color:var(--text-dim); font-weight:400; margin-left:8px; letter-spacing:0; }

        .fj-ticker { display:grid; grid-template-columns: repeat(auto-fill, minmax(200px,1fr)); gap:12px; margin-bottom:8px; }
        .fj-ticker-card { background:var(--panel); border:1px solid var(--border); border-radius:12px; padding:14px 16px; cursor:pointer; transition:border-color .12s, background .12s; }
        .fj-ticker-card:hover { border-color:var(--border-strong); background:var(--panel-alt); }
        .fj-ticker-top { display:flex; justify-content:space-between; align-items:center; }
        .fj-ticker-sym { font-weight:600; font-size:14.5px; display:flex; align-items:center; gap:8px; }
        .fj-dot { width:8px; height:8px; border-radius:50%; }
        .fj-ticker-pnl { font-size:20px; font-weight:600; margin-top:8px; letter-spacing:-0.01em; }
        .fj-ticker-meta { color: var(--text-dim); font-size:12.5px; margin-top:3px; }

        .fj-cards-grid { display:grid; grid-template-columns: repeat(auto-fill, minmax(280px,1fr)); gap:12px; }
        .fj-strat-card { background:var(--panel); border:1px solid var(--border); border-radius:12px; padding:16px; }
        .fj-strat-card-clickable { cursor:pointer; transition:border-color .12s, background .12s; }
        .fj-strat-card-clickable:hover { border-color:var(--border-strong); background:var(--panel-alt); }
        .fj-strat-pnl-big { font-size:24px; font-weight:700; margin-top:2px; letter-spacing:-0.02em; }
        .fj-strat-meta-row { display:flex; gap:12px; flex-wrap:wrap; margin-top:6px; margin-bottom:10px; font-size:12.5px; color:var(--text-dim); }

        .fj-back-btn { display:flex; align-items:center; gap:6px; background:none; border:none; color:var(--text-dim); cursor:pointer; font-size:13.5px; font-weight:500; padding:6px 0; margin-bottom:12px; }
        .fj-back-btn:hover { color:var(--text-bright); }
        .fj-detail-head { display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:18px; flex-wrap:wrap; gap:10px; }
        .fj-detail-title { font-size:30px; font-weight:700; margin-top:2px; letter-spacing:-0.02em; color:var(--text-bright); }
        .fj-strat-name { font-weight:600; font-size:15px; margin-bottom:6px; color:var(--text-bright); }
        .fj-strat-row { display:flex; justify-content:space-between; font-size:13px; color:var(--text-dim); padding:3px 0; }
        .fj-strat-row b { color: var(--text); font-weight:500; }

        /* ---- calendar ---- */
        .fj-cal-nav { display:flex; align-items:center; gap:10px; }
        .fj-cal-month-label { font-weight:700; font-size:17px; min-width:150px; text-align:center; color:var(--text-bright); }
        .fj-cal-grid { display:grid; grid-template-columns: repeat(7, 1fr) 110px; gap:6px; margin-top:12px; }
        .fj-cal-headcell { font-size:12px; font-weight:500; color:var(--text-dim); text-align:center; padding-bottom:4px; }
        .fj-cal-cell { background:var(--panel-alt); border:1px solid var(--border); border-radius:10px; padding:7px 8px; min-height:68px; display:flex; flex-direction:column; justify-content:space-between; }
        .fj-cal-cell.pad { opacity:0.35; }
        .fj-cal-daynum { font-size:11.5px; color:var(--text-dim); }
        .fj-cal-cell-pnl { font-size:13px; font-weight:600; align-self:flex-end; }
        .fj-cal-cell-count { font-size:10.5px; color:var(--text-dim); align-self:flex-end; }
        .fj-cal-weektotal { background:var(--panel); border:1px solid var(--border); border-radius:10px; padding:6px 8px; display:flex; flex-direction:column;
          justify-content:center; align-items:flex-end; gap:2px; }
        .fj-cal-weektotal-label { font-size:11px; color:var(--text-dim); }
        .fj-cal-weektotal-val { font-size:13.5px; font-weight:700; }

        .fj-year-grid { display:grid; grid-template-columns: repeat(auto-fit, minmax(220px,1fr)); gap:12px; margin-top:14px; }
        .fj-year-month-card { background:var(--panel); border:1px solid var(--border); border-radius:12px; padding:14px; cursor:pointer; transition:border-color .12s, background .12s; }
        .fj-year-month-card:hover { border-color: var(--border-strong); background:var(--panel-alt); }
        .fj-year-month-head { display:flex; justify-content:space-between; align-items:baseline; margin-bottom:10px; }
        .fj-year-month-name { font-weight:600; font-size:14.5px; }
        .fj-year-month-pnl { font-size:13px; font-weight:600; }
        .fj-mini-grid { display:flex; gap:3px; }
        .fj-mini-week { display:flex; flex-direction:column; gap:3px; }
        .fj-mini-day { width:14px; height:14px; border-radius:3px; }

        /* ---- accounts ---- */
        .fj-acct-grid { display:grid; grid-template-columns: repeat(auto-fit, minmax(300px,1fr)); gap:14px; }
        .fj-acct-card { background:var(--panel); border:1px solid var(--border); border-radius:14px; padding:18px; }
        .fj-acct-head { display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:10px; }
        .fj-acct-name { font-weight:700; font-size:16px; }
        .fj-badge { font-size:12px; font-weight:600; padding:3px 10px; border-radius:999px; display:inline-block; margin-top:4px; }
        .fj-badge.eval { background:var(--accent-soft); color:var(--amber); }
        .fj-badge.passed { background:var(--profit-soft); color:var(--profit); }
        .fj-badge.failed { background:var(--loss-soft); color:var(--loss); }
        .fj-badge.cash { background:var(--panel-alt); color:var(--text-dim); }
        .fj-acct-row { display:flex; justify-content:space-between; font-size:13px; color:var(--text-dim); padding:3px 0; }
        .fj-acct-row b { color: var(--text); font-weight:500; }
        .fj-acct-updateform { display:flex; gap:6px; align-items:flex-end; margin:12px 0 4px; }
        .fj-acct-history { max-height:140px; overflow-y:auto; margin-top:8px; }
        .fj-acct-history-row { display:flex; justify-content:space-between; align-items:center; font-size:12.5px; padding:5px 2px; border-bottom:1px solid var(--border); color:var(--text-dim); }
        .fj-acct-history-row b { color:var(--text); font-weight:500; }

        .fj-legend-row { display:flex; flex-wrap:wrap; gap:14px; margin-top:12px; }
        .fj-legend-item { display:flex; align-items:center; gap:6px; font-size:12.5px; color:var(--text-dim); }
        .fj-legend-swatch { width:9px; height:9px; border-radius:50%; flex-shrink:0; }

        .fj-empty { color:var(--text-dim); font-size:13.5px; text-align:center; padding:32px 10px; }

        /* ---- forms + modals ---- */
        .fj-modal-backdrop { position:fixed; inset:0; background:var(--overlay); display:flex; align-items:center;
          justify-content:center; z-index:50; padding:16px; }
        .fj-modal { background:var(--panel); border:1px solid var(--border); border-radius:16px; padding:22px; width:100%;
          max-width:520px; max-height:88vh; overflow-y:auto; color:var(--text); box-shadow:0 20px 60px rgba(10,22,32,0.25); }
        .fj-form-row { display:grid; grid-template-columns: 1fr 1fr; gap:12px; margin-bottom:12px; }
        .fj-form-field { display:flex; flex-direction:column; gap:5px; }
        .fj-form-field label { font-size:12.5px; font-weight:500; color:var(--text-dim); }
        .fj-input, .fj-select {
          background: var(--panel); border:1px solid var(--border-strong); color:var(--text); border-radius:8px;
          padding:9px 10px; font-size:13.5px;
        }
        .fj-form-field { min-width:0; }
        .fj-input, .fj-select { width:100%; min-width:0; }
        .fj-input:focus, .fj-select:focus { outline:2px solid var(--accent-soft); outline-offset:0; border-color:var(--amber); }
        .fj-input::placeholder { color: var(--text-dim); opacity:0.7; }
        .fj-toggle-group { display:flex; gap:6px; }
        .fj-toggle { flex:1; padding:9px; text-align:center; border-radius:8px; border:1px solid var(--border-strong);
          background:var(--panel); cursor:pointer; font-size:13.5px; font-weight:600; }
        .fj-toggle.active-long { background: var(--profit-soft); border-color:var(--profit); color:var(--profit); }
        .fj-toggle.active-short { background: var(--loss-soft); border-color:var(--loss); color:var(--loss); }

        .fj-profit { color: var(--profit); }
        .fj-loss { color: var(--loss); }
        .fj-neutral { color: var(--text-dim); }


        /* ---- dashboard layout ---- */
        .fj-dash-grid { display:grid; grid-template-columns:minmax(0,1fr) 290px; gap:36px; align-items:start; margin-bottom:28px; }
        .fj-dash-grid .fj-hero { margin-bottom:0; }
        .fj-side { display:flex; flex-direction:column; gap:14px; padding-top:2px; }
        .fj-statlist-title { font-weight:600; font-size:14px; color:var(--text-bright); padding-bottom:8px; border-bottom:1px solid var(--border); }
        .fj-statrow { display:flex; justify-content:space-between; align-items:baseline; gap:10px; padding:9px 0; border-bottom:1px solid var(--border); font-size:13.5px; color:var(--text-dim); }
        .fj-statrow b { color:var(--text-bright); font-weight:600; }
        .fj-statrow b.fj-profit { color:var(--profit); } .fj-statrow b.fj-loss { color:var(--loss); }
        .fj-side-link { display:flex; justify-content:space-between; align-items:center; gap:10px; width:100%; text-align:left; background:var(--panel-alt); border:none; border-radius:12px; padding:12px 14px; cursor:pointer; color:var(--text); font-size:13.5px; }
        .fj-side-link:hover { background:var(--accent-soft); }
        .fj-tabbar { display:flex; align-items:center; gap:14px; flex-wrap:wrap; border-bottom:1px solid var(--border); padding-bottom:12px; margin-bottom:6px; }
        .fj-pill.lg { font-size:14px; padding:7px 14px; }
        .fj-table-wrap { overflow-x:auto; }
        .fj-scroll-y { max-height:360px; overflow:auto; border-top:1px solid var(--border); border-bottom:1px solid var(--border); }
        .fj-scroll-y table.fj-table th { position:sticky; top:0; background:var(--panel); z-index:1; }
        .fj-th-btn { background:none; border:none; padding:0; font:inherit; color:inherit; cursor:pointer; font-weight:500; }
        .fj-th-btn:hover, .fj-th-btn.on { color:var(--text-bright); }
        .fj-group-table td { padding:9px 10px; vertical-align:middle; }
        .fj-row-click { cursor:pointer; }
        .fj-row-click.picked td { background:var(--accent-soft); }
        .fj-name-cell { display:inline-flex; align-items:center; gap:9px; font-weight:600; color:var(--text-bright); white-space:nowrap; }
        .fj-more-btn { display:block; margin:10px auto 0; background:none; border:none; color:var(--amber); font-weight:600; font-size:13.5px; cursor:pointer; padding:6px 12px; border-radius:8px; }
        .fj-more-btn:hover { background:var(--accent-soft); }
        .fj-two-col { display:grid; grid-template-columns:repeat(auto-fit, minmax(420px,1fr)); gap:22px 32px; margin-top:14px; }
        .fj-sub-title { font-size:15px; font-weight:600; margin:0 0 10px; color:var(--text-bright); }
        @media (max-width: 640px) { .fj-two-col { grid-template-columns:minmax(0,1fr); } .fj-col-sec { display:none; } }
        @media (max-width: 980px) { .fj-dash-grid { grid-template-columns:minmax(0,1fr); gap:22px; } .fj-col-trend { display:none; } }
        @media (max-width: 640px) {
          .fj-form-row { grid-template-columns: 1fr; }
          .fj-hero-value { font-size:34px; }
          .fj-tabs { gap:18px; overflow-x:auto; flex-wrap:nowrap; }
          .fj-tab { white-space:nowrap; }
          .fj-cal-grid { grid-template-columns: repeat(7, 1fr); }
          .fj-cal-weektotal { display:none; }
          .fj-title { font-size:17px; }
        }
        @media (prefers-reduced-motion: reduce) { .fj-root * { transition:none !important; } }
      `}</style>

      <Header
        onAdd={() => { setEditingId(null); setShowForm(true); }}
        onBulkAdd={() => setShowBulkForm(true)}
        onSettings={() => setShowSettings((s) => !s)}
        onExport={handleExport}
        onImportClick={triggerImport}
        onTradovateImportClick={triggerTradovateImport}
        onNinjaTraderImportClick={triggerNinjaImport}
        onSignalImportClick={() => setShowSignalImport(true)}
        onBackup={handleBackup}
        onRestoreClick={triggerRestore}
        theme={theme}
        onToggleTheme={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
      />

      <input
        ref={fileInputRef}
        type="file"
        accept=".csv,text/csv"
        style={{ display: "none" }}
        onChange={handleFileChange}
      />

      <input
        ref={tradovateFileInputRef}
        type="file"
        accept=".csv,text/csv"
        style={{ display: "none" }}
        onChange={handleTradovateFileChange}
      />

      <input
        ref={ninjaFileInputRef}
        type="file"
        accept=".csv,text/csv"
        style={{ display: "none" }}
        onChange={handleNinjaFileChange}
      />

      <input
        ref={backupFileInputRef}
        type="file"
        accept=".json,application/json"
        style={{ display: "none" }}
        onChange={handleBackupFileChange}
      />

      {importPreview && (
        <ImportPreviewModal
          preview={importPreview}
          existingCount={trades.length}
          onAppend={() => confirmImport("append")}
          onReplace={() => confirmImport("replace")}
          onCancel={() => setImportPreview(null)}
        />
      )}

      {tradovateImport && !tradovateImport.error && (
        <TradovateImportModal
          parsedRows={tradovateImport.parsedRows}
          newMarkets={tradovateImport.newMarkets}
          skippedCount={tradovateImport.skippedCount}
          feesApplied={tradovateImport.feesApplied}
          strategies={strategies}
          accounts={accounts}
          onConfirm={confirmTradovateImport}
          onCancel={() => setTradovateImport(null)}
        />
      )}

      {tradovateImport && tradovateImport.error && (
        <div className="fj-modal-backdrop" onClick={() => setTradovateImport(null)}>
          <div className="fj-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 440 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
              <p className="fj-panel-title" style={{ margin: 0 }}>Couldn't import this file</p>
              <button className="fj-iconbtn" onClick={() => setTradovateImport(null)}><X size={18} /></button>
            </div>
            <div className="fj-loss" style={{ fontSize: 13, marginBottom: 16 }}>{tradovateImport.error}</div>
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button className="fj-btn" onClick={() => setTradovateImport(null)}>Close</button>
            </div>
          </div>
        </div>
      )}

      {showSignalImport && (
        <SignalImportModal trades={trades} onApply={applySignalData} onClose={() => setShowSignalImport(false)} />
      )}

      {ninjaImport && !ninjaImport.error && (
        <NinjaTraderImportModal
          parsedRows={ninjaImport.parsedRows}
          newMarkets={ninjaImport.newMarkets}
          skippedCount={ninjaImport.skippedCount}
          feesApplied={ninjaImport.feesApplied}
          strategies={strategies}
          accounts={accounts}
          onConfirm={confirmNinjaImport}
          onCancel={() => setNinjaImport(null)}
        />
      )}

      {ninjaImport && ninjaImport.error && (
        <div className="fj-modal-backdrop" onClick={() => setNinjaImport(null)}>
          <div className="fj-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 440 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
              <p className="fj-panel-title" style={{ margin: 0 }}>Couldn't import this file</p>
              <button className="fj-iconbtn" onClick={() => setNinjaImport(null)}><X size={18} /></button>
            </div>
            <div className="fj-loss" style={{ fontSize: 13, marginBottom: 16 }}>{ninjaImport.error}</div>
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button className="fj-btn" onClick={() => setNinjaImport(null)}>Close</button>
            </div>
          </div>
        </div>
      )}

      {restorePreview && (
        <RestorePreviewModal
          preview={restorePreview}
          existingTradeCount={trades.length}
          existingAccountCount={accounts.length}
          onConfirm={confirmRestore}
          onCancel={() => setRestorePreview(null)}
        />
      )}

      {showSettings && (
        <SettingsPanel settings={settings} setSettings={setSettings} trades={trades} setTrades={setTrades} onClose={() => setShowSettings(false)} />
      )}

      <div className="fj-tabs">
        {[
          ["home", "Dashboard"],
          ["calendar", "Calendar"],
          ["accounts", "Accounts"],
          ["log", "Trade Log"],
          ["timeline", "Timeline"],
          ["optimizer", "Optimizer"],
        ].map(([key, label]) => (
          <button key={key} className={`fj-tab ${view === key ? "active" : ""}`} onClick={() => setView(key)}>
            {label}
          </button>
        ))}
      </div>

      {view === "home" && (
        selectedEntity ? (
          <DetailView
            selected={selectedEntity}
            trades={trades}
            settings={settings}
            strategies={strategies}
            notes={notes}
            accounts={accounts}
            onAddNote={addNote}
            onUpdateNote={updateNote}
            onDeleteNote={deleteNote}
            onBack={() => setSelectedEntity(null)}
            onNavigate={(type, key) => setSelectedEntity({ type, key })}
            onEdit={startEdit}
            onDelete={handleDelete}
            onBulkUpdate={handleBulkUpdate}
            onBulkCopy={handleBulkCopy}
          />
        ) : (
          <HomeView
            trades={trades}
            settings={settings}
            accounts={accounts}
            strategies={strategies}
            onSelect={(type, key) => setSelectedEntity({ type, key })}
            onViewAccounts={() => setView("accounts")}
          />
        )
      )}
      {view === "calendar" && (
        <CalendarView trades={trades} strategies={strategies} settings={settings} />
      )}
      {view === "accounts" && (
        <AccountsView accounts={accounts} setAccounts={setAccounts} trades={trades} setTrades={setTrades} />
      )}
      {view === "log" && (
        <TradeLogView trades={trades} strategies={strategies} accounts={accounts} settings={settings} onEdit={startEdit} onDelete={handleDelete} onBulkUpdate={handleBulkUpdate} onBulkCopy={handleBulkCopy} />
      )}
      {view === "timeline" && (
        <TimelineView
          notes={notes}
          strategies={strategies}
          settings={settings}
          accounts={accounts}
          onAddNote={addNote}
          onUpdateNote={updateNote}
          onDeleteNote={deleteNote}
        />
      )}
      {view === "optimizer" && (
        <OptimizerView trades={trades} strategies={strategies} accounts={accounts} />
      )}

      {showForm && (
        <TradeForm
          initial={editingTrade}
          strategies={strategies}
          accounts={accounts}
          settings={settings}
          onCancel={() => { setShowForm(false); setEditingId(null); }}
          onSave={handleSave}
        />
      )}

      {showBulkForm && (
        <BulkTradeForm
          strategies={strategies}
          accounts={accounts}
          settings={settings}
          onCancel={() => setShowBulkForm(false)}
          onSave={handleBulkAdd}
        />
      )}
    </div>
  );
}

// ---------- header ----------

// ---------- signal sheets ("advanced info") ----------
//
// The strategy can export one row per signal with the numbers it saw at entry
// (strength, ATR, higher-timeframe state, ...) and how the trade moved
// (max favorable / adverse excursion). We attach those to the journal trade
// they belong to, matched by entry minute + direction, and analyse them in the
// strategy's Signals tab. Labels live here so they're easy to correct.

const SIGNAL_FIELDS = {
  str:    { label: "Entry strength",              kind: "num", entry: true },
  atr:    { label: "ATR at entry (pts)",          kind: "num", entry: true, dec: 1 },
  htfStr: { label: "Higher-timeframe strength",   kind: "num", entry: true },
  slDist: { label: "Stop distance (pts)",         kind: "num", entry: true, dec: 1 },
  htf:    { label: "Higher timeframe agrees",     kind: "flag", entry: true },
  chop:   { label: "Chop filter flag",            kind: "flag", entry: true },
  re:     { label: "Re-entry",                    kind: "flag", entry: true },
  bars:   { label: "Bars held",                   kind: "num", entry: false },
  mfe:    { label: "Max favorable move (pts)",    kind: "num", entry: false, dec: 1 },
  mae:    { label: "Max adverse move (pts)",      kind: "num", entry: false, dec: 1 },
  be:     { label: "Break-even triggered",        kind: "flag", entry: false },
};

function parseSignalSheet(text) {
  const res = Papa.parse(text, { header: true, skipEmptyLines: true });
  const cols = res.meta.fields || [];
  const need = ["timestamp", "event", "dir", "px", "mfe", "mae"];
  if (!need.every((c) => cols.includes(c))) {
    return { error: "This doesn't look like a signal sheet. It needs timestamp, event, dir, px, mfe and mae columns." };
  }
  const pairs = [];
  let cur = null;
  res.data.forEach((r) => {
    if (r.event === "OPEN") cur = r;
    else if (r.event === "CLOSE" && cur) { pairs.push({ o: cur, c: r }); cur = null; }
  });
  if (pairs.length === 0) return { error: "No completed trades (an OPEN followed by a CLOSE) found in this file." };
  return { pairs, preset: pairs[0].o.preset || "" };
}

function sheetAdv(o, c) {
  const n = (v) => { const x = parseFloat(v); return Number.isFinite(x) ? x : null; };
  const px = n(o.px), sl = n(o.sl), tp = n(o.tp1);
  return {
    preset: o.preset || "",
    str: n(o.str), atr: n(o.atr), htf: n(o.htf), htfStr: n(o.htf_str), re: n(o.re), chop: n(o.chop),
    slDist: px !== null && sl !== null ? Math.abs(px - sl) : null,
    tpDist: px !== null && tp !== null ? Math.abs(tp - px) : null,
    bars: n(c.bars), strX: n(c.str_x), htfX: n(c.htf_x), be: n(c.be), tier: n(c.tier),
    mfe: n(c.mfe), mae: n(c.mae), exit: c.reason || "",
  };
}

// Match each sheet row to a journal trade in one strategy by entry date, minute
// and direction. Several trades in the same minute are consumed in order.
function matchSignalSheet(pairs, trades, strategy) {
  const buckets = new Map();
  trades.forEach((t) => {
    if (t._isCopy || t.strategy !== strategy) return;
    const k = `${t.date}|${t.time}|${t.direction === "Long" ? "L" : "S"}`;
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(t);
  });
  const matches = [];
  let unmatched = 0;
  const shift = (hhmm, d) => {
    const m = parseInt(hhmm.slice(0, 2), 10) * 60 + parseInt(hhmm.slice(3, 5), 10) + d;
    if (m < 0 || m >= 1440) return null;
    return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  };
  const take = (day, hhmm, dir) => {
    for (const d of [0, -1, 1]) {
      const hm = d === 0 ? hhmm : shift(hhmm, d);
      const arr = hm && buckets.get(`${day}|${hm}|${dir}`);
      if (arr && arr.length) return arr.shift();
    }
    return null;
  };
  // exact-minute matches first so a near-miss never steals another row's trade
  const rest = [];
  pairs.forEach((p) => {
    const day = p.o.timestamp.slice(0, 10), hm = p.o.timestamp.slice(11, 16);
    const arr = buckets.get(`${day}|${hm}|${p.o.dir}`);
    const t = arr && arr.shift();
    if (t) matches.push({ trade: t, adv: sheetAdv(p.o, p.c) }); else rest.push(p);
  });
  rest.forEach((p) => {
    const t = take(p.o.timestamp.slice(0, 10), p.o.timestamp.slice(11, 16), p.o.dir);
    if (t) matches.push({ trade: t, adv: sheetAdv(p.o, p.c) }); else unmatched++;
  });
  return { matches, unmatched };
}

function SignalImportModal({ trades, onApply, onClose }) {
  const [sheets, setSheets] = useState([]);
  const [error, setError] = useState("");
  const [done, setDone] = useState(null);
  const strategyNames = useMemo(() => [...new Set(trades.filter((t) => !t._isCopy && t.strategy).map((t) => t.strategy))].sort(), [trades]);

  const onFiles = async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = "";
    if (files.length === 0) return;
    setError("");
    const out = [];
    for (const f of files) {
      const parsed = parseSignalSheet(await f.text());
      if (parsed.error) { setError(`${f.name}: ${parsed.error}`); continue; }
      const candidates = strategyNames
        .map((s) => ({ strategy: s, matches: matchSignalSheet(parsed.pairs, trades, s).matches.length }))
        .sort((a, b) => b.matches - a.matches || a.strategy.localeCompare(b.strategy));
      out.push({ id: uid(), name: f.name, pairs: parsed.pairs, preset: parsed.preset, candidates, chosen: candidates[0]?.matches > 0 ? candidates[0].strategy : "", first: parsed.pairs[0].o.timestamp, last: parsed.pairs[parsed.pairs.length - 1].o.timestamp });
    }
    setSheets((prev) => [...prev, ...out]);
  };

  const resolved = sheets.map((s) => (s.chosen ? { ...s, ...matchSignalSheet(s.pairs, trades, s.chosen) } : { ...s, matches: [], unmatched: s.pairs.length }));
  const totalMatched = resolved.reduce((a, s) => a + s.matches.length, 0);

  const apply = () => {
    const byId = new Map();
    resolved.forEach((s) => s.matches.forEach((m) => byId.set(m.trade.id, m.adv)));
    setDone(onApply(byId));
  };

  return (
    <div className="fj-modal-backdrop" onClick={onClose}>
      <div className="fj-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 760 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
          <p className="fj-panel-title" style={{ margin: 0 }}>Add signal sheets</p>
          <button className="fj-iconbtn" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </div>
        <p className="fj-sub" style={{ marginBottom: 14, maxWidth: 640 }}>
          Upload the advanced-info CSVs (one per preset). Each row is matched to the journal trade that entered in the same minute in the same direction, then its entry strength, ATR, higher-timeframe state and move data are attached to that trade. Uploading again replaces what's there.
        </p>

        {done ? (
          <>
            <div className="fj-panel" style={{ marginBottom: 14 }}>
              <b>Attached to {done.trades} trade{done.trades === 1 ? "" : "s"}</b>
              {done.copies > 0 && <span className="fj-sub"> (plus {done.copies} copied trade{done.copies === 1 ? "" : "s"} in other strategies)</span>}
              <div className="fj-sub" style={{ marginTop: 4 }}>Open a strategy and choose the Signals tab to analyse it.</div>
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end" }}><button className="fj-btn primary" onClick={onClose}>Done</button></div>
          </>
        ) : (
          <>
            <label className="fj-btn" style={{ cursor: "pointer" }}>
              <Upload size={15} /> Choose CSV files
              <input type="file" accept=".csv,text/csv" multiple onChange={onFiles} style={{ display: "none" }} />
            </label>
            {error && <div className="fj-loss" style={{ marginTop: 10, fontSize: 13 }}>{error}</div>}

            {resolved.length > 0 && (
              <div className="fj-table-wrap" style={{ marginTop: 14 }}>
                <table className="fj-table">
                  <thead><tr><th>File</th><th>Preset</th><th>Journal strategy</th><th style={{ textAlign: "right" }}>Matched</th></tr></thead>
                  <tbody>
                    {resolved.map((s) => (
                      <tr key={s.id}>
                        <td style={{ maxWidth: 190, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={s.name}>{s.name}</td>
                        <td>{s.preset || "—"}<div className="fj-sub" style={{ marginTop: 0 }}>{s.first.slice(0, 16)} to {s.last.slice(11, 16)}</div></td>
                        <td>
                          <select className="fj-select" value={s.chosen} onChange={(e) => setSheets((prev) => prev.map((x) => x.id === s.id ? { ...x, chosen: e.target.value } : x))}>
                            <option value="">Skip this file</option>
                            {s.candidates.map((c) => <option key={c.strategy} value={c.strategy}>{c.strategy} ({c.matches} of {s.pairs.length} match)</option>)}
                          </select>
                        </td>
                        <td style={{ textAlign: "right" }} className={s.chosen && s.unmatched > 0 ? "fj-loss" : ""}>
                          {s.chosen ? `${s.matches.length} of ${s.pairs.length}` : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {resolved.some((s) => !s.chosen) && resolved.length > 0 && (
              <div className="fj-sub" style={{ marginTop: 8 }}>Pick a strategy for any file that shows "Skip this file". If a strategy shows 0 matches, the journal has no trades at those entry times yet. Add or import the trades first, and check that the sheet and journal use the same time zone.</div>
            )}

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
              <button className="fj-btn" onClick={onClose}>Cancel</button>
              <button className="fj-btn primary" disabled={totalMatched === 0} onClick={apply} style={totalMatched === 0 ? { opacity: 0.5, cursor: "not-allowed" } : undefined}>
                Attach to {totalMatched} trade{totalMatched === 1 ? "" : "s"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ---------- signals tab ----------

const sigRowStats = (list) => {
  const s = calcStats(list);
  return { n: s.n, win: s.winRate, net: s.totalPnl, avg: s.expectancy, pf: s.profitFactor };
};
const fmtPF = (pf) => (pf === null ? "—" : pf === Infinity ? "∞" : pf.toFixed(2));
const fmtNum = (v, dec) => (v === null || v === undefined ? "—" : Number(v).toFixed(dec ?? (Math.abs(v) >= 100 ? 0 : 1)));

function sigQuartiles(list, key) {
  const vals = list.filter((t) => t.adv[key] !== null && t.adv[key] !== undefined);
  if (vals.length < 8) return null;
  const sorted = [...vals].sort((a, b) => a.adv[key] - b.adv[key]);
  const q = 4, out = [];
  for (let i = 0; i < q; i++) {
    const part = sorted.slice(Math.floor((i * sorted.length) / q), Math.floor(((i + 1) * sorted.length) / q));
    if (part.length) out.push({ lo: part[0].adv[key], hi: part[part.length - 1].adv[key], list: part });
  }
  return out;
}

function SigBucketTable({ title, note, rows }) {
  const maxAbs = Math.max(1, ...rows.map((r) => Math.abs(r.s.avg)));
  return (
    <div className="fj-panel" style={{ marginBottom: 0 }}>
      <p className="fj-sub-title" style={{ marginBottom: note ? 2 : 10 }}>{title}</p>
      {note && <div className="fj-sub" style={{ marginBottom: 8 }}>{note}</div>}
      <div className="fj-table-wrap">
        <table className="fj-table">
          <thead><tr><th>Bucket</th><th style={{ textAlign: "right" }}>Trades</th><th style={{ textAlign: "right" }}>Win %</th><th style={{ textAlign: "right" }}>Net</th><th style={{ textAlign: "right" }}>Avg / trade</th><th style={{ textAlign: "right" }}>PF</th><th style={{ width: 90 }} /></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.label} style={r.s.n < 10 ? { opacity: 0.55 } : undefined} title={r.s.n < 10 ? "Fewer than 10 trades — too few to trust" : undefined}>
                <td style={{ whiteSpace: "nowrap" }}>{r.label.split(" · ")[0]}<div className="fj-sub" style={{ marginTop: 0 }}>{r.label.split(" · ")[1]}</div></td>
                <td style={{ textAlign: "right" }}>{r.s.n}</td>
                <td style={{ textAlign: "right" }}>{pct(r.s.win)}</td>
                <td style={{ textAlign: "right" }} className={r.s.net >= 0 ? "fj-profit" : "fj-loss"}>{money(r.s.net)}</td>
                <td style={{ textAlign: "right" }} className={r.s.avg >= 0 ? "fj-profit" : "fj-loss"}>{money(r.s.avg)}</td>
                <td style={{ textAlign: "right" }}>{fmtPF(r.s.pf)}</td>
                <td>
                  <div style={{ height: 6, borderRadius: 3, background: r.s.avg >= 0 ? "var(--profit)" : "var(--loss)", width: `${Math.max(4, (Math.abs(r.s.avg) / maxAbs) * 100)}%`, opacity: 0.8 }} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SignalAnalysisPanel({ trades, settings }) {
  const withAdv = useMemo(() => trades.filter((t) => t.adv), [trades]);
  const [ruleKey, setRuleKey] = useState("str");
  const [ruleMode, setRuleMode] = useState("gte"); // gte = keep >= threshold, lt = keep < threshold
  const [ruleVal, setRuleVal] = useState("");

  const entryNum = Object.keys(SIGNAL_FIELDS).filter((k) => SIGNAL_FIELDS[k].kind === "num" && SIGNAL_FIELDS[k].entry);
  const entryFlag = Object.keys(SIGNAL_FIELDS).filter((k) => SIGNAL_FIELDS[k].kind === "flag" && SIGNAL_FIELDS[k].entry);
  const ruleField = SIGNAL_FIELDS[ruleKey];

  // winners vs losers
  const compare = useMemo(() => {
    const w = withAdv.filter((t) => t.pnl > 0), l = withAdv.filter((t) => t.pnl < 0);
    const avg = (arr, k) => {
      const v = arr.map((t) => t.adv[k]).filter((x) => x !== null && x !== undefined);
      return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
    };
    return Object.keys(SIGNAL_FIELDS).map((k) => ({ k, win: avg(w, k), loss: avg(l, k) })).filter((r) => r.win !== null || r.loss !== null);
  }, [withAdv]);

  // excursion
  const exc = useMemo(() => {
    const held = withAdv.filter((t) => t.adv.mfe !== null && t.adv.mae !== null);
    if (held.length === 0) return null;
    const mult = (t) => (settings[t.market]?.multiplier || 1) * (t.contracts || 1);
    const pts = (t) => (t.pnl + (Number(t.fees) || 0)) / mult(t);
    const avg = (f) => held.reduce((s, t) => s + f(t), 0) / held.length;
    const winners = held.filter((t) => t.pnl > 0);
    const losers = held.filter((t) => t.pnl < 0);
    const reached = losers.filter((t) => t.adv.tpDist && t.adv.mfe >= 0.5 * t.adv.tpDist).length;
    const capture = winners.length ? winners.reduce((s, t) => s + (t.adv.mfe > 0 ? pts(t) / t.adv.mfe : 0), 0) / winners.length : null;
    return { n: held.length, mfe: avg((t) => t.adv.mfe), mae: avg((t) => Math.abs(t.adv.mae)), capture, losers: losers.length, reached, winMfe: winners.length ? winners.reduce((s, t) => s + t.adv.mfe, 0) / winners.length : null, loseMae: losers.length ? losers.reduce((s, t) => s + Math.abs(t.adv.mae), 0) / losers.length : null };
  }, [withAdv, settings]);

  // rule test
  const rule = useMemo(() => {
    const pool = withAdv.filter((t) => t.adv[ruleKey] !== null && t.adv[ruleKey] !== undefined);
    let keep;
    if (ruleField.kind === "flag") {
      const want = ruleMode === "on" ? 1 : 0;
      keep = (t) => (t.adv[ruleKey] ? 1 : 0) === want;
    } else {
      const v = parseFloat(ruleVal);
      if (!Number.isFinite(v)) return null;
      keep = ruleMode === "gte" ? (t) => t.adv[ruleKey] >= v : (t) => t.adv[ruleKey] < v;
    }
    const kept = pool.filter(keep), skipped = pool.filter((t) => !keep(t));
    return { base: calcStats(pool), kept: calcStats(kept), skipped: calcStats(skipped) };
  }, [withAdv, ruleKey, ruleMode, ruleVal, ruleField]);

  if (withAdv.length === 0) {
    return <div className="fj-panel" style={{ marginTop: 16 }}><div className="fj-sub">No signal data attached yet. Use Import &amp; export → Signal sheets.</div></div>;
  }

  const buckets = entryNum.map((k) => {
    const qs = sigQuartiles(withAdv, k);
    if (!qs) return null;
    const dec = SIGNAL_FIELDS[k].dec;
    return { k, rows: qs.map((b, i) => ({ label: `${["Lowest", "Low-mid", "High-mid", "Highest"][i]} · ${fmtNum(b.lo, dec)}–${fmtNum(b.hi, dec)}`, s: sigRowStats(b.list) })) };
  }).filter(Boolean);
  const bucketsBars = (() => {
    const qs = sigQuartiles(withAdv, "bars");
    return qs ? { k: "bars", rows: qs.map((b, i) => ({ label: `${["Shortest", "Short-mid", "Long-mid", "Longest"][i]} · ${fmtNum(b.lo, 0)}–${fmtNum(b.hi, 0)}`, s: sigRowStats(b.list) })) } : null;
  })();
  const flagTables = [...entryFlag, "be"].map((k) => {
    const on = withAdv.filter((t) => t.adv[k] === 1), off = withAdv.filter((t) => t.adv[k] === 0);
    if (on.length === 0 || off.length === 0) return null;
    return { k, rows: [{ label: "Yes", s: sigRowStats(on) }, { label: "No", s: sigRowStats(off) }] };
  }).filter(Boolean);

  return (
    <div style={{ paddingTop: 16, display: "grid", gap: 18 }}>
      <div className="fj-sub">
        {withAdv.length} of {trades.length} trades have signal data. Buckets split trades into four equal groups by the value at entry; faded rows have fewer than 10 trades. Column meanings come from the sheet headers and can be renamed in <code>SIGNAL_FIELDS</code>.
      </div>

      <div className="fj-panel">
        <p className="fj-sub-title">Winners vs losers: average value</p>
        <div className="fj-table-wrap">
          <table className="fj-table">
            <thead><tr><th>Measure</th><th style={{ textAlign: "right" }}>Winners</th><th style={{ textAlign: "right" }}>Losers</th><th>Known at entry?</th></tr></thead>
            <tbody>
              {compare.map((r) => (
                <tr key={r.k}>
                  <td>{SIGNAL_FIELDS[r.k].label}</td>
                  <td style={{ textAlign: "right" }}>{fmtNum(r.win, SIGNAL_FIELDS[r.k].kind === "flag" ? 2 : SIGNAL_FIELDS[r.k].dec)}</td>
                  <td style={{ textAlign: "right" }}>{fmtNum(r.loss, SIGNAL_FIELDS[r.k].kind === "flag" ? 2 : SIGNAL_FIELDS[r.k].dec)}</td>
                  <td className="fj-sub">{SIGNAL_FIELDS[r.k].entry ? "Yes" : "No, only after the trade"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="fj-sub" style={{ marginTop: 6 }}>Flags show the share of trades where it was on (0.30 = 30%).</div>
      </div>

      <div className="fj-two-col" style={{ marginTop: 0 }}>
        {buckets.map((b) => <SigBucketTable key={b.k} title={SIGNAL_FIELDS[b.k].label} rows={b.rows} />)}
        {flagTables.map((f) => <SigBucketTable key={f.k} title={SIGNAL_FIELDS[f.k].label} note={SIGNAL_FIELDS[f.k].entry ? undefined : "Only known after the trade, so it explains results but can't be used as an entry filter."} rows={f.rows} />)}
        {bucketsBars && <SigBucketTable title={SIGNAL_FIELDS.bars.label} note="Only known after the trade." rows={bucketsBars.rows} />}
      </div>

      {exc && (
        <div className="fj-panel">
          <p className="fj-sub-title">How trades moved</p>
          <div className="fj-table-wrap">
            <table className="fj-table">
              <tbody>
                <tr><td>Average best move in your favor</td><td style={{ textAlign: "right" }}>{exc.mfe.toFixed(1)} pts</td></tr>
                <tr><td>Average worst move against you</td><td style={{ textAlign: "right" }}>{exc.mae.toFixed(1)} pts</td></tr>
                {exc.winMfe !== null && <tr><td>Winners: best move reached on average</td><td style={{ textAlign: "right" }}>{exc.winMfe.toFixed(1)} pts</td></tr>}
                {exc.loseMae !== null && <tr><td>Losers: worst move on average</td><td style={{ textAlign: "right" }}>{exc.loseMae.toFixed(1)} pts</td></tr>}
                {exc.losers > 0 && <tr><td>Losers that first went at least halfway to the target</td><td style={{ textAlign: "right" }}>{exc.reached} of {exc.losers} ({((exc.reached / exc.losers) * 100).toFixed(0)}%)</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="fj-panel">
        <p className="fj-sub-title" style={{ marginBottom: 2 }}>What if you'd skipped some trades?</p>
        <div className="fj-sub" style={{ marginBottom: 10 }}>Only measures known at entry can be tested. This replays the history you have, so a rule that looks great here can still fail on new trades, especially with a small sample.</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
          <span className="fj-sub">Only take trades where</span>
          <select className="fj-select" style={{ width: "auto" }} value={ruleKey} onChange={(e) => { setRuleKey(e.target.value); setRuleMode(SIGNAL_FIELDS[e.target.value].kind === "flag" ? "on" : "gte"); }}>
            {[...entryNum, ...entryFlag].map((k) => <option key={k} value={k}>{SIGNAL_FIELDS[k].label}</option>)}
          </select>
          {ruleField.kind === "flag" ? (
            <select className="fj-select" style={{ width: "auto" }} value={ruleMode} onChange={(e) => setRuleMode(e.target.value)}>
              <option value="on">is on</option><option value="off">is off</option>
            </select>
          ) : (
            <>
              <select className="fj-select" style={{ width: "auto" }} value={ruleMode} onChange={(e) => setRuleMode(e.target.value)}>
                <option value="gte">is at least</option><option value="lt">is below</option>
              </select>
              <input className="fj-input" style={{ width: 90 }} inputMode="decimal" placeholder="value" value={ruleVal} onChange={(e) => setRuleVal(e.target.value)} />
            </>
          )}
        </div>
        {rule ? (
          <div className="fj-table-wrap">
            <table className="fj-table">
              <thead><tr><th /><th style={{ textAlign: "right" }}>All trades</th><th style={{ textAlign: "right" }}>With rule</th><th style={{ textAlign: "right" }}>Skipped</th></tr></thead>
              <tbody>
                <tr><td>Trades</td><td style={{ textAlign: "right" }}>{rule.base.n}</td><td style={{ textAlign: "right" }}>{rule.kept.n}</td><td style={{ textAlign: "right" }}>{rule.skipped.n}</td></tr>
                <tr><td>Win rate</td><td style={{ textAlign: "right" }}>{pct(rule.base.winRate)}</td><td style={{ textAlign: "right" }}>{pct(rule.kept.winRate)}</td><td style={{ textAlign: "right" }}>{pct(rule.skipped.winRate)}</td></tr>
                <tr><td>Net P&amp;L</td><td style={{ textAlign: "right" }}>{money(rule.base.totalPnl)}</td><td style={{ textAlign: "right" }} className={rule.kept.totalPnl >= rule.base.totalPnl ? "fj-profit" : "fj-loss"}>{money(rule.kept.totalPnl)}</td><td style={{ textAlign: "right" }} className={rule.skipped.totalPnl >= 0 ? "fj-profit" : "fj-loss"}>{money(rule.skipped.totalPnl)}</td></tr>
                <tr><td>Avg per trade</td><td style={{ textAlign: "right" }}>{money(rule.base.expectancy)}</td><td style={{ textAlign: "right" }}>{money(rule.kept.expectancy)}</td><td style={{ textAlign: "right" }}>{money(rule.skipped.expectancy)}</td></tr>
                <tr><td>Profit factor</td><td style={{ textAlign: "right" }}>{fmtPF(rule.base.profitFactor)}</td><td style={{ textAlign: "right" }}>{fmtPF(rule.kept.profitFactor)}</td><td style={{ textAlign: "right" }}>{fmtPF(rule.skipped.profitFactor)}</td></tr>
                <tr><td>Max drawdown</td><td style={{ textAlign: "right" }}>{money(rule.base.maxDD)}</td><td style={{ textAlign: "right" }}>{money(rule.kept.maxDD)}</td><td style={{ textAlign: "right" }}>{money(rule.skipped.maxDD)}</td></tr>
              </tbody>
            </table>
          </div>
        ) : <div className="fj-sub">{ruleField.kind === "flag" ? "" : "Enter a value to test."}</div>}
      </div>
    </div>
  );
}


function Header({ onAdd, onBulkAdd, onSettings, onExport, onImportClick, onTradovateImportClick, onNinjaTraderImportClick, onSignalImportClick, onBackup, onRestoreClick, theme, onToggleTheme }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);
  useEffect(() => {
    if (!menuOpen) return;
    const close = (e) => { if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false); };
    const esc = (e) => { if (e.key === "Escape") setMenuOpen(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", esc); };
  }, [menuOpen]);
  const pick = (fn) => () => { setMenuOpen(false); fn(); };
  return (
    <div className="fj-header">
      <div className="fj-brand">
        <div className="fj-brand-mark" aria-hidden="true">
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="var(--on-accent)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><polyline points="2,13 7,8 10,11 16,4" /></svg>
        </div>
        <h1 className="fj-title">Position Ledger</h1>
      </div>
      <div className="fj-header-actions">
        <button
          className="fj-btn icon"
          onClick={onToggleTheme}
          aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
          title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
        >
          {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
        </button>
        <button className="fj-btn icon" onClick={onSettings} aria-label="Contract settings" title="Contract settings"><Settings2 size={16} /></button>
        <div className="fj-menu-wrap" ref={menuRef}>
          <button className="fj-btn" onClick={() => setMenuOpen((o) => !o)} aria-haspopup="menu" aria-expanded={menuOpen}>
            Import &amp; export <ChevronDown size={14} />
          </button>
          {menuOpen && (
            <div className="fj-menu" role="menu">
              <div className="fj-menu-group">Import trades</div>
              <button className="fj-menu-item" role="menuitem" onClick={pick(onTradovateImportClick)} title="Import a Tradovate Performance export and tag each trade before saving"><Upload size={15} /> Tradovate CSV</button>
              <button className="fj-menu-item" role="menuitem" onClick={pick(onNinjaTraderImportClick)} title="Import a NinjaTrader Trades export and tag each trade before saving"><Upload size={15} /> NinjaTrader CSV</button>
              <button className="fj-menu-item" role="menuitem" onClick={pick(onSignalImportClick)} title="Attach strength, ATR and other signal data to trades you already have"><Upload size={15} /> Signal sheets (advanced)</button>
              <button className="fj-menu-item" role="menuitem" onClick={pick(onImportClick)}><Upload size={15} /> Journal CSV</button>
              <div className="fj-menu-sep" />
              <div className="fj-menu-group">Export and backup</div>
              <button className="fj-menu-item" role="menuitem" onClick={pick(onExport)}><Download size={15} /> Export trades as CSV</button>
              <button className="fj-menu-item" role="menuitem" onClick={pick(onBackup)} title="Download everything — trades, accounts, settings — as one file"><Download size={15} /> Back up all data</button>
              <button className="fj-menu-item" role="menuitem" onClick={pick(onRestoreClick)} title="Restore trades, accounts, and settings from a backup file"><Upload size={15} /> Restore from backup</button>
            </div>
          )}
        </div>
        <button className="fj-btn" onClick={onBulkAdd} title="Log several trades at once in a table, instead of one at a time"><Plus size={15} /> Add multiple</button>
        <button className="fj-btn primary" onClick={onAdd}><Plus size={15} /> Add trade</button>
      </div>
    </div>
  );
}

function ImportPreviewModal({ preview, existingCount, onAppend, onReplace, onCancel }) {
  const { parsed, errorCount, total } = preview;
  return (
    <div className="fj-modal-backdrop" onClick={onCancel}>
      <div className="fj-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 460 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <p className="fj-panel-title" style={{ margin: 0 }}>Import CSV</p>
          <button className="fj-iconbtn" onClick={onCancel}><X size={18} /></button>
        </div>

        <div className="fj-sub" style={{ marginBottom: 14, lineHeight: 1.6 }}>
          Found <b style={{ color: "var(--text-bright)" }}>{parsed.length}</b> valid trade{parsed.length === 1 ? "" : "s"} out of {total} row{total === 1 ? "" : "s"}.
          {errorCount > 0 && (
            <> {errorCount} row{errorCount === 1 ? "" : "s"} skipped — missing or unreadable date/market/P&amp;L.</>
          )}
        </div>

        {parsed.length === 0 ? (
          <div className="fj-empty" style={{ padding: "10px 0 16px" }}>
            No valid trades found. Make sure the CSV has at least <span className="fj-mono">date</span>, <span className="fj-mono">market</span>, and <span className="fj-mono">pnl</span> columns.
          </div>
        ) : (
          <div className="fj-sub" style={{ marginBottom: 16 }}>
            You currently have <b style={{ color: "var(--text-bright)" }}>{existingCount}</b> trade{existingCount === 1 ? "" : "s"} logged. Choose how to bring these in:
          </div>
        )}

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
          <button className="fj-btn" onClick={onCancel}>Cancel</button>
          {parsed.length > 0 && (
            <>
              <button className="fj-btn danger" onClick={onReplace}>Replace all trades</button>
              <button className="fj-btn primary" onClick={onAppend}>Append to existing</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------- timeline / notes ----------

function NoteForm({ initial, strategies, settings, accounts, defaultLinks, onSave, onCancel }) {
  const [date, setDate] = useState(initial?.date || new Date().toISOString().slice(0, 10));
  const [category, setCategory] = useState(initial?.category || (defaultLinks?.[0]?.type) || "general");
  const [links, setLinks] = useState(initial ? getNoteLinks(initial) : (defaultLinks || []));
  const [title, setTitle] = useState(initial?.title || "");
  const [body, setBody] = useState(initial?.body || "");
  const [error, setError] = useState("");

  const toggleLink = (type, key) => {
    setLinks((prev) => {
      const exists = prev.some((l) => l.type === type && l.key === key);
      if (exists) return prev.filter((l) => !(l.type === type && l.key === key));
      return [...prev, { type, key }];
    });
  };
  const isLinked = (type, key) => links.some((l) => l.type === type && l.key === key);

  const submit = (e) => {
    e.preventDefault();
    if (!title.trim()) { setError("Give the note a title."); return; }
    onSave({ date, category, links, title: title.trim(), body: body.trim() });
  };

  return (
    <form onSubmit={submit} className="fj-panel" style={{ marginBottom: 14 }}>
      <div className="fj-form-row" style={{ gridTemplateColumns: "150px 1fr", marginBottom: 10 }}>
        <div className="fj-form-field">
          <label>Date</label>
          <input type="date" className="fj-input" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <div className="fj-form-field">
          <label>Category</label>
          <select className="fj-select" value={category} onChange={(e) => setCategory(e.target.value)}>
            {NOTE_CATEGORIES.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
          </select>
        </div>
      </div>

      {strategies.length > 0 && (
        <div className="fj-form-field" style={{ marginBottom: 10 }}>
          <label>Link to strategies (optional, select any number)</label>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {strategies.map((s) => {
              const active = isLinked("strategy", s);
              return (
                <span key={s} className="fj-chip" style={active ? { background: "var(--amber)", borderColor: "var(--amber)", color: "var(--on-accent)", fontWeight: 600 } : undefined} onClick={() => toggleLink("strategy", s)}>
                  {s}
                </span>
              );
            })}
          </div>
        </div>
      )}

      <div className="fj-form-field" style={{ marginBottom: 10 }}>
        <label>Link to markets (optional, select any number)</label>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {Object.keys(settings).map((m) => {
            const active = isLinked("market", m);
            return (
              <span key={m} className="fj-chip" style={active ? { background: "var(--amber)", borderColor: "var(--amber)", color: "var(--on-accent)", fontWeight: 600 } : undefined} onClick={() => toggleLink("market", m)}>
                {m}
              </span>
            );
          })}
        </div>
      </div>

      {accounts.length > 0 && (
        <div className="fj-form-field" style={{ marginBottom: 10 }}>
          <label>Link to accounts (optional, select any number)</label>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {accounts.map((a) => {
              const active = isLinked("account", a.name);
              return (
                <span key={a.id} className="fj-chip" style={active ? { background: "var(--amber)", borderColor: "var(--amber)", color: "var(--on-accent)", fontWeight: 600 } : undefined} onClick={() => toggleLink("account", a.name)}>
                  {a.name}
                </span>
              );
            })}
          </div>
        </div>
      )}

      <div className="fj-form-field" style={{ marginBottom: 10 }}>
        <label>Title</label>
        <input className="fj-input" style={{ fontFamily: "Inter, sans-serif" }} placeholder="e.g. Cut MES 9:30-10 base size from 4 to 2" value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div className="fj-form-field" style={{ marginBottom: 12 }}>
        <label>Details (optional)</label>
        <textarea
          className="fj-input" style={{ fontFamily: "Inter, sans-serif", width: "100%", minHeight: 70, resize: "vertical" }}
          placeholder="Why the change, what prompted it, anything worth remembering later…"
          value={body} onChange={(e) => setBody(e.target.value)}
        />
      </div>

      {error && <div className="fj-loss" style={{ fontSize: 12, marginBottom: 8 }}>{error}</div>}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button type="button" className="fj-btn" onClick={onCancel}>Cancel</button>
        <button type="submit" className="fj-btn primary">{initial ? "Save changes" : "Add note"}</button>
      </div>
    </form>
  );
}

function NoteCard({ note, strategies, settings, accounts, onEdit, onDelete, editing, onSaveEdit, onCancelEdit }) {
  if (editing) {
    return (
      <NoteForm
        initial={note} strategies={strategies} settings={settings} accounts={accounts}
        onSave={onSaveEdit} onCancel={onCancelEdit}
      />
    );
  }
  const links = getNoteLinks(note);
  return (
    <div className="fj-panel" style={{ marginBottom: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10 }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 6 }}>
            <span className={`fj-badge ${note.category === "general" ? "cash" : "eval"}`}>{NOTE_CATEGORY_LABEL[note.category] || note.category}</span>
            <span className="fj-sub" style={{ margin: 0 }}>{note.date}</span>
            {links.map((l, i) => (
              <span key={i} className="fj-sub" style={{ margin: 0, padding: "2px 8px", background: "var(--panel-alt)", border: "1px solid var(--border)", borderRadius: 20, fontSize: 11 }}>
                {l.type}: <b style={{ color: "var(--text)" }}>{l.key}</b>
              </span>
            ))}
          </div>
          <div style={{ fontWeight: 600, fontSize: 14.5 }}>{note.title}</div>
          {note.body && <div className="fj-sub" style={{ marginTop: 5, lineHeight: 1.5 }}>{note.body}</div>}
        </div>
        <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
          <button className="fj-iconbtn" onClick={onEdit}><Pencil size={13} /></button>
          <button className="fj-iconbtn" onClick={onDelete}><Trash2 size={13} /></button>
        </div>
      </div>
    </div>
  );
}

function NoteBanner({ note, strategies, settings, accounts, onEdit, onDelete, editing, onSaveEdit, onCancelEdit }) {
  const [open, setOpen] = useState(false);
  if (editing) {
    return (
      <NoteForm
        initial={note} strategies={strategies} settings={settings} accounts={accounts}
        onSave={onSaveEdit} onCancel={onCancelEdit}
      />
    );
  }
  const links = getNoteLinks(note);
  return (
    <div className="fj-panel" style={{ padding: 0, marginBottom: 8, overflow: "hidden" }}>
      <div
        style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", cursor: "pointer" }}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="fj-sub" style={{ margin: 0, fontFamily: "'Inter', sans-serif", flexShrink: 0 }}>{note.date}</span>
        <span className={`fj-badge ${note.category === "general" ? "cash" : "eval"}`} style={{ marginTop: 0, flexShrink: 0 }}>{NOTE_CATEGORY_LABEL[note.category] || note.category}</span>
        <span style={{ flex: 1, fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{note.title}</span>
        {open ? <ChevronUp size={14} color="var(--text-dim)" /> : <ChevronDown size={14} color="var(--text-dim)" />}
      </div>
      {open && (
        <div style={{ padding: "0 12px 12px" }}>
          {links.length > 0 && (
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
              {links.map((l, i) => (
                <span key={i} className="fj-sub" style={{ margin: 0, padding: "2px 8px", background: "var(--panel-alt)", border: "1px solid var(--border)", borderRadius: 20, fontSize: 11 }}>
                  {l.type}: <b style={{ color: "var(--text)" }}>{l.key}</b>
                </span>
              ))}
            </div>
          )}
          {note.body && <div className="fj-sub" style={{ lineHeight: 1.5, marginBottom: 8 }}>{note.body}</div>}
          <div style={{ display: "flex", gap: 6 }}>
            <button className="fj-iconbtn" onClick={onEdit}><Pencil size={13} /></button>
            <button className="fj-iconbtn" onClick={onDelete}><Trash2 size={13} /></button>
          </div>
        </div>
      )}
    </div>
  );
}

function TimelineView({ notes, strategies, settings, accounts, onAddNote, onUpdateNote, onDeleteNote }) {
  const [showAdd, setShowAdd] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [filterCategory, setFilterCategory] = useState("");

  const sorted = useMemo(
    () => [...notes]
      .filter((n) => !filterCategory || n.category === filterCategory)
      .sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id)),
    [notes, filterCategory]
  );

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10, marginBottom: 14 }}>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <span className={`fj-chip ${filterCategory === "" ? "active" : ""}`} onClick={() => setFilterCategory("")}>All</span>
          {NOTE_CATEGORIES.map(([key, label]) => (
            <span key={key} className={`fj-chip ${filterCategory === key ? "active" : ""}`} onClick={() => setFilterCategory(key)}>{label}</span>
          ))}
        </div>
        <button className="fj-btn primary" onClick={() => setShowAdd((s) => !s)}><Plus size={14} /> Add note</button>
      </div>

      {showAdd && (
        <NoteForm
          strategies={strategies} settings={settings} accounts={accounts}
          onSave={(note) => { onAddNote(note); setShowAdd(false); }}
          onCancel={() => setShowAdd(false)}
        />
      )}

      {sorted.length === 0 ? (
        <div className="fj-empty">No notes yet — log strategy changes, market additions, or anything else worth remembering later.</div>
      ) : (
        sorted.map((n) => (
          <NoteCard
            key={n.id}
            note={n}
            strategies={strategies} settings={settings} accounts={accounts}
            editing={editingId === n.id}
            onEdit={() => setEditingId(n.id)}
            onDelete={() => onDeleteNote(n.id)}
            onSaveEdit={(patch) => { onUpdateNote(n.id, patch); setEditingId(null); }}
            onCancelEdit={() => setEditingId(null)}
          />
        ))
      )}
    </div>
  );
}

function TradovateImportModal({ parsedRows, newMarkets, skippedCount, feesApplied, strategies, accounts, onConfirm, onCancel }) {
  const [rows, setRows] = useState(() => parsedRows.map((r) => ({ ...r, _id: uid() })));
  const [selected, setSelected] = useState(() => new Set(rows.map((r) => r._id)));
  const [bulkStrategy, setBulkStrategy] = useState("");
  const [bulkAccounts, setBulkAccounts] = useState([]);
  const [hourOffset, setHourOffset] = useState(1);

  const allSelected = selected.size > 0 && selected.size === rows.length;
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(rows.map((r) => r._id)));
  const toggleOne = (id) => setSelected((prev) => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  const updateRow = (id, patch) => setRows((prev) => prev.map((r) => r._id === id ? { ...r, ...patch } : r));
  const toggleRowAccount = (id, name) => setRows((prev) => prev.map((r) => {
    if (r._id !== id) return r;
    const has = r.accounts.includes(name);
    return { ...r, accounts: has ? r.accounts.filter((a) => a !== name) : [...r.accounts, name] };
  }));
  const toggleBulkAccount = (name) => setBulkAccounts((prev) => prev.includes(name) ? prev.filter((a) => a !== name) : [...prev, name]);

  const applyBulk = () => {
    if (selected.size === 0) return;
    setRows((prev) => prev.map((r) => selected.has(r._id)
      ? { ...r, strategy: bulkStrategy.trim() || r.strategy, accounts: bulkAccounts.length ? bulkAccounts : r.accounts }
      : r
    ));
  };

  // Date/time are derived from the raw timestamp + offset at render time
  // (not stored), so adjusting the offset updates every row immediately.
  const rowsWithTime = useMemo(
    () => rows.map((r) => ({ ...r, ...tradovateDateTimeAt(r._entryMs, hourOffset) })),
    [rows, hourOffset]
  );

  const untaggedCount = rows.filter((r) => !r.strategy).length;
  const totalPnl = rows.reduce((s, r) => s + r.pnl, 0);
  const selectedPnl = rows.filter((r) => selected.has(r._id)).reduce((s, r) => s + r.pnl, 0);

  return (
    <div className="fj-modal-backdrop" onClick={onCancel}>
      <div className="fj-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 940 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <div>
            <p className="fj-panel-title" style={{ margin: 0 }}>Tag Tradovate trades before importing</p>
            <div className="fj-sub" style={{ marginTop: 3 }}>
              {rows.length} trade{rows.length === 1 ? "" : "s"} parsed · net {money(totalPnl)} · <b style={{ color: "var(--text-bright)" }}>{selected.size} selected</b> for import (net {money(selectedPnl)}){untaggedCount > 0 ? ` · ${untaggedCount} still untagged` : ""}
            </div>
          </div>
          <button className="fj-iconbtn" onClick={onCancel}><X size={18} /></button>
        </div>

        {feesApplied > 0 && (
          <div className="fj-sub" style={{ marginBottom: 12, padding: "8px 10px", background: "var(--panel-alt)", borderRadius: 8, border: "1px solid var(--border)" }}>
            Per-contract fees from Contract Settings were applied: <b style={{ color: "var(--text-bright)" }}>{money(feesApplied)}</b> total, already subtracted from the P&amp;L shown below.
          </div>
        )}

        {skippedCount > 0 && (
          <div className="fj-sub" style={{ marginBottom: 12, padding: "8px 10px", background: "var(--panel-alt)", borderRadius: 8, border: "1px solid var(--border)" }}>
            {skippedCount} trade{skippedCount === 1 ? "" : "s"} in this file {skippedCount === 1 ? "was" : "were"} already imported and skipped automatically — only new trades are shown below.
          </div>
        )}

        {newMarkets.length > 0 && (
          <div className="fj-sub" style={{ marginBottom: 12, padding: "8px 10px", background: "var(--panel-alt)", borderRadius: 8, border: "1px solid var(--border)" }}>
            New market{newMarkets.length === 1 ? "" : "s"} detected: <b style={{ color: "var(--text-bright)" }}>{newMarkets.map((m) => m.symbol).join(", ")}</b> — added to Contract Settings automatically.
            {newMarkets.some((m) => !m.verified) && " Double-check the $/point value for any unfamiliar symbol — I only pre-filled it confidently for a few common contracts."}
          </div>
        )}

        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12, padding: "8px 10px", background: "var(--panel-alt)", borderRadius: 8, border: "1px solid var(--border)" }}>
          <label className="fj-sub" style={{ margin: 0, whiteSpace: "nowrap" }}>Hour offset (Tradovate time → your real time):</label>
          <input
            type="number" step="1" className="fj-input" style={{ width: 70 }}
            value={hourOffset} onChange={(e) => setHourOffset(Number(e.target.value) || 0)}
          />
          <span className="fj-sub" style={{ margin: 0 }}>
            {hourOffset === 0 ? "No adjustment" : `Every trade's date/time below is shown ${hourOffset > 0 ? "+" : ""}${hourOffset}h from what Tradovate exported.`}
          </span>
        </div>

        <div className="fj-sub" style={{ marginBottom: 8 }}>
          Select trades below, then set a strategy and/or accounts to apply to all of them at once — much faster than tagging one at a time.
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 14, padding: "10px 12px", background: "var(--panel-alt)", borderRadius: 10, border: "1px solid var(--border)" }}>
          <input
            className="fj-input" style={{ fontFamily: "Inter, sans-serif", width: 200 }}
            list="tradovate-strategy-list" placeholder="Strategy for selected…"
            value={bulkStrategy} onChange={(e) => setBulkStrategy(e.target.value)}
          />
          <datalist id="tradovate-strategy-list">
            {strategies.map((s) => <option key={s} value={s} />)}
          </datalist>
          {accounts.map((a) => (
            <span key={a.id} className={`fj-chip ${bulkAccounts.includes(a.name) ? "active" : ""}`} onClick={() => toggleBulkAccount(a.name)}>
              {a.name}
            </span>
          ))}
          <button type="button" className="fj-btn primary" style={{ marginLeft: "auto" }} disabled={selected.size === 0} onClick={applyBulk}>
            Apply to {selected.size} selected
          </button>
        </div>

        <div style={{ overflowX: "auto", maxHeight: "45vh", overflowY: "auto", border: "1px solid var(--border)", borderRadius: 10 }}>
          <table className="fj-table">
            <thead>
              <tr>
                <th><input type="checkbox" checked={allSelected} onChange={toggleAll} /></th>
                <th>Date</th><th>Time</th><th>Mkt</th><th>Dir</th><th>Qty</th><th>P&amp;L</th><th>Dur.</th>
                <th>Strategy</th><th>Accounts</th>
              </tr>
            </thead>
            <tbody>
              {rowsWithTime.map((r) => (
                <tr key={r._id}>
                  <td><input type="checkbox" checked={selected.has(r._id)} onChange={() => toggleOne(r._id)} /></td>
                  <td>{r.date}</td>
                  <td>{r.time}</td>
                  <td>{r.market}</td>
                  <td className={r.direction === "Short" ? "fj-loss" : "fj-profit"}>{r.direction}</td>
                  <td>{r.contracts}</td>
                  <td className={r.pnl >= 0 ? "fj-profit" : "fj-loss"}>{money(r.pnl)}</td>
                  <td>{formatDuration(r.durationSec)}</td>
                  <td>
                    <input
                      className="fj-input" style={{ fontFamily: "Inter, sans-serif", width: 150, fontSize: 12 }}
                      list="tradovate-strategy-list" placeholder="—"
                      value={r.strategy} onChange={(e) => updateRow(r._id, { strategy: e.target.value })}
                    />
                  </td>
                  <td>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 3, maxWidth: 160 }}>
                      {accounts.length === 0 && <span className="fj-sub">—</span>}
                      {accounts.map((a) => (
                        <span
                          key={a.id} className="fj-chip" style={{ fontSize: 10, padding: "2px 7px", ...(r.accounts.includes(a.name) ? { background: "var(--amber)", borderColor: "var(--amber)", color: "var(--on-accent)", fontWeight: 600 } : {}) }}
                          onClick={() => toggleRowAccount(r._id, a.name)}
                        >
                          {a.name}
                        </span>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 14 }}>
          <button className="fj-btn" onClick={onCancel}>Cancel</button>
          <button
            className="fj-btn primary" disabled={selected.size === 0}
            onClick={() => onConfirm(rowsWithTime.filter((r) => selected.has(r._id)))}
          >
            Import {selected.size} trade{selected.size === 1 ? "" : "s"}
          </button>
        </div>
      </div>
    </div>
  );
}


function NinjaTraderImportModal({ parsedRows, newMarkets, skippedCount, feesApplied, strategies, accounts, onConfirm, onCancel }) {
  const [rows, setRows] = useState(() => parsedRows.map((r) => ({ ...r, _id: uid() })));
  const [selected, setSelected] = useState(() => new Set(rows.map((r) => r._id)));
  const [bulkStrategy, setBulkStrategy] = useState("");
  const [bulkAccounts, setBulkAccounts] = useState([]);

  const allSelected = selected.size > 0 && selected.size === rows.length;
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(rows.map((r) => r._id)));
  const toggleOne = (id) => setSelected((prev) => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  const updateRow = (id, patch) => setRows((prev) => prev.map((r) => r._id === id ? { ...r, ...patch } : r));
  const toggleRowAccount = (id, name) => setRows((prev) => prev.map((r) => {
    if (r._id !== id) return r;
    const has = r.accounts.includes(name);
    return { ...r, accounts: has ? r.accounts.filter((a) => a !== name) : [...r.accounts, name] };
  }));
  const toggleBulkAccount = (name) => setBulkAccounts((prev) => prev.includes(name) ? prev.filter((a) => a !== name) : [...prev, name]);

  const applyBulk = () => {
    if (selected.size === 0) return;
    setRows((prev) => prev.map((r) => selected.has(r._id)
      ? { ...r, strategy: bulkStrategy.trim() || r.strategy, accounts: bulkAccounts.length ? bulkAccounts : r.accounts }
      : r
    ));
  };

  // NinjaTrader timestamps come straight from the machine it ran on, so
  // unlike Tradovate's export there's no known VPS offset to correct for.
  const rowsWithTime = useMemo(
    () => rows.map((r) => ({ ...r, ...tradovateDateTimeAt(r._entryMs, 0) })),
    [rows]
  );

  const untaggedCount = rows.filter((r) => !r.strategy).length;
  const totalPnl = rows.reduce((s, r) => s + r.pnl, 0);
  const selectedPnl = rows.filter((r) => selected.has(r._id)).reduce((s, r) => s + r.pnl, 0);

  return (
    <div className="fj-modal-backdrop" onClick={onCancel}>
      <div className="fj-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 1020 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <div>
            <p className="fj-panel-title" style={{ margin: 0 }}>Tag NinjaTrader trades before importing</p>
            <div className="fj-sub" style={{ marginTop: 3 }}>
              {rows.length} trade{rows.length === 1 ? "" : "s"} parsed · net {money(totalPnl)} · <b style={{ color: "var(--text-bright)" }}>{selected.size} selected</b> for import (net {money(selectedPnl)}){untaggedCount > 0 ? ` · ${untaggedCount} still untagged` : ""}
            </div>
          </div>
          <button className="fj-iconbtn" onClick={onCancel}><X size={18} /></button>
        </div>

        {feesApplied > 0 && (
          <div className="fj-sub" style={{ marginBottom: 12, padding: "8px 10px", background: "var(--panel-alt)", borderRadius: 8, border: "1px solid var(--border)" }}>
            Per-contract fees from Contract Settings were applied: <b style={{ color: "var(--text-bright)" }}>{money(feesApplied)}</b> total, already subtracted from the P&amp;L shown below.
          </div>
        )}

        {skippedCount > 0 && (
          <div className="fj-sub" style={{ marginBottom: 12, padding: "8px 10px", background: "var(--panel-alt)", borderRadius: 8, border: "1px solid var(--border)" }}>
            {skippedCount} trade{skippedCount === 1 ? "" : "s"} in this file {skippedCount === 1 ? "was" : "were"} already imported and skipped automatically — only new trades are shown below.
          </div>
        )}

        {newMarkets.length > 0 && (
          <div className="fj-sub" style={{ marginBottom: 12, padding: "8px 10px", background: "var(--panel-alt)", borderRadius: 8, border: "1px solid var(--border)" }}>
            New market{newMarkets.length === 1 ? "" : "s"} detected: <b style={{ color: "var(--text-bright)" }}>{newMarkets.map((m) => m.symbol).join(", ")}</b> — added to Contract Settings automatically.
            {newMarkets.some((m) => !m.verified) && " Double-check the $/point value for any unfamiliar symbol — I only pre-filled it confidently for a few common contracts."}
          </div>
        )}

        <div className="fj-sub" style={{ marginBottom: 8 }}>
          Select trades below, then set a strategy and/or accounts to apply to all of them at once — much faster than tagging one at a time.
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 14, padding: "10px 12px", background: "var(--panel-alt)", borderRadius: 10, border: "1px solid var(--border)" }}>
          <input
            className="fj-input" style={{ fontFamily: "Inter, sans-serif", width: 200 }}
            list="ninjatrader-strategy-list" placeholder="Strategy for selected…"
            value={bulkStrategy} onChange={(e) => setBulkStrategy(e.target.value)}
          />
          <datalist id="ninjatrader-strategy-list">
            {strategies.map((s) => <option key={s} value={s} />)}
          </datalist>
          {accounts.map((a) => (
            <span key={a.id} className={`fj-chip ${bulkAccounts.includes(a.name) ? "active" : ""}`} onClick={() => toggleBulkAccount(a.name)}>
              {a.name}
            </span>
          ))}
          <button type="button" className="fj-btn primary" style={{ marginLeft: "auto" }} disabled={selected.size === 0} onClick={applyBulk}>
            Apply to {selected.size} selected
          </button>
        </div>

        <div style={{ overflowX: "auto", maxHeight: "45vh", overflowY: "auto", border: "1px solid var(--border)", borderRadius: 10 }}>
          <table className="fj-table">
            <thead>
              <tr>
                <th><input type="checkbox" checked={allSelected} onChange={toggleAll} /></th>
                <th>Date</th><th>Time</th><th>Mkt</th><th>Dir</th><th>Qty</th>
                <th>Entry</th><th>Exit</th><th>P&amp;L</th><th>Dur.</th>
                <th>Strategy</th><th>Accounts</th>
              </tr>
            </thead>
            <tbody>
              {rowsWithTime.map((r) => (
                <tr key={r._id}>
                  <td><input type="checkbox" checked={selected.has(r._id)} onChange={() => toggleOne(r._id)} /></td>
                  <td>{r.date}</td>
                  <td>{r.time}</td>
                  <td>{r.market}</td>
                  <td className={r.direction === "Short" ? "fj-loss" : "fj-profit"}>{r.direction}</td>
                  <td>{r.contracts}</td>
                  <td>{r.entry}</td>
                  <td>{r.exit}</td>
                  <td className={r.pnl >= 0 ? "fj-profit" : "fj-loss"}>{money(r.pnl)}</td>
                  <td>{formatDuration(r.durationSec)}</td>
                  <td>
                    <input
                      className="fj-input" style={{ fontFamily: "Inter, sans-serif", width: 150, fontSize: 12 }}
                      list="ninjatrader-strategy-list" placeholder="—"
                      value={r.strategy} onChange={(e) => updateRow(r._id, { strategy: e.target.value })}
                    />
                  </td>
                  <td>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 3, maxWidth: 160 }}>
                      {accounts.length === 0 && <span className="fj-sub">—</span>}
                      {accounts.map((a) => (
                        <span
                          key={a.id} className="fj-chip" style={{ fontSize: 10, padding: "2px 7px", ...(r.accounts.includes(a.name) ? { background: "var(--amber)", borderColor: "var(--amber)", color: "var(--on-accent)", fontWeight: 600 } : {}) }}
                          onClick={() => toggleRowAccount(r._id, a.name)}
                        >
                          {a.name}
                        </span>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 14 }}>
          <button className="fj-btn" onClick={onCancel}>Cancel</button>
          <button
            className="fj-btn primary" disabled={selected.size === 0}
            onClick={() => onConfirm(rowsWithTime.filter((r) => selected.has(r._id)))}
          >
            Import {selected.size} trade{selected.size === 1 ? "" : "s"}
          </button>
        </div>
      </div>
    </div>
  );
}


function RestorePreviewModal({ preview, existingTradeCount, existingAccountCount, onConfirm, onCancel }) {
  return (
    <div className="fj-modal-backdrop" onClick={onCancel}>
      <div className="fj-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 460 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <p className="fj-panel-title" style={{ margin: 0 }}>Restore backup</p>
          <button className="fj-iconbtn" onClick={onCancel}><X size={18} /></button>
        </div>

        {preview.error ? (
          <div className="fj-loss" style={{ fontSize: 13, marginBottom: 16 }}>{preview.error}</div>
        ) : (
          <>
            <div className="fj-sub" style={{ marginBottom: 14, lineHeight: 1.6 }}>
              This backup contains <b style={{ color: "var(--text-bright)" }}>{preview.tradeCount}</b> trade{preview.tradeCount === 1 ? "" : "s"} and <b style={{ color: "var(--text-bright)" }}>{preview.accountCount}</b> account{preview.accountCount === 1 ? "" : "s"}.
            </div>
            <div className="fj-loss" style={{ fontSize: 12.5, marginBottom: 16, lineHeight: 1.6 }}>
              Restoring replaces everything currently in this journal — your {existingTradeCount} current trade{existingTradeCount === 1 ? "" : "s"} and {existingAccountCount} current account{existingAccountCount === 1 ? "" : "s"} will be overwritten. This can't be undone unless you have another backup of the current data.
            </div>
          </>
        )}

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button className="fj-btn" onClick={onCancel}>Cancel</button>
          {!preview.error && (
            <button className="fj-btn danger" onClick={onConfirm}>Replace everything</button>
          )}
        </div>
      </div>
    </div>
  );
}


const ACCENT_PALETTE = ["#2F6FEB", "#7C5CE0", "#0F9D8A", "#D6409F", "#E8590C", "#5B6B7B", "#A0623A", "#3B4FC4"];

// Commonly published prop-firm evaluation rules as of mid-2026. These firms
// change pricing and rules often (Apex overhauled its entire structure in
// March 2026) — treat these as a fast starting point, not gospel. Every
// field is editable after picking a preset.
const PROP_PRESETS = [
  {
    key: "apex-50k-eod",
    label: "Apex Trader Funding — $50K (EOD)",
    startingBalance: 50000, drawdownAmount: 2000, profitTarget: 3000,
    drawdownType: "eod", trailingLock: "target",
  },
  {
    key: "topstep-50k",
    label: "Topstep — $50K Trading Combine",
    startingBalance: 50000, drawdownAmount: 2000, profitTarget: 3000,
    drawdownType: "eod", trailingLock: "starting",
  },
];

function SettingsPanel({ settings, setSettings, trades, setTrades, onClose }) {
  const [pendingApply, setPendingApply] = useState(null); // market symbol awaiting confirm
  const [newSymbol, setNewSymbol] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [newMultiplier, setNewMultiplier] = useState("");
  const [newCategory, setNewCategory] = useState("micro");
  const [error, setError] = useState("");

  const markets = Object.keys(settings);

  const addMarket = (e) => {
    e.preventDefault();
    const sym = newSymbol.trim().toUpperCase();
    if (!sym) { setError("Enter a symbol, e.g. M2K."); return; }
    if (settings[sym]) { setError(`${sym} is already in your market list.`); return; }
    const accent = ACCENT_PALETTE[markets.length % ACCENT_PALETTE.length];
    setSettings((s) => ({
      ...s,
      [sym]: { label: newLabel.trim() || sym, multiplier: Number(newMultiplier) || 1, accent, category: newCategory, feePerContract: 0 },
    }));
    setNewSymbol(""); setNewLabel(""); setNewMultiplier(""); setNewCategory("micro"); setError("");
  };

  // Trades in this market with no fee recorded yet — the ones a fee change
  // can be back-filled onto. Trades that already carry a fee are never
  // touched, which also makes the back-fill safe to run twice.
  const backfillCandidates = (sym) => (trades || []).filter((t) => t.market === sym && !(Number(t.fees) > 0));

  const applyFeeToExisting = (sym) => {
    const perContract = Number(settings[sym]?.feePerContract) || 0;
    if (!perContract) { setPendingApply(null); return; }
    setTrades((prev) => prev.map((t) => {
      if (t.market !== sym || Number(t.fees) > 0) return t;
      const fee = Number((perContract * (Number(t.contracts) || 1)).toFixed(2));
      return { ...t, fees: fee, pnl: Number((t.pnl - fee).toFixed(2)) };
    }));
    setPendingApply(null);
  };

  const removeMarket = (sym) => {
    setSettings((s) => {
      const copy = { ...s };
      delete copy[sym];
      return copy;
    });
  };

  return (
    <div className="fj-panel">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <p className="fj-panel-title" style={{ margin: 0 }}>Markets &amp; point values ($/point) — used by the P&amp;L calculator</p>
        <button className="fj-iconbtn" onClick={onClose}><X size={16} /></button>
      </div>

      <div className="fj-form-row" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(210px,1fr))" }}>
        {markets.map((m) => (
          <div key={m} className="fj-form-field" style={{ minWidth: 0 }}>
            <label style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6 }}>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m} — {settings[m].label}</span>
              <button
                type="button" className="fj-iconbtn" style={{ padding: 2, flexShrink: 0 }}
                onClick={() => removeMarket(m)} title={`Remove ${m}`}
              >
                <Trash2 size={12} />
              </button>
            </label>
            <input
              type="number" step="0.01" className="fj-input" style={{ width: "100%", marginBottom: 6 }}
              value={settings[m].multiplier}
              onChange={(e) => setSettings((s) => ({ ...s, [m]: { ...s[m], multiplier: e.target.value } }))}
            />
            <label className="fj-sub" style={{ display: "block", margin: "2px 0 3px", fontSize: 10.5 }}>Round-trip fee / contract ($)</label>
            <input
              type="number" step="0.01" min="0" className="fj-input" style={{ width: "100%", marginBottom: 6 }}
              value={settings[m].feePerContract ?? ""} placeholder="0.00"
              onChange={(e) => { setPendingApply(null); setSettings((s) => ({ ...s, [m]: { ...s[m], feePerContract: e.target.value } })); }}
            />
            {Number(settings[m].feePerContract) > 0 && (() => {
              const candidates = backfillCandidates(m);
              if (candidates.length === 0) return null;
              const perContract = Number(settings[m].feePerContract);
              const totalFee = candidates.reduce((sum, t) => sum + perContract * (Number(t.contracts) || 1), 0);
              return pendingApply === m ? (
                <div className="fj-sub" style={{ marginBottom: 6, fontSize: 11, lineHeight: 1.5 }}>
                  Subtract <b style={{ color: "var(--text-bright)" }}>{money(totalFee)}</b> from {candidates.length} existing {m} trade{candidates.length === 1 ? "" : "s"} with no fee recorded?
                  <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
                    <button type="button" className="fj-btn primary" style={{ padding: "3px 8px", fontSize: 11 }} onClick={() => applyFeeToExisting(m)}>Apply</button>
                    <button type="button" className="fj-btn" style={{ padding: "3px 8px", fontSize: 11 }} onClick={() => setPendingApply(null)}>Cancel</button>
                  </div>
                </div>
              ) : (
                <button type="button" className="fj-btn" style={{ width: "100%", marginBottom: 6, padding: "4px 8px", fontSize: 11 }} onClick={() => setPendingApply(m)}>
                  Apply to {candidates.length} existing trade{candidates.length === 1 ? "" : "s"}…
                </button>
              );
            })()}
            <select
              className="fj-select" style={{ width: "100%", fontSize: 11.5 }}
              value={settings[m].category || "micro"}
              onChange={(e) => setSettings((s) => ({ ...s, [m]: { ...s[m], category: e.target.value } }))}
            >
              <option value="micro">Micro</option>
              <option value="mini">Mini</option>
            </select>
          </div>
        ))}
      </div>

      <div className="fj-sub" style={{ margin: "10px 0" }}>
        Point values only affect the optional entry/exit calculator in the trade form — P&amp;L is always stored as a plain number you can edit directly. The round-trip fee (e.g. NQ $5.76 = $2.88 a side) is multiplied by contracts and subtracted from P&amp;L on every new trade, bulk entry, and Tradovate/NinjaTrader import; “Apply to existing trades” back-fills only trades that have no fee recorded yet. Micro/Mini controls the toggle on the Portfolio tab. Removing a market keeps any trades already logged under it in your journal, but hides it from the ticker strip and By Market breakdown.
      </div>

      <form onSubmit={addMarket} className="fj-form-row" style={{ gridTemplateColumns: "90px 1fr 100px 100px auto", alignItems: "end", marginBottom: 0 }}>
        <div className="fj-form-field">
          <label>Symbol</label>
          <input className="fj-input" placeholder="RTY" value={newSymbol} onChange={(e) => setNewSymbol(e.target.value)} />
        </div>
        <div className="fj-form-field">
          <label>Name</label>
          <input className="fj-input" style={{ fontFamily: "Inter, sans-serif" }} placeholder="E-mini Russell 2000" value={newLabel} onChange={(e) => setNewLabel(e.target.value)} />
        </div>
        <div className="fj-form-field">
          <label>$/point</label>
          <input type="number" step="0.01" className="fj-input" placeholder="50" value={newMultiplier} onChange={(e) => setNewMultiplier(e.target.value)} />
        </div>
        <div className="fj-form-field">
          <label>Size</label>
          <select className="fj-select" value={newCategory} onChange={(e) => setNewCategory(e.target.value)}>
            <option value="micro">Micro</option>
            <option value="mini">Mini</option>
          </select>
        </div>
        <button type="submit" className="fj-btn primary" style={{ height: 37 }}><Plus size={14} /> Add market</button>
      </form>
      {error && <div className="fj-loss" style={{ fontSize: 12, marginTop: 6 }}>{error}</div>}
    </div>
  );
}

// Compact multi-select: one button + a checklist popover, instead of a wall of chips.
function MultiPick({ label, options, selected, onToggle, onClear }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const close = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const esc = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", esc); };
  }, [open]);
  return (
    <div className="fj-menu-wrap" ref={ref}>
      <button className={`fj-btn ${selected.length ? "fj-btn-on" : ""}`} onClick={() => setOpen((o) => !o)} aria-haspopup="listbox" aria-expanded={open}>
        {label}{selected.length > 0 && <span className="fj-count">{selected.length}</span>} <ChevronDown size={14} />
      </button>
      {open && (
        <div className="fj-menu" style={{ left: 0, right: "auto", maxHeight: 340, overflowY: "auto" }} role="listbox" aria-multiselectable="true">
          {options.length === 0 && <div className="fj-menu-group">None yet</div>}
          {options.map((o) => (
            <label key={o} className="fj-menu-item" style={{ cursor: "pointer" }}>
              <input type="checkbox" checked={selected.includes(o)} onChange={() => onToggle(o)} /> {o}
            </label>
          ))}
          {selected.length > 0 && (<><div className="fj-menu-sep" /><button className="fj-menu-item" onClick={onClear}>Clear selection</button></>)}
        </div>
      )}
    </div>
  );
}

// ---------- filter bar ----------

function FilterBar({ settings, strategies, accounts, filterMarkets, filterStrategies, filterAccounts, toggleMarketFilter, toggleStrategyFilter, toggleAccountFilter, dateFrom, dateTo, setDateFrom, setDateTo, onReset }) {
  const markets = Object.keys(settings);
  return (
    <div className="fj-filterbar">
      <MultiPick label="Market" options={markets} selected={filterMarkets} onToggle={toggleMarketFilter} onClear={() => filterMarkets.forEach(toggleMarketFilter)} />
      <MultiPick label="Strategy" options={strategies} selected={filterStrategies} onToggle={toggleStrategyFilter} onClear={() => filterStrategies.forEach(toggleStrategyFilter)} />
      {accounts.length > 0 && (
        <MultiPick label="Account" options={accounts.map((a) => a.name)} selected={filterAccounts} onToggle={toggleAccountFilter} onClear={() => filterAccounts.forEach(toggleAccountFilter)} />
      )}
      <span className="fj-sub" style={{ marginLeft: 10 }}>From</span>
      <input type="date" className="fj-date-input" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
      <span className="fj-sub">To</span>
      <input type="date" className="fj-date-input" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
      <button className="fj-btn" style={{ marginLeft: "auto", padding: "5px 10px" }} onClick={onReset}>
        <RotateCcw size={13} /> Reset
      </button>
    </div>
  );
}

// ---------- trade log (with its own local filters — not shared across tabs) ----------

function TradeLogView({ trades, strategies, accounts, settings, onEdit, onDelete, onBulkUpdate, onBulkCopy }) {
  const [filterMarkets, setFilterMarkets] = useState([]);
  const [filterStrategies, setFilterStrategies] = useState([]);
  const [filterAccounts, setFilterAccounts] = useState([]);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const toggleMarketFilter = (m) => setFilterMarkets((p) => p.includes(m) ? p.filter((x) => x !== m) : [...p, m]);
  const toggleStrategyFilter = (s) => setFilterStrategies((p) => p.includes(s) ? p.filter((x) => x !== s) : [...p, s]);
  const toggleAccountFilter = (a) => setFilterAccounts((p) => p.includes(a) ? p.filter((x) => x !== a) : [...p, a]);
  const resetFilters = () => { setFilterMarkets([]); setFilterStrategies([]); setFilterAccounts([]); setDateFrom(""); setDateTo(""); };

  const filtered = useMemo(() => trades.filter((t) => {
    if (filterMarkets.length && !filterMarkets.includes(t.market)) return false;
    if (filterStrategies.length && !filterStrategies.includes(t.strategy)) return false;
    if (filterAccounts.length && !(t.accounts || []).some((a) => filterAccounts.includes(a))) return false;
    if (dateFrom && t.date < dateFrom) return false;
    if (dateTo && t.date > dateTo) return false;
    return true;
  }), [trades, filterMarkets, filterStrategies, filterAccounts, dateFrom, dateTo]);

  return (
    <div>
      <FilterBar
        settings={settings} strategies={strategies} accounts={accounts}
        filterMarkets={filterMarkets} filterStrategies={filterStrategies} filterAccounts={filterAccounts}
        toggleMarketFilter={toggleMarketFilter} toggleStrategyFilter={toggleStrategyFilter} toggleAccountFilter={toggleAccountFilter}
        dateFrom={dateFrom} dateTo={dateTo} setDateFrom={setDateFrom} setDateTo={setDateTo}
        onReset={resetFilters}
      />
      <TradeLog trades={filtered} strategies={strategies} accounts={accounts} onEdit={onEdit} onDelete={onDelete} onBulkUpdate={onBulkUpdate} onBulkCopy={onBulkCopy} />
    </div>
  );
}

function OptimizerView({ trades, strategies, accounts }) {
  const [selectedStrategy, setSelectedStrategy] = useState(strategies[0] || "");
  const [buffer, setBuffer] = useState(2000);
  const [baseContracts, setBaseContracts] = useState(1);
  const [capDepth, setCapDepth] = useState(3);
  const [numTrades, setNumTrades] = useState(100);
  const [accountPick, setAccountPick] = useState("");

  const entityTrades = useMemo(
    () => trades.filter((t) => t.strategy === selectedStrategy),
    [trades, selectedStrategy]
  );

  const bufferNum = Math.max(Number(buffer) || 0, 0);
  const baseNum = Math.max(Number(baseContracts) || 1, 1);
  const capDepthNum = Math.max(Number(capDepth) || 1, 1);
  const tradesAheadNum = Math.max(Number(numTrades) || 1, 1);

  const flatAtBase = useMemo(() => flattenTrades(entityTrades, baseNum), [entityTrades, baseNum]);
  const flatStats = useMemo(() => calcStats(flatAtBase), [flatAtBase]);

  // The strategy's own actual base size — the smallest contract count it
  // was really traded at (same convention used elsewhere in this app for
  // detecting a martingale's base). Needed to rescale the WHOLE historical
  // martingale sequence proportionally when the stated base size changes —
  // futures P&L scales linearly with size, so scaling the base scales
  // every step in the sequence by the same factor.
  const historicalBase = useMemo(() => {
    const sizes = entityTrades.map((t) => t.contracts || 1).filter((c) => c > 0);
    return sizes.length ? Math.min(...sizes) : 1;
  }, [entityTrades]);

  const scaledMartingaleTrades = useMemo(() => {
    const scaleFactor = baseNum / historicalBase;
    return entityTrades.map((t) => ({
      ...t,
      contracts: Math.max(1, Math.round((t.contracts || 1) * scaleFactor)),
      pnl: t.pnl * scaleFactor,
    }));
  }, [entityTrades, baseNum, historicalBase]);
  const scaledMartingaleStats = useMemo(() => calcStats(scaledMartingaleTrades), [scaledMartingaleTrades]);

  const depthSweep = useMemo(
    () => computeMartingaleDepthSweep(entityTrades, { baseContracts: baseNum, capDepth: capDepthNum, buffer: bufferNum, numTrades: tradesAheadNum }),
    [entityTrades, baseNum, capDepthNum, bufferNum, tradesAheadNum]
  );

  // Real historical performance at each cap level, base 1x up to 16x — not
  // a theoretical projection, the actual trades re-sized and re-summed as
  // if the martingale had been capped there from the start.
  const capSweep = useMemo(
    () => computeMartingaleCapSweep(entityTrades, { baseContracts: baseNum, caps: [1, 2, 4, 8, 16] }),
    [entityTrades, baseNum]
  );

  const ror = useMemo(
    () => computeRiskOfRuin(flatAtBase, { buffer: Math.max(bufferNum, 1), numTrades: tradesAheadNum }),
    [flatAtBase, bufferNum, tradesAheadNum]
  );

  const applyAccountFloor = (accountId) => {
    setAccountPick(accountId);
    const acct = accounts.find((a) => a.id === accountId);
    if (!acct) return;
    const timelineData = buildAccountBalanceTimeline(acct, trades);
    const { floor } = computeAccountFloor(acct, timelineData);
    const distance = timelineData.currentBalance - floor;
    if (distance > 0) setBuffer(Math.round(distance));
  };

  const pnlDelta = scaledMartingaleStats.totalPnl - flatStats.totalPnl;
  const ddDelta = scaledMartingaleStats.maxDD - flatStats.maxDD; // positive = martingale drew down more
  const scaleFactor = baseNum / historicalBase;

  return (
    <div>
      <div className="fj-panel">
        <p className="fj-panel-title">Strategy optimizer</p>
        <div className="fj-sub" style={{ marginBottom: 14 }}>
          Pick a strategy and a buffer to protect, and every number below recalculates against that strategy's real win/loss distribution — no single number here is asserted as "correct"; the depth sweep is meant to show you where the tradeoffs actually sit so you can pick based on your own risk tolerance.
        </div>

        <div className="fj-form-row" style={{ gridTemplateColumns: "1fr 1fr", marginBottom: 10 }}>
          <div className="fj-form-field">
            <label>Strategy</label>
            <select className="fj-select" value={selectedStrategy} onChange={(e) => setSelectedStrategy(e.target.value)}>
              <option value="">Select…</option>
              {strategies.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div className="fj-form-field">
            <label>Buffer to protect ($)</label>
            <input type="number" step="100" className="fj-input" value={buffer} onChange={(e) => { setBuffer(e.target.value); setAccountPick(""); }} />
          </div>
        </div>

        {accounts.length > 0 && (
          <div className="fj-form-field" style={{ marginBottom: 10 }}>
            <label>Or fill buffer from an account's current distance to floor</label>
            <select className="fj-select" value={accountPick} onChange={(e) => applyAccountFloor(e.target.value)}>
              <option value="">None — enter manually above</option>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </div>
        )}

        <div className="fj-form-row" style={{ gridTemplateColumns: "1fr 1fr 1fr" }}>
          <div className="fj-form-field">
            <label>Base contract size (flat, before any martingale)</label>
            <input type="number" step="1" className="fj-input" value={baseContracts} onChange={(e) => setBaseContracts(e.target.value)} />
          </div>
          <div className="fj-form-field">
            <label>Max martingale depth (cap)</label>
            <input type="number" step="1" className="fj-input" value={capDepth} onChange={(e) => setCapDepth(e.target.value)} />
          </div>
          <div className="fj-form-field">
            <label>Trades ahead (shared by every projection below)</label>
            <input type="number" step="10" className="fj-input" value={numTrades} onChange={(e) => setNumTrades(e.target.value)} />
          </div>
        </div>
      </div>

      {!selectedStrategy || entityTrades.length === 0 ? (
        <div className="fj-empty">Select a strategy with logged trades to see its numbers.</div>
      ) : (
        <>
          <div className="fj-panel">
            <p className="fj-panel-title">Martingale impact — keep enabled or disable?</p>
            <div className="fj-sub" style={{ marginBottom: 12 }}>
              This strategy was actually traded at a base of {historicalBase} contract{historicalBase === 1 ? "" : "s"}.
              {scaleFactor !== 1
                ? ` "As traded" below is rescaled ×${scaleFactor.toFixed(2)} to match your stated base of ${baseNum} — same win/loss pattern, sized as if the whole martingale sequence had started from ${baseNum} instead.`
                : ` Your stated base matches what was actually traded, so no rescaling is applied.`}
              {" "}Compared against flat sizing at that same base — same trades, same wins and losses, only the sizing changes.
            </div>
            <div style={{ overflowX: "auto" }}>
              <table className="fj-table">
                <thead>
                  <tr><th></th><th>Total P&amp;L</th><th>Max drawdown</th><th>Profit factor</th><th>Win rate</th></tr>
                </thead>
                <tbody>
                  <tr>
                    <td style={{ fontFamily: "Inter, sans-serif", fontWeight: 600 }}>As traded (martingale)</td>
                    <td className={scaledMartingaleStats.totalPnl >= 0 ? "fj-profit" : "fj-loss"}>{money(scaledMartingaleStats.totalPnl)}</td>
                    <td className="fj-loss">{money(-scaledMartingaleStats.maxDD)}</td>
                    <td>{scaledMartingaleStats.profitFactor === null ? "—" : scaledMartingaleStats.profitFactor === Infinity ? "∞" : scaledMartingaleStats.profitFactor.toFixed(2)}</td>
                    <td>{pct(scaledMartingaleStats.winRate)}</td>
                  </tr>
                  <tr>
                    <td style={{ fontFamily: "Inter, sans-serif", fontWeight: 600 }}>Flat at base size</td>
                    <td className={flatStats.totalPnl >= 0 ? "fj-profit" : "fj-loss"}>{money(flatStats.totalPnl)}</td>
                    <td className="fj-loss">{money(-flatStats.maxDD)}</td>
                    <td>{flatStats.profitFactor === null ? "—" : flatStats.profitFactor === Infinity ? "∞" : flatStats.profitFactor.toFixed(2)}</td>
                    <td>{pct(flatStats.winRate)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div className="fj-sub" style={{ marginTop: 10 }}>
              Martingale sizing {pnlDelta >= 0 ? "added" : "cost"} <b style={{ color: "var(--text)" }}>{money(Math.abs(pnlDelta))}</b> in total P&amp;L
              {" "}and {ddDelta >= 0 ? "increased" : "reduced"} max drawdown by <b style={{ color: "var(--text)" }}>{money(Math.abs(ddDelta))}</b>, compared to flat sizing.
              Win rate is identical either way — sizing doesn't change which trades won or lost.
            </div>
          </div>

          <div className="fj-panel">
            <p className="fj-panel-title">Martingale cap sweep — performance by max size</p>
            <div className="fj-sub" style={{ marginBottom: 12 }}>
              Your strategy's real win/loss sequence, replayed in order with a theoretical martingale layered on: start at {baseNum}x, double after each loss, reset after a win, never exceed the cap in the first column. The 1x row is flat sizing (no martingale); 16x allows up to {baseNum * 16} contracts. Works the same whether you traded this strategy flat or already martingaled — the sizing comes from the simulation, the wins and losses come from your trades.
            </div>
            <div style={{ overflowX: "auto", marginBottom: 14 }}>
              <table className="fj-table">
                <thead>
                  <tr><th>Max size</th><th>Total P&amp;L</th><th>Max drawdown</th><th>Profit factor</th><th>Win rate</th><th>Expectancy/trade</th></tr>
                </thead>
                <tbody>
                  {capSweep.map((row) => (
                    <tr key={row.capMultiplier}>
                      <td style={{ fontFamily: "Inter, sans-serif", fontWeight: 600 }}>
                        {row.capMultiplier}x <span className="fj-sub" style={{ fontSize: 11 }}>({row.maxContracts} contract{row.maxContracts === 1 ? "" : "s"})</span>
                      </td>
                      <td className={row.stats.totalPnl >= 0 ? "fj-profit" : "fj-loss"}>{money(row.stats.totalPnl)}</td>
                      <td className="fj-loss">{money(-row.stats.maxDD)}</td>
                      <td>{row.stats.profitFactor === null ? "—" : row.stats.profitFactor === Infinity ? "∞" : row.stats.profitFactor.toFixed(2)}</td>
                      <td>{pct(row.stats.winRate)}</td>
                      <td className={row.stats.expectancy >= 0 ? "fj-profit" : "fj-loss"}>{money(row.stats.expectancy)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={capSweep.map((row) => ({ name: `${row.capMultiplier}x`, pnl: row.stats.totalPnl }))}>
                <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
                <XAxis dataKey="name" stroke="var(--text-dim)" tick={{ fontSize: 11, fontFamily: "Inter" }} />
                <YAxis stroke="var(--text-dim)" tick={{ fontSize: 11, fontFamily: "Inter" }} />
                <Tooltip
                  contentStyle={{ background: "var(--panel-alt)", border: "1px solid var(--border)", borderRadius: 8, fontFamily: "Inter", fontSize: 12 }}
                  formatter={(value) => [money(value), "Total P&L"]}
                />
                <ReferenceLine y={0} stroke="var(--border)" />
                <Bar dataKey="pnl" name="Total P&L" radius={[3, 3, 0, 0]}>
                  {capSweep.map((row) => (
                    <Cell key={row.capMultiplier} fill={row.stats.totalPnl >= 0 ? "var(--profit)" : "var(--loss)"} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
            <div className="fj-sub" style={{ marginTop: 6, fontSize: 11 }}>
              Bars show total P&amp;L at each cap. Where the number stops changing between two caps, your loss streaks never got deep enough to reach the lower cap — raising it further added no extra effect.
            </div>
          </div>

          <div className="fj-panel">
            <p className="fj-panel-title">Loss streak cost sweep</p>
            <div className="fj-sub" style={{ marginBottom: 12 }}>
              Sizing doubles up to your stated cap (depth {capDepthNum} = max {baseNum * Math.pow(2, capDepthNum - 1)} contract{baseNum * Math.pow(2, capDepthNum - 1) === 1 ? "" : "s"}), then stays flat at that cap for any further losses in the same streak — this is what a real "caps at N contracts" rule actually costs, not unlimited doubling. "Fits buffer" checks whether that streak's total cost stays inside the buffer you set above.
            </div>
            <div style={{ overflowX: "auto" }}>
              <table className="fj-table">
                <thead>
                  <tr><th>Losses in a row</th><th>Contracts on final loss</th><th>Cost of full streak</th><th>Probability within {tradesAheadNum} trades</th><th>Fits buffer?</th></tr>
                </thead>
                <tbody>
                  {depthSweep.rows.map((r) => (
                    <tr key={r.streakLen}>
                      <td>{r.streakLen}</td>
                      <td>{r.contractsAtEnd}</td>
                      <td className="fj-loss">{money(-r.streakCost)}</td>
                      <td className={r.probability >= 0.5 ? "fj-loss" : ""}>{(r.probability * 100).toFixed(1)}%</td>
                      <td className={r.fitsBuffer ? "fj-profit" : "fj-loss"}>{r.fitsBuffer ? "Yes" : "No"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="fj-sub" style={{ marginTop: 10, fontSize: 11 }}>
              Based on {depthSweep.n} trade{depthSweep.n === 1 ? "" : "s"}, loss rate {pct(depthSweep.lossRate * 100)}, avg loss {money(-depthSweep.avgLossPerContract)}/contract. Compare this to your actual "Longest loss streak" stat above the equity curve — that's the row that tells you what your worst historical stretch would cost under this cap.
            </div>
          </div>

          <div className="fj-panel">
            <p className="fj-panel-title">Risk of ruin at this buffer</p>
            <div className="fj-sub" style={{ marginBottom: 12 }}>
              Simulated at your stated base size ({baseNum} contract{baseNum === 1 ? "" : "s"} flat, not martingale-scaled), against the {money(bufferNum)} buffer above, over the next {tradesAheadNum} trades.
            </div>
            <div className={ror.ror >= 0.5 ? "fj-loss" : ror.ror >= 0.2 ? "" : "fj-profit"} style={{ fontFamily: "'Inter', sans-serif", fontSize: 30, fontWeight: 700, marginBottom: 10 }}>
              {(ror.ror * 100).toFixed(1)}%
            </div>
            <div className="fj-sub">
              Median worst drawdown across simulations: {money(ror.medianTrough)} · Worst-case simulated: {money(ror.worstTrough)}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ---------- stat grid ----------

function LongShortTable({ longStats, shortStats }) {
  const row = (label, s) => (
    <tr key={label}>
      <td style={{ fontFamily: "Inter, sans-serif", fontWeight: 600 }}>{label}</td>
      <td>{s.n}</td>
      <td>{s.n ? pct(s.winRate) : "—"}</td>
      <td className={s.n ? (s.totalPnl >= 0 ? "fj-profit" : "fj-loss") : "fj-neutral"}>{s.n ? money(s.totalPnl) : "—"}</td>
      <td className={s.n ? (s.expectancy >= 0 ? "fj-profit" : "fj-loss") : "fj-neutral"}>{s.n ? money(s.expectancy) : "—"}</td>
      <td className="fj-profit">{s.wins ? money(s.avgWin) : "—"}</td>
      <td className="fj-loss">{s.losses ? money(-s.avgLoss) : "—"}</td>
      <td>{s.profitFactor === null ? "—" : s.profitFactor === Infinity ? "∞" : s.profitFactor.toFixed(2)}</td>
    </tr>
  );
  return (
    <div style={{ overflowX: "auto" }}>
      <table className="fj-table">
        <thead>
          <tr>
            <th>Direction</th><th>Trades</th><th>Win %</th><th>P&amp;L</th><th>Avg P&amp;L</th><th>Avg Win</th><th>Avg Loss</th><th>Profit Factor</th>
          </tr>
        </thead>
        <tbody>
          {row("Long", longStats)}
          {row("Short", shortStats)}
        </tbody>
      </table>
    </div>
  );
}

function statItems(stats) {
  return [
    ["Gross P&L", stats.n ? money(stats.grossPnl) : "—", stats.grossPnl >= 0 ? "fj-profit" : "fj-loss", "Before fees"],
    ["Fees", stats.n ? money(-stats.totalFees) : "—", stats.totalFees > 0 ? "fj-loss" : "", "Total commissions paid"],
    ["Trades", stats.n, ""],
    ["Win rate", stats.n ? pct(stats.winRate) : "—", ""],
    ["Profit factor", stats.profitFactor === null ? "—" : stats.profitFactor === Infinity ? "∞" : stats.profitFactor.toFixed(2), ""],
    ["Avg win", stats.n ? money(stats.avgWin) : "—", "fj-profit"],
    ["Avg loss", stats.n ? money(-stats.avgLoss) : "—", "fj-loss"],
    ["Expectancy / trade", stats.n ? money(stats.expectancy) : "—", stats.expectancy >= 0 ? "fj-profit" : "fj-loss"],
    ["Max drawdown", stats.n ? money(-stats.maxDD) : "—", "fj-loss"],
    ["Win streak", stats.n ? `${stats.maxWinStreak} trade${stats.maxWinStreak === 1 ? "" : "s"}` : "—", "fj-profit", "Longest run of winning trades"],
    ["Loss streak", stats.n ? `${stats.maxLossStreak} trade${stats.maxLossStreak === 1 ? "" : "s"}` : "—", "fj-loss", "Longest run of losing trades"],
  ];
}

// One quiet column of numbers instead of a wall of boxes.
function StatList({ stats, title = "Key stats" }) {
  return (
    <div className="fj-statlist">
      <div className="fj-statlist-title">{title}</div>
      {statItems(stats).map(([label, val, cls, hint]) => (
        <div key={label} className="fj-statrow" title={hint}>
          <span>{label}</span>
          <b className={cls}>{val}</b>
        </div>
      ))}
    </div>
  );
}

// ---------- equity chart ----------

// Builds hard-edged gradient stops (green rising / red falling) for a
// single Area spanning the full curve. Earlier this was done with one Area
// per direction-run, each given its own slice of the data — that broke
// Recharts' hover tracking, since a series with a partial/offset data array
// doesn't line up with the shared cursor position the same way the full
// series does. A single Area using the exact same data as the Line sidesteps
// that entirely; the color transitions are done visually via the gradient.
function buildTrendGradientStops(points, key) {
  if (points.length < 2) return [];
  const n = points.length;
  const pct = (idx) => `${((idx / (n - 1)) * 100).toFixed(3)}%`;
  const colorFor = (dir) => (dir === "up" ? "var(--profit)" : "var(--loss)");
  let dir = points[1][key] >= points[0][key] ? "up" : "down";
  const stops = [{ offset: pct(0), color: colorFor(dir) }];
  for (let i = 1; i < n - 1; i++) {
    const nextDir = points[i + 1][key] >= points[i][key] ? "up" : "down";
    if (nextDir !== dir) {
      stops.push({ offset: pct(i), color: colorFor(dir) });
      stops.push({ offset: pct(i), color: colorFor(nextDir) });
      dir = nextDir;
    }
  }
  stops.push({ offset: pct(n - 1), color: colorFor(dir) });
  return stops;
}

// Custom tooltip for the banded equity charts. The Area segments share the
// same field as the real Line (so the colored bands line up), which makes
// Recharts treat each segment as its own tooltip entry — duplicating
// "Portfolio: $X" once per band near a boundary. Giving the Area segments a
// function-based dataKey (instead of the string the real Line uses) lets us
// filter them out here, so only the real line(s) show up.
function ChartTooltip({ active, payload, label }) {
  if (!active || !payload || payload.length === 0) return null;
  const real = payload.filter((p) => typeof p.dataKey === "string");
  if (real.length === 0) return null;
  const labelFor = (key) => key === "portfolio" ? "Portfolio" : key === "equity" ? "Equity" : key === "trend" ? "Trend" : key === "hwm" ? "High-water mark" : key === "gross" ? "Before fees" : key === "dd" ? "Drawdown" : key;
  return (
    <div style={{ background: "var(--panel)", border: "1px solid var(--border-strong)", borderRadius: 10, padding: "9px 12px", fontFamily: "Inter, sans-serif", fontSize: 12.5, boxShadow: "0 8px 24px rgba(10,22,32,0.14)" }}>
      <div style={{ color: "var(--text-dim)", fontWeight: 500, marginBottom: 4 }}>{`Trade #${label}`}</div>
      {real.map((entry) => (
        <div key={entry.dataKey} style={{ color: "var(--text-bright)", fontWeight: 600, display: "flex", gap: 14, justifyContent: "space-between" }}>
          <span style={{ color: "var(--text-dim)", fontWeight: 500 }}>{labelFor(entry.dataKey)}</span>
          <span>{money(entry.value)}</span>
        </div>
      ))}
    </div>
  );
}

function HighLineLabel({ viewBox, peak, date }) {
  if (!viewBox) return null;
  const x = viewBox.x + 5;
  const yBase = viewBox.y + viewBox.height - (date ? 24 : 12);
  return (
    <g>
      <text x={x} y={yBase} fill="var(--profit)" fontSize={10.5} fontFamily="Inter" fontWeight={600}>{`High ${money(peak)}`}</text>
      {date && <text x={x} y={yBase + 13} fill="var(--profit)" fontSize={9.5} fontFamily="Inter" opacity={0.8}>{date}</text>}
    </g>
  );
}

function ChangeMarkerLabel({ viewBox, note, onHover }) {
  if (!viewBox) return null;
  const x = viewBox.x;
  const y = viewBox.y;
  return (
    <g
      onMouseEnter={() => onHover({ note, x, y })}
      onMouseLeave={() => onHover(null)}
      style={{ cursor: "pointer" }}
    >
      <rect x={x - 18} y={y - 20} width={36} height={14} rx={3} fill="var(--bg)" stroke="var(--amber)" strokeWidth={1} />
      <text x={x} y={y - 10} textAnchor="middle" fill="var(--amber)" fontSize={9} fontFamily="Inter" fontWeight={700}>change</text>
      <circle cx={x} cy={y} r={3.5} fill="var(--amber)" />
    </g>
  );
}

const axisMoney = (v) => (v < 0 ? "-$" + Math.abs(v).toLocaleString() : "$" + v.toLocaleString());
const AXIS_TICK = { fontSize: 11.5, fontFamily: "Inter, sans-serif", fill: "var(--text-dim)" };

// ---------- chart controls ----------

const HWM_COLOR = "#D99A00";
const GROSS_COLOR = "#7C5CE0";
const TREND_COLOR = "var(--text-dim)";
const CHART_PREFS_KEY = "fj_chart_prefs_v1";
const DEFAULT_CHART_PREFS = { view: "equity", trend: true, hwm: false, gross: false, x: "trades" };

// Chart toggles are remembered on this device and shared by every P&L chart.
function useChartPrefs() {
  const [prefs, setPrefs] = useState(() => {
    try { return { ...DEFAULT_CHART_PREFS, ...JSON.parse(localStorage.getItem(CHART_PREFS_KEY) || "{}") }; }
    catch { return DEFAULT_CHART_PREFS; }
  });
  const update = (patch) => setPrefs((p) => {
    const next = { ...p, ...patch };
    try { localStorage.setItem(CHART_PREFS_KEY, JSON.stringify(next)); } catch { /* storage unavailable */ }
    return next;
  });
  return [prefs, update];
}

// Least-squares trend through a curve, plus a short forward projection so the
// line reads as "where this is heading", not just "where it's been".
function withTrend(data, key, on) {
  const pts = data.filter((p) => typeof p[key] === "number");
  if (!on || pts.length < 3) return { chartData: data, slope: null };
  const n = pts.length;
  const mx = pts.reduce((a, p) => a + p.i, 0) / n;
  const my = pts.reduce((a, p) => a + p[key], 0) / n;
  let num = 0, den = 0;
  pts.forEach((p) => { num += (p.i - mx) * (p[key] - my); den += (p.i - mx) ** 2; });
  if (den === 0) return { chartData: data, slope: null };
  const slope = num / den;
  const intercept = my - slope * mx;
  const lastI = pts[pts.length - 1].i;
  const ext = Math.max(2, Math.round(n * 0.15));
  const chartData = data.map((p) => ({ ...p, trend: intercept + slope * p.i }));
  for (let k = 1; k <= ext; k++) chartData.push({ i: lastI + k, trend: intercept + slope * (lastI + k) });
  return { chartData, slope };
}

// Adds the running peak (high-water mark) and the drawdown from it, then the
// optional trend. Peak starts at 0 because every curve starts at 0.
function prepareSeries(data, key, prefs) {
  let peak = 0;
  let maxDD = 0;
  const base = data.map((p) => {
    peak = Math.max(peak, p[key]);
    const dd = Number((p[key] - peak).toFixed(2));
    if (dd < maxDD) maxDD = dd;
    return { ...p, hwm: peak, dd };
  });
  const hasFees = data.some((p) => typeof p.gross === "number" && Math.abs(p.gross - p[key]) > 0.005);
  const { chartData, slope } = withTrend(base, key, prefs.view === "equity" && prefs.trend);
  return { chartData, slope, hasFees, maxDD };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function makeXTick(data, mode) {
  if (mode !== "dates") return undefined;
  const byI = new Map(data.map((p) => [p.i, p.date]));
  return (v) => {
    const d = byI.get(Math.round(v));
    if (!d) return "";
    const [y, m, day] = d.split("-");
    return `${MONTHS[Number(m) - 1]} ${Number(day)}, '${y.slice(2)}`;
  };
}

// A round lower bound for the drawdown axis, so ticks read -$10,000 not -$9,839.75.
function niceDDFloor(maxDD) {
  const v = Math.abs(maxDD) || 1;
  const step = 10 ** Math.floor(Math.log10(v)) / 2;
  return -Math.ceil(v / step) * step;
}

// Price-tag style pills on the Y axis: one per visible series, at the height of
// its latest value, in the same color as its line. Pills that would land on top
// of each other are nudged apart so every one stays readable.
function fmtPill(v) {
  const a = Math.abs(v);
  const body = a >= 1e6 ? `${(a / 1e6).toFixed(2)}M` : Math.round(a).toLocaleString();
  return `${v < 0 ? "-" : ""}$${body}`;
}

function YPills({ yAxisMap, offset, pills }) {
  const axis = yAxisMap && Object.values(yAxisMap)[0];
  if (!axis || !axis.scale || !offset) return null;
  const H = 20, GAP = 2;
  const top = offset.top, bottom = offset.top + offset.height;
  const placed = pills
    .filter((p) => typeof p.value === "number" && Number.isFinite(p.value))
    .map((p) => ({ ...p, y: Math.min(bottom, Math.max(top, axis.scale(p.value))) }))
    .sort((a, b) => a.y - b.y);
  for (let k = 1; k < placed.length; k++) {
    if (placed[k].y - placed[k - 1].y < H + GAP) placed[k].y = placed[k - 1].y + H + GAP;
  }
  for (let k = placed.length - 2; k >= 0; k--) {
    if (placed[k + 1].y > bottom + H / 2) placed[k + 1].y = bottom + H / 2;
    if (placed[k + 1].y - placed[k].y < H + GAP) placed[k].y = placed[k + 1].y - H - GAP;
  }
  const x = offset.left + offset.width + (axis.width || 0) + 4;
  return (
    <g style={{ pointerEvents: "none" }}>
      {placed.map((p) => (
        <g key={p.id}>
          <rect x={x} y={p.y - H / 2} width={64} height={H} rx={H / 2} fill={p.fill} />
          <text x={x + 32} y={p.y + 4} textAnchor="middle" fontSize={11.5} fontWeight={600} fontFamily="Inter, sans-serif" fill={p.text || "var(--on-accent)"}>{fmtPill(p.value)}</text>
        </g>
      ))}
    </g>
  );
}

function buildPills({ chartData, key, prefs, equityView, hasFees, slope, trendColor, maxDD }) {
  const last = (k) => { for (let n = chartData.length - 1; n >= 0; n--) if (typeof chartData[n][k] === "number") return chartData[n][k]; return null; };
  if (!equityView) {
    return [
      { id: "dd-now", value: last("dd"), fill: "var(--loss)" },
      ...(maxDD < 0 && last("dd") !== maxDD ? [{ id: "dd-max", value: maxDD, fill: TREND_COLOR }] : []),
    ];
  }
  return [
    { id: "eq", value: last(key), fill: trendColor },
    ...(prefs.trend && slope !== null ? [{ id: "trend", value: last("trend"), fill: TREND_COLOR }] : []),
    ...(prefs.hwm ? [{ id: "hwm", value: last("hwm"), fill: HWM_COLOR, text: "#1A1200" }] : []),
    ...(hasFees && prefs.gross ? [{ id: "gross", value: last("gross"), fill: GROSS_COLOR, text: "#fff" }] : []),
  ];
}

function Tog({ on, onClick, title, color, children }) {
  return (
    <button className={`fj-tog ${on ? "on" : ""}`} onClick={onClick} aria-pressed={on} title={title} style={color ? { "--tog": color } : undefined}>
      <span className="fj-tog-box" aria-hidden="true">
        {on && <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="1.5,5.5 4,8 8.5,2" /></svg>}
      </span>
      {children}
    </button>
  );
}

function ChartToolbar({ prefs, update, slope, hasFees, maxDD }) {
  const equityView = prefs.view === "equity";
  return (
    <div className="fj-chart-bar">
      <div className="fj-seg-toggle" role="group" aria-label="Chart view">
        <button className={`fj-seg-btn ${equityView ? "active" : ""}`} onClick={() => update({ view: "equity" })}>Equity</button>
        <button className={`fj-seg-btn ${!equityView ? "active" : ""}`} onClick={() => update({ view: "drawdown" })} title="How far below its previous peak the account sits at each point">Drawdown</button>
      </div>
      <div className="fj-chart-bar-right">
        {equityView ? (
          <>
            <Tog color={TREND_COLOR} on={prefs.trend} onClick={() => update({ trend: !prefs.trend })} title="Straight-line fit through the curve, extended forward. A guide to direction, not a forecast.">
              Trend
              {prefs.trend && slope !== null && <b className={slope >= 0 ? "fj-profit" : "fj-loss"}>{slope >= 0 ? "+" : "-"}{money(Math.abs(slope))}/trade</b>}
            </Tog>
            <Tog color={HWM_COLOR} on={prefs.hwm} onClick={() => update({ hwm: !prefs.hwm })} title="The highest equity reached so far — the level a drawdown has to climb back to.">High-water mark</Tog>
            {hasFees && <Tog color={GROSS_COLOR} on={prefs.gross} onClick={() => update({ gross: !prefs.gross })} title="Same trades before fees. The gap between the lines is what fees have cost.">Before fees</Tog>}
          </>
        ) : (
          <span className="fj-sub">Max drawdown <b className="fj-loss">{money(maxDD)}</b></span>
        )}
        <div className="fj-seg-toggle" role="group" aria-label="X axis">
          <button className={`fj-seg-btn ${prefs.x === "trades" ? "active" : ""}`} onClick={() => update({ x: "trades" })}>Trades</button>
          <button className={`fj-seg-btn ${prefs.x === "dates" ? "active" : ""}`} onClick={() => update({ x: "dates" })}>Dates</button>
        </div>
      </div>
    </div>
  );
}

function EquityChart({ curve, color = "var(--amber)", changeNotes = [] }) {
  const gradId = useId();
  const [hoveredMarker, setHoveredMarker] = useState(null);
  const [prefs, update] = useChartPrefs();
  if (curve.length === 0) {
    return <div className="fj-empty">No trades yet — add one to start the equity curve.</div>;
  }
  const equityView = prefs.view === "equity";
  const trendColor = curve[curve.length - 1].equity >= 0 ? "var(--profit)" : "var(--loss)";

  // Position each note at the boundary just before the FIRST real trade on
  // its date, not the last one on/before it — so every trade that date
  // (the whole day's worth) reads as happening after the change, matching
  // how the trade log treats the same date.
  const markers = changeNotes
    .map((n) => {
      const firstOnOrAfter = curve.find((p) => p.i > 0 && p.date && p.date >= n.date);
      const i = firstOnOrAfter ? firstOnOrAfter.i - 1 : curve[curve.length - 1]?.i;
      return { note: n, i };
    })
    .filter((m) => m.i !== undefined && m.i !== null && m.i >= 0);
  const { chartData, slope, hasFees, maxDD } = prepareSeries(curve, "equity", prefs);
  const allVals = curve.map((p) => p.equity);
  const yMin = Math.min(0, ...allVals);
  const yMax = Math.max(0, ...allVals);

  return (
    <div style={{ position: "relative" }}>
      <ChartToolbar prefs={prefs} update={update} slope={slope} hasFees={hasFees} maxDD={maxDD} />
      <ResponsiveContainer width="100%" height={220}>
        <ComposedChart data={chartData} margin={{ top: 26, right: 72, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id={`eqFill-${gradId}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={equityView ? trendColor : "var(--loss)"} stopOpacity={0.2} />
              <stop offset="100%" stopColor={equityView ? trendColor : "var(--loss)"} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="var(--border)" vertical={false} />
          <XAxis dataKey="i" type="number" domain={["dataMin", "dataMax"]} axisLine={false} tickLine={false} tick={AXIS_TICK} tickMargin={8} tickFormatter={makeXTick(curve, prefs.x)} />
          <YAxis orientation="right" axisLine={false} tickLine={false} tick={AXIS_TICK} tickFormatter={axisMoney} width={68} domain={equityView ? ["auto", "auto"] : [niceDDFloor(maxDD), 0]} />
          <Area
            dataKey={equityView ? "equity" : "dd"} type="monotone" stroke="none"
            fill={`url(#eqFill-${gradId})`} isAnimationActive={false} legendType="none"
          />
          <ReferenceLine y={0} stroke="var(--border-strong)" />
          {equityView && markers.map((m) => (
            <ReferenceLine
              key={m.note.id}
              segment={[{ x: m.i, y: yMin }, { x: m.i, y: yMax }]}
              stroke="var(--amber)" strokeOpacity={0.6} strokeDasharray="3 3"
              label={<ChangeMarkerLabel note={m.note} onHover={setHoveredMarker} />}
            />
          ))}
          <Tooltip content={<ChartTooltip />} cursor={{ stroke: "var(--border-strong)", strokeDasharray: "3 3" }} />
          {equityView && prefs.hwm && <Line type="stepAfter" dataKey="hwm" stroke={HWM_COLOR} strokeWidth={1.75} strokeDasharray="2 4" dot={false} isAnimationActive={false} activeDot={false} />}
          {equityView && hasFees && prefs.gross && <Line type="monotone" dataKey="gross" stroke={GROSS_COLOR} strokeWidth={1.5} dot={false} isAnimationActive={false} activeDot={false} />}
          {equityView && slope !== null && <Line type="linear" dataKey="trend" stroke={TREND_COLOR} strokeWidth={1.75} strokeDasharray="6 5" dot={false} isAnimationActive={false} activeDot={false} legendType="none" />}
          <Line type="monotone" dataKey={equityView ? "equity" : "dd"} stroke={equityView ? trendColor : "var(--loss)"} strokeWidth={2.25} dot={false} isAnimationActive={false} activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--panel)" }} />
          <Customized component={YPills} pills={buildPills({ chartData, key: "equity", prefs, equityView, hasFees, slope, trendColor, maxDD })} />
        </ComposedChart>
      </ResponsiveContainer>
      {hoveredMarker && equityView && (
        <div style={{
          position: "absolute", left: Math.max(hoveredMarker.x - 100, 4), top: hoveredMarker.y + 6,
          background: "var(--panel-alt)", border: "1px solid var(--border)", borderRadius: 8, padding: "9px 11px",
          fontSize: 12, width: 210, zIndex: 10, pointerEvents: "none", boxShadow: "0 4px 14px rgba(0,0,0,0.45)",
        }}>
          <div style={{ fontFamily: "'Inter', sans-serif", color: "var(--amber)", fontSize: 10.5, marginBottom: 3 }}>{hoveredMarker.note.date}</div>
          <div style={{ fontFamily: "Inter, sans-serif", fontWeight: 600, color: "var(--text-bright)", marginBottom: hoveredMarker.note.body ? 4 : 0 }}>{hoveredMarker.note.title}</div>
          {hoveredMarker.note.body && <div style={{ fontFamily: "Inter, sans-serif", color: "var(--text-dim)", lineHeight: 1.4, fontSize: 11.5 }}>{hoveredMarker.note.body}</div>}
        </div>
      )}
    </div>
  );
}

function PortfolioEquityChart({ data, strategies, visible, colorFor, height = 300 }) {
  const gradId = useId();
  const [prefs, update] = useChartPrefs();
  if (!data || data.length === 0) {
    return <div className="fj-empty">No trades in this range — add one or pick a longer range.</div>;
  }
  const equityView = prefs.view === "equity";
  const trendColor = data[data.length - 1].portfolio >= 0 ? "var(--profit)" : "var(--loss)";
  const { chartData, slope, hasFees, maxDD } = prepareSeries(data, "portfolio", prefs);
  return (
    <div style={{ position: "relative" }}>
      <ChartToolbar prefs={prefs} update={update} slope={slope} hasFees={hasFees} maxDD={maxDD} />
      <ResponsiveContainer width="100%" height={height}>
        <ComposedChart data={chartData} margin={{ top: 8, right: 72, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id={`pfFill-${gradId}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={equityView ? trendColor : "var(--loss)"} stopOpacity={0.2} />
              <stop offset="100%" stopColor={equityView ? trendColor : "var(--loss)"} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="var(--border)" vertical={false} />
          <XAxis dataKey="i" type="number" domain={["dataMin", "dataMax"]} axisLine={false} tickLine={false} tick={AXIS_TICK} tickMargin={8} tickFormatter={makeXTick(data, prefs.x)} />
          <YAxis orientation="right" axisLine={false} tickLine={false} tick={AXIS_TICK} tickFormatter={axisMoney} width={68} domain={equityView ? ["auto", "auto"] : [niceDDFloor(maxDD), 0]} />
          <Area
            dataKey={equityView ? "portfolio" : "dd"} type="monotone" stroke="none"
            fill={`url(#pfFill-${gradId})`} isAnimationActive={false} legendType="none"
          />
          <ReferenceLine y={0} stroke="var(--border-strong)" />
          <Tooltip content={<ChartTooltip />} cursor={{ stroke: "var(--border-strong)", strokeDasharray: "3 3" }} />
          {equityView && strategies.filter((st) => visible.includes(st)).map((st) => (
            <Line key={st} type="monotone" dataKey={st} stroke={colorFor(st)} strokeWidth={1.75} strokeOpacity={0.9} dot={false} isAnimationActive={false} />
          ))}
          {equityView && prefs.hwm && <Line type="stepAfter" dataKey="hwm" stroke={HWM_COLOR} strokeWidth={1.75} strokeDasharray="2 4" dot={false} isAnimationActive={false} activeDot={false} />}
          {equityView && hasFees && prefs.gross && <Line type="monotone" dataKey="gross" stroke={GROSS_COLOR} strokeWidth={1.5} dot={false} isAnimationActive={false} activeDot={false} />}
          {equityView && slope !== null && <Line type="linear" dataKey="trend" stroke={TREND_COLOR} strokeWidth={1.75} strokeDasharray="6 5" dot={false} isAnimationActive={false} activeDot={false} legendType="none" />}
          <Line type="monotone" dataKey={equityView ? "portfolio" : "dd"} stroke={equityView ? trendColor : "var(--loss)"} strokeWidth={2.5} dot={false} isAnimationActive={false} activeDot={{ r: 4.5, strokeWidth: 2, stroke: "var(--panel)" }} />
          <Customized component={YPills} pills={buildPills({ chartData, key: "portfolio", prefs, equityView, hasFees, slope, trendColor, maxDD })} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

// ---------- portfolio view ----------

const GROUP_SORT_OPTIONS = [
  ["pnl", "P&L"],
  ["pf", "Profit Factor"],
  ["trades", "Trades"],
  ["winRate", "Win Rate"],
];

function sortGroups(list, sortKey) {
  const pfValue = (s) => s.profitFactor === null ? -Infinity : s.profitFactor === Infinity ? Infinity : s.profitFactor;
  return [...list].sort((a, b) => {
    if (sortKey === "trades") return b.stats.n - a.stats.n;
    if (sortKey === "winRate") return b.stats.winRate - a.stats.winRate;
    if (sortKey === "pf") return pfValue(b.stats) - pfValue(a.stats);
    return b.stats.totalPnl - a.stats.totalPnl;
  });
}

function SortToggle({ value, onChange }) {
  return (
    <div className="fj-seg-toggle">
      {GROUP_SORT_OPTIONS.map(([key, label]) => (
        <button key={key} className={`fj-seg-btn ${value === key ? "active" : ""}`} onClick={() => onChange(key)}>
          {label}
        </button>
      ))}
    </div>
  );
}

function GroupTable({ rows, showGrade, onSelect, selected = [], onToggle, colorFor, pageSize = 8, emptyText }) {
  const [sortKey, setSortKey] = useState("pnl");
  const [sortDir, setSortDir] = useState("desc");
  const [showAll, setShowAll] = useState(false);
  const pfVal = (st) => (st.profitFactor === null ? -1 : st.profitFactor === Infinity ? 1e9 : st.profitFactor);
  const sorted = useMemo(() => {
    const get = (r) => ({ name: r.key.toLowerCase(), pnl: r.stats.totalPnl, win: r.stats.n ? r.stats.winRate : -1, pf: pfVal(r.stats), trades: r.stats.n, fees: r.stats.totalFees || 0 })[sortKey];
    const dir = sortDir === "desc" ? -1 : 1;
    return [...rows].sort((x, y) => { const a = get(x), b = get(y); return (a < b ? -1 : a > b ? 1 : 0) * dir; });
  }, [rows, sortKey, sortDir]);
  const visible = showAll ? sorted : sorted.slice(0, pageSize);
  const clickSort = (k) => {
    if (k === sortKey) setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    else { setSortKey(k); setSortDir(k === "name" ? "asc" : "desc"); }
  };
  const Th = ({ k, children, right, cls }) => (
    <th className={cls} style={{ textAlign: right ? "right" : "left" }} aria-sort={sortKey === k ? (sortDir === "desc" ? "descending" : "ascending") : "none"}>
      <button className={`fj-th-btn ${sortKey === k ? "on" : ""}`} onClick={() => clickSort(k)}>
        {children}{sortKey === k ? (sortDir === "desc" ? " ↓" : " ↑") : ""}
      </button>
    </th>
  );
  if (rows.length === 0) return <div className="fj-empty">{emptyText}</div>;
  return (
    <div>
      <div className="fj-table-wrap">
        <table className="fj-table fj-group-table">
          <thead>
            <tr>
              {onToggle && <th style={{ width: 34 }} aria-label="Compare on chart" />}
              <Th k="name">Name</Th>
              {showGrade && <th style={{ width: 54 }}>Grade</th>}
              <Th k="pnl" right>Net P&amp;L</Th>
              <th className="fj-col-trend" style={{ width: 100 }}>Equity</th>
              <Th k="win" right cls="fj-col-sec">Win rate</Th>
              <Th k="pf" right cls="fj-col-sec">Profit factor</Th>
              <Th k="trades" right>Trades</Th>
              <Th k="fees" right cls="fj-col-sec">Fees</Th>
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => {
              const up = r.stats.totalPnl >= 0;
              const picked = selected.includes(r.key);
              return (
                <tr key={r.key} className={`fj-row-click ${picked ? "picked" : ""}`} onClick={() => onSelect(r.key)}>
                  {onToggle && (
                    <td onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox" checked={picked} onChange={() => onToggle(r.key)}
                        aria-label={`Compare ${r.key} on the chart`} title="Overlay on the chart"
                        style={{ accentColor: colorFor ? colorFor(r.key) : undefined }}
                      />
                    </td>
                  )}
                  <td>
                    <span className="fj-name-cell">
                      <span className="fj-dot" style={{ background: r.accent || (colorFor ? colorFor(r.key) : "var(--text-dim)") }} />
                      {r.key}
                    </span>
                  </td>
                  {showGrade && <td>{r.grade && <GradeBadge grade={r.grade} size="sm" />}</td>}
                  <td style={{ textAlign: "right", fontWeight: 600 }} className={r.stats.n === 0 ? "fj-neutral" : up ? "fj-profit" : "fj-loss"}>{r.stats.n === 0 ? "—" : money(r.stats.totalPnl)}</td>
                  <td className="fj-col-trend">
                    {r.curve && r.curve.length > 1 && (
                      <LineChart width={92} height={26} data={r.curve} margin={{ top: 3, right: 2, left: 2, bottom: 3 }}>
                        <YAxis hide domain={["dataMin", "dataMax"]} />
                        <Line type="monotone" dataKey="equity" stroke={up ? "var(--profit)" : "var(--loss)"} strokeWidth={1.75} dot={false} isAnimationActive={false} />
                      </LineChart>
                    )}
                  </td>
                  <td className="fj-col-sec" style={{ textAlign: "right" }}>{r.stats.n ? pct(r.stats.winRate) : "—"}</td>
                  <td className="fj-col-sec" style={{ textAlign: "right" }}>{r.stats.profitFactor === null ? "—" : r.stats.profitFactor === Infinity ? "∞" : r.stats.profitFactor.toFixed(2)}</td>
                  <td style={{ textAlign: "right" }}>{r.stats.n}</td>
                  <td className="fj-col-sec fj-neutral" style={{ textAlign: "right" }}>{r.stats.totalFees > 0 ? money(r.stats.totalFees) : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {sorted.length > pageSize && (
        <button className="fj-more-btn" onClick={() => setShowAll((v) => !v)}>
          {showAll ? "Show fewer" : `Show all ${sorted.length}`}
        </button>
      )}
    </div>
  );
}

const HOME_RANGES = [
  ["1D", "Latest day"], ["1W", "Past week"], ["1M", "Past month"], ["3M", "Past 3 months"], ["YTD", "Year to date"], ["ALL", "All time"],
];

function rangeCutoff(anchor, key) {
  if (!anchor || key === "ALL") return null;
  if (key === "1D") return anchor;
  if (key === "YTD") return `${anchor.slice(0, 4)}-01-01`;
  const days = key === "1W" ? 6 : key === "1M" ? 29 : 89;
  const d = new Date(anchor + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function HomeView({ settings, trades, accounts, strategies, onSelect, onViewAccounts }) {
  const [selectedStrategies, setSelectedStrategies] = useState([]);
  const [category, setCategory] = useState("all"); // all | micro | mini
  const [tab, setTab] = useState("strategies"); // strategies | markets | breakdown
  const [range, setRange] = useState("ALL");

  // The range pills count back from the most recent real trade, not today's
  // date, so "Past week" always shows the last stretch you actually traded.
  const anchorDate = useMemo(() => {
    let max = "";
    trades.forEach((t) => { if (!t._isCopy && t.date && t.date > max) max = t.date; });
    return max;
  }, [trades]);
  const rangedTrades = useMemo(() => {
    const cutoff = rangeCutoff(anchorDate, range);
    return cutoff ? trades.filter((t) => t.date >= cutoff) : trades;
  }, [trades, anchorDate, range]);

  const hasMicro = Object.values(settings).some((m) => (m.category || "micro") === "micro");
  const hasMini = Object.values(settings).some((m) => m.category === "mini");

  // Category-only scope — drives the market row and the portfolio-wide stat
  // grid, so every strategy/market stays visible to browse and toggle even
  // while filtered. Copied trades (from "Copy to strategy" in the Trade Log)
  // are excluded here on purpose: a copy is the same underlying trade viewed
  // under a second strategy name, not a new position, so the real portfolio
  // total must never count it twice.
  const categoryScopedTrades = useMemo(() => {
    const real = rangedTrades.filter((t) => !t._isCopy);
    if (category === "all") return real;
    return real.filter((t) => (settings[t.market]?.category || "micro") === category);
  }, [rangedTrades, settings, category]);

  // Same category scope, but keeping copies in — needed only for the
  // per-strategy breakdown below, where a copy legitimately belongs under
  // its new strategy's own numbers.
  const categoryScopedTradesWithCopies = useMemo(() => {
    if (category === "all") return rangedTrades;
    return rangedTrades.filter((t) => (settings[t.market]?.category || "micro") === category);
  }, [rangedTrades, settings, category]);

  // Category + selected-strategy scope — drives the stat grid and the main
  // equity curve, so picking strategy chips actually narrows the numbers,
  // not just overlays extra lines on top of the unfiltered portfolio. With
  // no strategy chips picked, this is the real (copy-free) portfolio total;
  // picking specific strategy chips brings copies back in for just those
  // strategies, since a copy only ever counts once there.
  const statsScopedTrades = useMemo(() => {
    if (selectedStrategies.length === 0) return categoryScopedTrades;
    return categoryScopedTradesWithCopies.filter((t) => selectedStrategies.includes(t.strategy));
  }, [categoryScopedTrades, categoryScopedTradesWithCopies, selectedStrategies]);

  const stats = useMemo(() => calcStats(statsScopedTrades), [statsScopedTrades]);
  const lastSession = useMemo(() => {
    let max = "";
    statsScopedTrades.forEach((t) => { if (t.date && t.date > max) max = t.date; });
    if (!max) return null;
    return { date: max, pnl: statsScopedTrades.filter((t) => t.date === max).reduce((s, t) => s + (Number(t.pnl) || 0), 0) };
  }, [statsScopedTrades]);
  const multiCurve = useMemo(() => buildMultiEquityCurve(statsScopedTrades, strategies), [statsScopedTrades, strategies]);
  const longStats = useMemo(() => calcStats(statsScopedTrades.filter((t) => t.direction === "Long")), [statsScopedTrades]);
  const shortStats = useMemo(() => calcStats(statsScopedTrades.filter((t) => t.direction === "Short")), [statsScopedTrades]);

  const byMarket = useMemo(() => {
    const list = Object.keys(settings)
      .filter((m) => category === "all" || (settings[m].category || "micro") === category)
      .map((m) => {
        const marketTrades = categoryScopedTrades.filter((t) => t.market === m);
        return { key: m, ...settings[m], stats: calcStats(marketTrades), curve: equityCurve(marketTrades) };
      });
    return list;
  }, [settings, categoryScopedTrades, category]);

  const byStrategy = useMemo(() => {
    const names = Array.from(new Set(categoryScopedTradesWithCopies.map((t) => t.strategy).filter(Boolean)));
    const list = names
      .map((s) => {
        const stratTrades = categoryScopedTradesWithCopies.filter((t) => t.strategy === s);
        return { key: s, stats: calcStats(stratTrades), curve: equityCurve(stratTrades), grade: computeStrategyGrade(stratTrades, { settings }) };
      });
    return list;
  }, [categoryScopedTradesWithCopies, settings]);

  const acctRollup = useMemo(() => {
    if (accounts.length === 0) return null;
    let currentTotal = 0, breachedCount = 0;
    accounts.forEach((a) => {
      const timelineData = buildAccountBalanceTimeline(a, trades);
      const { floor } = computeAccountFloor(a, timelineData);
      currentTotal += timelineData.currentBalance;
      const hasFloor = (Number(a.drawdownAmount) || 0) > 0 || (a.minimum || 0) > 0;
      if (hasFloor && timelineData.currentBalance < floor) breachedCount += 1;
    });
    return { currentTotal, breachedCount };
  }, [accounts, trades]);

  const colorFor = (s) => ACCENT_PALETTE[strategies.indexOf(s) % ACCENT_PALETTE.length];
  const toggleStrategy = (s) => setSelectedStrategies((v) => v.includes(s) ? v.filter((x) => x !== s) : [...v, s]);

  return (
    <div>
      <div className="fj-dash-grid">
        <div className="fj-hero">
          <div className="fj-hero-top">
            <div>
              <div className="fj-hero-label">Net P&amp;L{selectedStrategies.length > 0 ? ` · ${selectedStrategies.length} selected` : ""}</div>
              <div className={`fj-hero-value ${stats.n === 0 ? "fj-neutral" : stats.totalPnl >= 0 ? "fj-profit" : "fj-loss"}`}>
                {stats.n ? money(stats.totalPnl) : "$0.00"}
              </div>
              <div className="fj-hero-delta">
                {lastSession && (
                  <span className={`fj-delta-chip ${lastSession.pnl >= 0 ? "up" : "down"}`}>
                    {lastSession.pnl >= 0 ? <TrendingUp size={14} /> : <TrendingDown size={14} />} {money(lastSession.pnl)}
                  </span>
                )}
                <span className="fj-hero-meta">
                  {lastSession ? `latest session, ${lastSession.date} · ` : ""}{stats.n} trade{stats.n === 1 ? "" : "s"}, {HOME_RANGES.find(([k]) => k === range)[1].toLowerCase()}
                </span>
              </div>
            </div>
            {(hasMicro && hasMini) && (
              <div className="fj-seg-toggle">
                <button className={`fj-seg-btn ${category === "all" ? "active" : ""}`} onClick={() => setCategory("all")}>All contracts</button>
                <button className={`fj-seg-btn ${category === "micro" ? "active" : ""}`} onClick={() => setCategory("micro")}>Micro</button>
                <button className={`fj-seg-btn ${category === "mini" ? "active" : ""}`} onClick={() => setCategory("mini")}>Mini</button>
              </div>
            )}
          </div>

          <div className="fj-hero-chart">
            <PortfolioEquityChart data={multiCurve} strategies={strategies} visible={selectedStrategies} colorFor={colorFor} height={280} />
          </div>

          <div className="fj-hero-foot">
            <div className="fj-pills" role="group" aria-label="Time range">
              {HOME_RANGES.map(([key, label]) => (
                <button key={key} className={`fj-pill ${range === key ? "active" : ""}`} onClick={() => setRange(key)} title={label} aria-pressed={range === key}>{key}</button>
              ))}
            </div>
            {selectedStrategies.length > 0 && (
              <button className="fj-chip" onClick={() => setSelectedStrategies([])}>Clear {selectedStrategies.length} compared</button>
            )}
          </div>
        </div>

        <aside className="fj-side">
          <StatList stats={stats} />
          {acctRollup && (
            <button className="fj-side-link" onClick={onViewAccounts}>
              <span>
                <span className="fj-sub">Accounts · {accounts.length}</span>
                <b style={{ display: "block", fontSize: 17, marginTop: 2 }}>{money(acctRollup.currentTotal)}</b>
              </span>
              <span className={acctRollup.breachedCount > 0 ? "fj-loss" : "fj-neutral"} style={{ fontSize: 12.5, fontWeight: 600 }}>
                {acctRollup.breachedCount > 0 ? `${acctRollup.breachedCount} below floor` : "All above floor"} ›
              </span>
            </button>
          )}
        </aside>
      </div>

      <div className="fj-tabbar">
        <div className="fj-pills" role="tablist">
          {[["strategies", `Strategies · ${byStrategy.length}`], ["markets", `Markets · ${byMarket.length}`], ["breakdown", "Breakdown"]].map(([k, label]) => (
            <button key={k} role="tab" aria-selected={tab === k} className={`fj-pill lg ${tab === k ? "active" : ""}`} onClick={() => setTab(k)}>{label}</button>
          ))}
        </div>
        {tab === "strategies" && byStrategy.length > 0 && <span className="fj-sub">Tick a box to compare on the chart. Select a row to open it.</span>}
        {tab === "markets" && <span className="fj-sub">Select a market to open it.</span>}
      </div>

      {tab === "strategies" && (
        <GroupTable
          rows={byStrategy} showGrade colorFor={colorFor}
          selected={selectedStrategies} onToggle={toggleStrategy}
          onSelect={(k) => onSelect("strategy", k)}
          emptyText="No strategies logged yet."
        />
      )}
      {tab === "markets" && (
        <GroupTable rows={byMarket} onSelect={(k) => onSelect("market", k)} emptyText="No markets yet." pageSize={12} />
      )}
      {tab === "breakdown" && (
        <div className="fj-two-col">
          {stats.n > 0 && (
            <div style={{ gridColumn: "1 / -1" }}>
              <h3 className="fj-sub-title">Long vs short</h3>
              <LongShortTable longStats={longStats} shortStats={shortStats} />
            </div>
          )}
          <div style={{ gridColumn: "1 / -1" }}>
            <h3 className="fj-sub-title">Stats by time window</h3>
            <WindowStatsPanel trades={statsScopedTrades} />
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- accounts ----------

function AccountsView({ accounts, setAccounts, trades, setTrades }) {
  const [showAdd, setShowAdd] = useState(false);
  const [preset, setPreset] = useState("custom");
  const [newName, setNewName] = useState("");
  const [newStarting, setNewStarting] = useState("");
  const [newMinimum, setNewMinimum] = useState("");
  const [newDrawdownType, setNewDrawdownType] = useState("eod");
  const [newDrawdownAmount, setNewDrawdownAmount] = useState("");
  const [newProfitTarget, setNewProfitTarget] = useState("");
  const [newTrailingLock, setNewTrailingLock] = useState("target");
  const [newStatus, setNewStatus] = useState("Evaluation");
  const [newIsCash, setNewIsCash] = useState(false);
  const [error, setError] = useState("");

  const applyPreset = (key) => {
    setPreset(key);
    const p = PROP_PRESETS.find((x) => x.key === key);
    if (!p) return;
    setNewStarting(p.startingBalance);
    setNewDrawdownAmount(p.drawdownAmount);
    setNewProfitTarget(p.profitTarget);
    setNewDrawdownType(p.drawdownType);
    setNewTrailingLock(p.trailingLock);
    setNewIsCash(false);
    setNewStatus("Evaluation");
  };

  const addAccount = (e) => {
    e.preventDefault();
    const name = newName.trim();
    if (!name) { setError("Give the account a name."); return; }
    if (accounts.some((a) => a.name === name)) { setError("An account with that name already exists."); return; }
    const account = {
      id: uid(),
      name,
      isCash: newIsCash,
      startingBalance: Number(newStarting) || 0,
      minimum: Number(newMinimum) || 0,
      drawdownType: newIsCash ? "static" : newDrawdownType,
      drawdownAmount: newIsCash ? 0 : Number(newDrawdownAmount) || 0,
      profitTarget: newIsCash ? 0 : Number(newProfitTarget) || 0,
      trailingLock: newTrailingLock,
      status: newIsCash ? "" : newStatus,
      payouts: [],
      adjustments: [],
    };
    setAccounts((prev) => [...prev, account]);
    setNewName(""); setNewStarting(""); setNewMinimum(""); setNewDrawdownAmount(""); setNewProfitTarget("");
    setNewDrawdownType("eod"); setNewTrailingLock("target"); setNewStatus("Evaluation"); setNewIsCash(false);
    setPreset("custom"); setError(""); setShowAdd(false);
  };

  const removeAccount = (id) => setAccounts((prev) => prev.filter((a) => a.id !== id));

  const updateAccount = (id, patch) => {
    const current = accounts.find((a) => a.id === id);
    setAccounts((prev) => prev.map((a) => a.id === id ? { ...a, ...patch } : a));
    if (current && patch.name && patch.name !== current.name) {
      setTrades((prevTrades) => prevTrades.map((t) =>
        (t.accounts || []).includes(current.name)
          ? { ...t, accounts: t.accounts.map((n) => n === current.name ? patch.name : n) }
          : t
      ));
    }
  };

  const addPayout = (id, date, amount) => {
    setAccounts((prev) => prev.map((a) => {
      if (a.id !== id) return a;
      const payouts = [...(a.payouts || []), { id: uid(), date, amount }].sort((x, y) => x.date.localeCompare(y.date));
      return { ...a, payouts };
    }));
  };

  const removePayout = (accountId, entryId) => {
    setAccounts((prev) => prev.map((a) => a.id === accountId ? { ...a, payouts: (a.payouts || []).filter((p) => p.id !== entryId) } : a));
  };

  const addAdjustment = (id, date, amount, note) => {
    setAccounts((prev) => prev.map((a) => {
      if (a.id !== id) return a;
      const adjustments = [...(a.adjustments || []), { id: uid(), date, amount, note }].sort((x, y) => x.date.localeCompare(y.date));
      return { ...a, adjustments };
    }));
  };

  const removeAdjustment = (accountId, entryId) => {
    setAccounts((prev) => prev.map((a) => a.id === accountId ? { ...a, adjustments: (a.adjustments || []).filter((adj) => adj.id !== entryId) } : a));
  };

  const rollup = useMemo(() => {
    if (accounts.length === 0) return null;
    let currentTotal = 0, startingTotal = 0, tradingPnlTotal = 0, paidOutTotal = 0, breachedCount = 0;
    let evalCount = 0, passedCount = 0, failedCount = 0, cashCount = 0;
    accounts.forEach((a) => {
      const timelineData = buildAccountBalanceTimeline(a, trades);
      const { floor } = computeAccountFloor(a, timelineData);
      currentTotal += timelineData.currentBalance;
      startingTotal += a.startingBalance;
      tradingPnlTotal += timelineData.tradingPnl;
      paidOutTotal += timelineData.totalPaidOut;
      const hasFloor = (Number(a.drawdownAmount) || 0) > 0 || (a.minimum || 0) > 0;
      if (hasFloor && timelineData.currentBalance < floor) breachedCount += 1;
      if (a.isCash) cashCount += 1;
      else if (a.status === "Passed") passedCount += 1;
      else if (a.status === "Failed") failedCount += 1;
      else evalCount += 1;
    });
    return { currentTotal, startingTotal, tradingPnlTotal, paidOutTotal, breachedCount, evalCount, passedCount, failedCount, cashCount };
  }, [accounts, trades]);

  return (
    <div>
      {rollup && (
        <div className="fj-panel">
          <p className="fj-panel-title">All accounts combined</p>
          <div className="fj-stat-grid">
            <div className="fj-stat-card">
              <div className="fj-stat-label">Total current balance</div>
              <div className="fj-stat-value">{money(rollup.currentTotal)}</div>
            </div>
            <div className="fj-stat-card">
              <div className="fj-stat-label">Total trading P&amp;L</div>
              <div className={`fj-stat-value ${rollup.tradingPnlTotal >= 0 ? "fj-profit" : "fj-loss"}`}>{money(rollup.tradingPnlTotal)}</div>
            </div>
            <div className="fj-stat-card">
              <div className="fj-stat-label">Total paid out</div>
              <div className="fj-stat-value">{money(rollup.paidOutTotal)}</div>
            </div>
            <div className="fj-stat-card">
              <div className="fj-stat-label">Accounts</div>
              <div className="fj-stat-value">{accounts.length}</div>
            </div>
            <div className="fj-stat-card">
              <div className="fj-stat-label">Below floor</div>
              <div className={`fj-stat-value ${rollup.breachedCount > 0 ? "fj-loss" : "fj-profit"}`}>{rollup.breachedCount}</div>
            </div>
          </div>
          <div className="fj-sub" style={{ marginTop: 4 }}>
            {rollup.evalCount} Evaluation · {rollup.passedCount} Passed/Funded · {rollup.failedCount} Failed · {rollup.cashCount} Cash
          </div>
        </div>
      )}

      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 14 }}>
        <button className="fj-btn primary" onClick={() => setShowAdd((s) => !s)}>
          <Plus size={14} /> Add account
        </button>
      </div>

      {showAdd && (
        <form onSubmit={addAccount} className="fj-panel">
          <div className="fj-form-field" style={{ marginBottom: 12 }}>
            <label>Start from a common prop firm preset (optional)</label>
            <select className="fj-select" value={preset} onChange={(e) => applyPreset(e.target.value)}>
              <option value="custom">Custom — I'll fill in the numbers</option>
              {PROP_PRESETS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
            </select>
          </div>
          {preset !== "custom" && (
            <div className="fj-sub" style={{ marginBottom: 12 }}>
              Prefilled from commonly published rules as of mid-2026 — firms change pricing and rules often, so double-check against the firm's current terms before relying on this. Every field below is still editable.
            </div>
          )}

          <div className="fj-form-row" style={{ gridTemplateColumns: "1.4fr 1fr 1fr" }}>
            <div className="fj-form-field">
              <label>Account name</label>
              <input className="fj-input" style={{ fontFamily: "Inter, sans-serif" }} placeholder="Apex 50k #1" value={newName} onChange={(e) => setNewName(e.target.value)} />
            </div>
            <div className="fj-form-field">
              <label>Starting balance ($)</label>
              <input type="number" step="0.01" className="fj-input" placeholder="50000" value={newStarting} onChange={(e) => setNewStarting(e.target.value)} />
            </div>
            {!newIsCash && (
              <div className="fj-form-field">
                <label>Status</label>
                <select className="fj-select" value={newStatus} onChange={(e) => setNewStatus(e.target.value)}>
                  <option value="Evaluation">Evaluation</option>
                  <option value="Passed">Passed / Funded</option>
                  <option value="Failed">Failed</option>
                </select>
              </div>
            )}
          </div>

          <label style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 12.5, color: "var(--text-dim)", margin: "2px 0 12px", cursor: "pointer" }}>
            <input type="checkbox" checked={newIsCash} onChange={(e) => setNewIsCash(e.target.checked)} />
            This is a cash account (no evaluation/funded status, no drawdown tracking)
          </label>

          {!newIsCash && (
            <>
              <div className="fj-form-row" style={{ gridTemplateColumns: "1fr 1fr 1fr" }}>
                <div className="fj-form-field">
                  <label>Drawdown type</label>
                  <select className="fj-select" value={newDrawdownType} onChange={(e) => setNewDrawdownType(e.target.value)}>
                    <option value="eod">EOD (recalculates at close)</option>
                    <option value="intraday">Intraday (trails in real time)</option>
                    <option value="static">Static (fixed floor)</option>
                  </select>
                </div>
                <div className="fj-form-field">
                  <label>Max drawdown ($)</label>
                  <input type="number" step="0.01" className="fj-input" placeholder="2000" value={newDrawdownAmount} onChange={(e) => setNewDrawdownAmount(e.target.value)} />
                </div>
                <div className="fj-form-field">
                  <label>Profit target to pass ($)</label>
                  <input type="number" step="0.01" className="fj-input" placeholder="3000" value={newProfitTarget} onChange={(e) => setNewProfitTarget(e.target.value)} />
                </div>
              </div>
              {newDrawdownType !== "static" && (
                <div className="fj-form-field" style={{ marginBottom: 12 }}>
                  <label>Trailing locks at</label>
                  <select className="fj-select" value={newTrailingLock} onChange={(e) => setNewTrailingLock(e.target.value)}>
                    <option value="target">Profit target reached (e.g. Apex)</option>
                    <option value="starting">Starting balance reached (e.g. Topstep)</option>
                    <option value="none">Never — always trails</option>
                  </select>
                </div>
              )}
            </>
          )}

          {(newIsCash || !newDrawdownAmount) && (
            <div className="fj-form-field" style={{ marginBottom: 12 }}>
              <label>Flat minimum balance ($, optional)</label>
              <input type="number" step="0.01" className="fj-input" placeholder="e.g. a personal risk floor for a cash account" value={newMinimum} onChange={(e) => setNewMinimum(e.target.value)} />
            </div>
          )}
          {!newIsCash && !!newDrawdownAmount && (
            <div className="fj-sub" style={{ marginBottom: 12 }}>
              Flat minimum is hidden because Max drawdown is set above — the drawdown floor takes over once that's filled in, so a flat minimum wouldn't have any effect.
            </div>
          )}

          {error && <div className="fj-loss" style={{ fontSize: 12, marginBottom: 8 }}>{error}</div>}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button type="button" className="fj-btn" onClick={() => setShowAdd(false)}>Cancel</button>
            <button type="submit" className="fj-btn primary">Add account</button>
          </div>
        </form>
      )}

      {accounts.length === 0 ? (
        <div className="fj-empty">No accounts added yet — click "Add account" to start tracking balances.</div>
      ) : (
        <div className="fj-acct-grid">
          {accounts.map((a) => (
            <AccountCard
              key={a.id}
              account={a}
              trades={trades}
              onRemove={() => removeAccount(a.id)}
              onUpdate={(patch) => updateAccount(a.id, patch)}
              onAddPayout={(date, amount) => addPayout(a.id, date, amount)}
              onRemovePayout={(entryId) => removePayout(a.id, entryId)}
              onAddAdjustment={(date, amount, note) => addAdjustment(a.id, date, amount, note)}
              onRemoveAdjustment={(entryId) => removeAdjustment(a.id, entryId)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function AccountBar({ min, current, max, currentLabel, minLabel, maxLabel }) {
  const span = Math.max(max - min, 1);
  const pct = Math.max(0, Math.min(100, ((current - min) / span) * 100));
  const zoneColor = pct < 25 ? "var(--loss)" : pct < 75 ? "var(--amber)" : "var(--profit)";
  return (
    <div style={{ margin: "10px 0 4px" }}>
      <div style={{ position: "relative", height: 10, borderRadius: 6, background: "var(--panel-alt)", border: "1px solid var(--border)" }}>
        <div style={{ position: "absolute", left: 0, top: 0, height: "100%", width: `${pct}%`, borderRadius: 6, background: zoneColor, transition: "width .2s" }} />
        <div style={{ position: "absolute", left: `${pct}%`, top: -4, transform: "translateX(-50%)", width: 2, height: 18, background: "var(--text-bright)" }} />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 5, fontSize: 10.5, fontFamily: "Inter, sans-serif" }}>
        <span style={{ color: "var(--text-dim)" }}>{minLabel}<br /><b style={{ color: "var(--text)" }}>{money(min)}</b></span>
        <span style={{ color: "var(--text-dim)", textAlign: "center" }}>{currentLabel}<br /><b style={{ color: zoneColor }}>{money(current)}</b></span>
        <span style={{ color: "var(--text-dim)", textAlign: "right" }}>{maxLabel}<br /><b style={{ color: "var(--text)" }}>{money(max)}</b></span>
      </div>
    </div>
  );
}

function AccountCard({ account, trades, onRemove, onUpdate, onAddPayout, onRemovePayout, onAddAdjustment, onRemoveAdjustment }) {
  const [payoutDate, setPayoutDate] = useState(new Date().toISOString().slice(0, 10));
  const [payoutAmount, setPayoutAmount] = useState("");
  const [adjDate, setAdjDate] = useState(new Date().toISOString().slice(0, 10));
  const [adjAmount, setAdjAmount] = useState("");
  const [adjNote, setAdjNote] = useState("");
  const [editingDetails, setEditingDetails] = useState(false);
  const [showAdjustments, setShowAdjustments] = useState(false);

  const timelineData = buildAccountBalanceTimeline(account, trades);
  const { currentBalance, peakBalance, tradingPnl, totalAdjustments } = timelineData;
  const { floor, locked, mode } = computeAccountFloor(account, timelineData);
  const payouts = account.payouts || [];
  const totalPaidOut = payouts.reduce((s, p) => s + p.amount, 0);
  const distanceToFloor = currentBalance - floor;
  const profitTarget = Number(account.profitTarget) || 0;
  const isEvalWithTarget = account.status === "Evaluation" && profitTarget > 0;
  const equityCurveData = useMemo(() => buildAccountEquityCurve(account, trades), [account, trades]);

  const taggedTrades = trades.filter((t) => (t.accounts || []).includes(account.name));
  const sortedTradeDates = Array.from(new Set(taggedTrades.map((t) => t.date))).sort();
  const lastDay = sortedTradeDates[sortedTradeDates.length - 1];
  const lastDayPnl = lastDay ? taggedTrades.filter((t) => t.date === lastDay).reduce((s, t) => s + t.pnl, 0) : null;

  const submitPayout = (e) => {
    e.preventDefault();
    if (payoutAmount === "" || isNaN(Number(payoutAmount))) return;
    onAddPayout(payoutDate, Number(payoutAmount));
    setPayoutAmount("");
  };

  const submitAdjustment = (e) => {
    e.preventDefault();
    if (adjAmount === "" || isNaN(Number(adjAmount))) return;
    onAddAdjustment(adjDate, Number(adjAmount), adjNote.trim());
    setAdjAmount(""); setAdjNote("");
  };

  const badgeClass = account.isCash ? "cash" : account.status === "Passed" ? "passed" : account.status === "Failed" ? "failed" : "eval";
  const badgeLabel = account.isCash ? "Cash Account" : account.status === "Passed" ? "Passed / Funded" : account.status;
  const hasFloor = (Number(account.drawdownAmount) || 0) > 0 || (account.minimum || 0) > 0;
  const curveTrendUp = equityCurveData.length > 1 ? equityCurveData[equityCurveData.length - 1].balance >= equityCurveData[0].balance : true;

  return (
    <div className="fj-acct-card">
      <div className="fj-acct-head">
        <div>
          <div className="fj-acct-name">{account.name}</div>
          <span className={`fj-badge ${badgeClass}`}>{badgeLabel}</span>
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          {!account.isCash && (
            <select
              className="fj-select" style={{ fontSize: 11, padding: "4px 6px" }}
              value={account.status} onChange={(e) => onUpdate({ status: e.target.value })}
            >
              <option value="Evaluation">Evaluation</option>
              <option value="Passed">Passed / Funded</option>
              <option value="Failed">Failed</option>
            </select>
          )}
          <button className="fj-iconbtn" onClick={() => setShowAdjustments((s) => !s)} title="Fix balance"><Settings2 size={13} /></button>
          <button className="fj-iconbtn" onClick={() => setEditingDetails((s) => !s)} title="Edit account details"><Pencil size={13} /></button>
          <button className="fj-iconbtn" onClick={onRemove} title="Remove account"><Trash2 size={14} /></button>
        </div>
      </div>

      {equityCurveData.length > 1 && (
        <ResponsiveContainer width="100%" height={40}>
          <LineChart data={equityCurveData} margin={{ top: 4, right: 0, left: 0, bottom: 0 }}>
            <YAxis hide domain={["dataMin", "dataMax"]} />
            <Line type="monotone" dataKey="balance" stroke={curveTrendUp ? "var(--profit)" : "var(--loss)"} strokeWidth={1.75} dot={false} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      )}

      {editingDetails ? (
        <AccountDetailsEditor account={account} onSave={(patch) => { onUpdate(patch); setEditingDetails(false); }} onCancel={() => setEditingDetails(false)} />
      ) : (
        <>
          {hasFloor && isEvalWithTarget && (
            <AccountBar
              min={floor} current={currentBalance} max={account.startingBalance + profitTarget}
              minLabel="Floor" currentLabel="Current" maxLabel="Target to pass"
            />
          )}
          {hasFloor && !isEvalWithTarget && (
            <AccountBar
              min={floor} current={currentBalance} max={Math.max(peakBalance, currentBalance, floor + (Number(account.drawdownAmount) || 1000))}
              minLabel="Floor" currentLabel="Current" maxLabel="Peak"
            />
          )}

          <div className="fj-acct-row" style={{ marginTop: hasFloor ? 12 : 8 }}><span>Current balance</span><b>{money(currentBalance)}</b></div>
          <div className="fj-acct-row"><span>Starting balance</span><b>{money(account.startingBalance)}</b></div>
          {hasFloor && (
            <div className="fj-acct-row">
              <span>Drawdown floor {mode !== "static" && !locked ? "(trailing)" : mode !== "static" && locked ? "(locked)" : ""}</span>
              <b>{money(floor)}</b>
            </div>
          )}
          {isEvalWithTarget && (
            <div className="fj-acct-row"><span>Profit target</span><b>{money(account.startingBalance + profitTarget)}</b></div>
          )}
          <div className="fj-acct-row"><span>Trading P&amp;L (tagged trades)</span><b className={tradingPnl >= 0 ? "fj-profit" : "fj-loss"}>{money(tradingPnl)}</b></div>
          <div className="fj-acct-row"><span>Total paid out</span><b>{money(totalPaidOut)}</b></div>
          {totalAdjustments !== 0 && (
            <div className="fj-acct-row"><span>Manual adjustments</span><b className={totalAdjustments >= 0 ? "fj-profit" : "fj-loss"}>{money(totalAdjustments)}</b></div>
          )}
          <div className="fj-acct-row"><span>Last trading day P&amp;L</span><b className={lastDayPnl === null ? "fj-neutral" : lastDayPnl >= 0 ? "fj-profit" : "fj-loss"}>{lastDayPnl === null ? "—" : money(lastDayPnl)}</b></div>
          {hasFloor && (
            <div className="fj-acct-row">
              <span>Distance to floor</span>
              <b className={distanceToFloor >= 0 ? "fj-profit" : "fj-loss"}>{money(distanceToFloor)}</b>
            </div>
          )}
          <div className="fj-acct-row"><span>Trades tagged here</span><b>{taggedTrades.length}</b></div>

          <form onSubmit={submitPayout} className="fj-acct-updateform">
            <div className="fj-form-field" style={{ flex: 1 }}>
              <label>Payout date</label>
              <input type="date" className="fj-input" value={payoutDate} onChange={(e) => setPayoutDate(e.target.value)} />
            </div>
            <div className="fj-form-field" style={{ flex: 1 }}>
              <label>Amount paid out ($)</label>
              <input type="number" step="0.01" className="fj-input" placeholder="1000" value={payoutAmount} onChange={(e) => setPayoutAmount(e.target.value)} />
            </div>
            <button type="submit" className="fj-btn primary" style={{ height: 37 }}>Log payout</button>
          </form>

          {(account.payouts || []).length > 0 && (
            <div className="fj-acct-history">
              {[...account.payouts].sort((a, b) => b.date.localeCompare(a.date)).map((p) => (
                <div key={p.id} className="fj-acct-history-row">
                  <span>{p.date}</span>
                  <b>{money(p.amount)}</b>
                  <button className="fj-iconbtn" style={{ padding: 2 }} onClick={() => onRemovePayout(p.id)}><X size={12} /></button>
                </div>
              ))}
            </div>
          )}

          {showAdjustments && (
            <>
              <form onSubmit={submitAdjustment} className="fj-acct-updateform" style={{ marginTop: 14, paddingTop: 12, borderTop: "1px solid var(--border)" }}>
                <div className="fj-form-field" style={{ flex: 1 }}>
                  <label>Balance fix date</label>
                  <input type="date" className="fj-input" value={adjDate} onChange={(e) => setAdjDate(e.target.value)} />
                </div>
                <div className="fj-form-field" style={{ flex: 1 }}>
                  <label>Adjustment ($, + or -)</label>
                  <input type="number" step="0.01" className="fj-input" placeholder="-25.00" value={adjAmount} onChange={(e) => setAdjAmount(e.target.value)} />
                </div>
                <button type="submit" className="fj-btn" style={{ height: 37 }}>Apply fix</button>
              </form>
              <div className="fj-sub" style={{ marginTop: 4, marginBottom: 4 }}>
                Use this to correct the balance when it drifts from reality (a missed fee, a broker adjustment) — it doesn't touch the drawdown floor or any trade.
              </div>
              <input
                className="fj-input" style={{ fontFamily: "Inter, sans-serif", width: "100%", marginBottom: 8 }}
                placeholder="Optional note (e.g. 'missed commission on 7/12')" value={adjNote} onChange={(e) => setAdjNote(e.target.value)}
              />

              {(account.adjustments || []).length > 0 && (
                <div className="fj-acct-history">
                  {[...account.adjustments].sort((a, b) => b.date.localeCompare(a.date)).map((adj) => (
                    <div key={adj.id} className="fj-acct-history-row">
                      <span>{adj.date}{adj.note ? ` · ${adj.note}` : ""}</span>
                      <b className={adj.amount >= 0 ? "fj-profit" : "fj-loss"}>{money(adj.amount)}</b>
                      <button className="fj-iconbtn" style={{ padding: 2 }} onClick={() => onRemoveAdjustment(adj.id)}><X size={12} /></button>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

function AccountDetailsEditor({ account, onSave, onCancel }) {
  const [name, setName] = useState(account.name);
  const [isCash, setIsCash] = useState(!!account.isCash);
  const [startingBalance, setStartingBalance] = useState(account.startingBalance);
  const [minimum, setMinimum] = useState(account.minimum || 0);
  const [drawdownType, setDrawdownType] = useState(account.drawdownType || "eod");
  const [drawdownAmount, setDrawdownAmount] = useState(account.drawdownAmount || 0);
  const [profitTarget, setProfitTarget] = useState(account.profitTarget || 0);
  const [trailingLock, setTrailingLock] = useState(account.trailingLock || "target");
  const [error, setError] = useState("");

  const submit = (e) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) { setError("Account name can't be empty."); return; }
    onSave({
      name: trimmed,
      isCash,
      startingBalance: Number(startingBalance) || 0,
      minimum: Number(minimum) || 0,
      drawdownType: isCash ? "static" : drawdownType,
      drawdownAmount: isCash ? 0 : Number(drawdownAmount) || 0,
      profitTarget: isCash ? 0 : Number(profitTarget) || 0,
      trailingLock,
    });
  };

  return (
    <form onSubmit={submit} style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--border)" }}>
      <div className="fj-form-field" style={{ marginBottom: 8 }}>
        <label>Account name</label>
        <input className="fj-input" style={{ fontFamily: "Inter, sans-serif" }} value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="fj-form-row" style={{ gridTemplateColumns: (isCash || !Number(drawdownAmount)) ? "1fr 1fr" : "1fr", marginBottom: 8 }}>
        <div className="fj-form-field">
          <label>Starting balance ($)</label>
          <input type="number" step="0.01" className="fj-input" value={startingBalance} onChange={(e) => setStartingBalance(e.target.value)} />
        </div>
        {(isCash || !Number(drawdownAmount)) && (
          <div className="fj-form-field">
            <label>Flat minimum ($, optional)</label>
            <input type="number" step="0.01" className="fj-input" value={minimum} onChange={(e) => setMinimum(e.target.value)} />
          </div>
        )}
      </div>
      <label style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 12.5, color: "var(--text-dim)", margin: "2px 0 10px", cursor: "pointer" }}>
        <input type="checkbox" checked={isCash} onChange={(e) => setIsCash(e.target.checked)} />
        This is a cash account (no evaluation/funded status, no drawdown tracking)
      </label>
      {!isCash && (
        <>
          <div className="fj-form-row" style={{ gridTemplateColumns: "1fr 1fr 1fr", marginBottom: 8 }}>
            <div className="fj-form-field">
              <label>Drawdown type</label>
              <select className="fj-select" value={drawdownType} onChange={(e) => setDrawdownType(e.target.value)}>
                <option value="eod">EOD</option>
                <option value="intraday">Intraday</option>
                <option value="static">Static</option>
              </select>
            </div>
            <div className="fj-form-field">
              <label>Max drawdown ($)</label>
              <input type="number" step="0.01" className="fj-input" value={drawdownAmount} onChange={(e) => setDrawdownAmount(e.target.value)} />
            </div>
            <div className="fj-form-field">
              <label>Profit target ($)</label>
              <input type="number" step="0.01" className="fj-input" value={profitTarget} onChange={(e) => setProfitTarget(e.target.value)} />
            </div>
          </div>
          {!!Number(drawdownAmount) && (
            <div className="fj-sub" style={{ marginBottom: 10 }}>
              Flat minimum is hidden above because Max drawdown is set — the drawdown floor governs instead.
            </div>
          )}
          {drawdownType !== "static" && (
            <div className="fj-form-field" style={{ marginBottom: 10 }}>
              <label>Trailing locks at</label>
              <select className="fj-select" value={trailingLock} onChange={(e) => setTrailingLock(e.target.value)}>
                <option value="target">Profit target reached</option>
                <option value="starting">Starting balance reached</option>
                <option value="none">Never — always trails</option>
              </select>
            </div>
          )}
        </>
      )}
      {error && <div className="fj-loss" style={{ fontSize: 12, marginBottom: 8 }}>{error}</div>}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button type="button" className="fj-btn" onClick={onCancel}>Cancel</button>
        <button type="submit" className="fj-btn primary">Save details</button>
      </div>
    </form>
  );
}

// ---------- trade log ----------

function NoteRow({ note, onEdit, onDelete, colSpan }) {
  const [open, setOpen] = useState(false);
  const links = getNoteLinks(note);
  return (
    <>
      <tr style={{ background: "var(--panel-alt)" }}>
        <td colSpan={colSpan} style={{ padding: "6px 10px", cursor: "pointer" }} onClick={() => setOpen((o) => !o)}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, fontFamily: "Inter, sans-serif" }}>
            <span style={{ fontFamily: "'Inter', sans-serif", color: "var(--text-dim)", fontSize: 12 }}>{note.date}</span>
            <span className={`fj-badge ${note.category === "general" ? "cash" : "eval"}`} style={{ marginTop: 0 }}>{NOTE_CATEGORY_LABEL[note.category] || note.category}</span>
            <span style={{ fontWeight: 600, fontSize: 13, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{note.title}</span>
            {open ? <ChevronUp size={13} color="var(--text-dim)" /> : <ChevronDown size={13} color="var(--text-dim)" />}
          </div>
        </td>
      </tr>
      {open && (
        <tr style={{ background: "var(--panel-alt)" }}>
          <td colSpan={colSpan} style={{ padding: "0 10px 10px" }}>
            {links.length > 0 && (
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 6 }}>
                {links.map((l, i) => (
                  <span key={i} className="fj-sub" style={{ margin: 0, padding: "2px 8px", background: "var(--panel)", border: "1px solid var(--border)", borderRadius: 20, fontSize: 11 }}>
                    {l.type}: <b style={{ color: "var(--text)" }}>{l.key}</b>
                  </span>
                ))}
              </div>
            )}
            {note.body && <div className="fj-sub" style={{ lineHeight: 1.5, marginBottom: 8, fontFamily: "Inter, sans-serif" }}>{note.body}</div>}
            <div style={{ display: "flex", gap: 6 }}>
              <button className="fj-iconbtn" onClick={(e) => { e.stopPropagation(); onEdit(); }}><Pencil size={13} /></button>
              <button className="fj-iconbtn" onClick={(e) => { e.stopPropagation(); onDelete(); }}><Trash2 size={13} /></button>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function TradeLog({ trades, notes, strategies, settings, accounts, editingNoteId, onEditNote, onSaveNoteEdit, onCancelNoteEdit, onDeleteNote, onEdit, onDelete, onBulkUpdate, onBulkCopy }) {
  const [bulkMode, setBulkMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [bulkStrategy, setBulkStrategy] = useState("");
  const [bulkAccounts, setBulkAccounts] = useState([]);
  const [copyStrategy, setCopyStrategy] = useState("");
  const [copyAccounts, setCopyAccounts] = useState([]);
  const [copyDone, setCopyDone] = useState(0);

  const combined = useMemo(() => {
    const tradeRows = trades.map((t) => ({ _kind: "trade", data: t, date: t.date, time: t.time || "00:00" }));
    const noteRows = (notes || []).map((n) => ({ _kind: "note", data: n, date: n.date, time: "00:00" }));
    return [...tradeRows, ...noteRows].sort((a, b) => new Date(`${b.date}T${b.time}`) - new Date(`${a.date}T${a.time}`));
  }, [trades, notes]);

  const tradeIds = useMemo(() => trades.map((t) => t.id), [trades]);
  const allSelected = tradeIds.length > 0 && tradeIds.every((id) => selectedIds.has(id));

  const toggleBulkMode = () => {
    setBulkMode((v) => !v);
    setSelectedIds(new Set());
    setBulkStrategy("");
    setBulkAccounts([]);
    setCopyStrategy("");
    setCopyAccounts([]);
    setCopyDone(0);
  };

  const toggleSelect = (id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => setSelectedIds(allSelected ? new Set() : new Set(tradeIds));

  const toggleBulkAccount = (name) =>
    setBulkAccounts((prev) => (prev.includes(name) ? prev.filter((a) => a !== name) : [...prev, name]));

  const applyBulk = () => {
    if (!onBulkUpdate || selectedIds.size === 0) return;
    const patch = {};
    if (bulkStrategy.trim()) patch.strategy = bulkStrategy.trim();
    if (bulkAccounts.length) patch.accounts = bulkAccounts;
    if (Object.keys(patch).length === 0) return;
    onBulkUpdate(Array.from(selectedIds), patch);
    setSelectedIds(new Set());
    setBulkStrategy("");
    setBulkAccounts([]);
  };

  const toggleCopyAccount = (name) =>
    setCopyAccounts((prev) => (prev.includes(name) ? prev.filter((a) => a !== name) : [...prev, name]));

  // Duplicates the selected trades into a new strategy, leaving the
  // originals exactly as they are — so a strategy's history before a rule
  // change stays intact while the same trades also appear, unmixed with
  // anything logged before, under the new strategy.
  const applyCopy = () => {
    if (!onBulkCopy || selectedIds.size === 0 || !copyStrategy.trim()) return;
    const patch = { strategy: copyStrategy.trim() };
    if (copyAccounts.length) patch.accounts = copyAccounts;
    onBulkCopy(Array.from(selectedIds), patch);
    setCopyDone(selectedIds.size);
    setSelectedIds(new Set());
    setCopyStrategy("");
    setCopyAccounts([]);
  };

  if (combined.length === 0) return <div className="fj-empty">No trades match the current filters.</div>;

  const colCount = 13 + (bulkMode ? 1 : 0);

  return (
    <div className="fj-panel" style={{ overflowX: "auto" }}>
      {onBulkUpdate && (
        <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: bulkMode ? 10 : 12 }}>
          <button className="fj-btn" onClick={toggleBulkMode}>
            {bulkMode ? "Cancel" : "Select trades"}
          </button>
        </div>
      )}

      {bulkMode && (
        <div className="fj-panel" style={{ background: "rgba(217,164,65,0.08)", borderColor: "var(--amber)", marginBottom: 12 }}>
          <div className="fj-sub" style={{ marginBottom: 10 }}>
            {selectedIds.size} trade{selectedIds.size === 1 ? "" : "s"} selected — check rows below, then set a strategy and/or account(s) to apply to all of them at once.
          </div>
          <div className="fj-form-row" style={{ gridTemplateColumns: "1fr 1fr auto", alignItems: "end", gap: 10 }}>
            <div className="fj-form-field">
              <label>Set strategy</label>
              <input
                list="fj-bulk-strategy-options"
                className="fj-input"
                value={bulkStrategy}
                onChange={(e) => setBulkStrategy(e.target.value)}
                placeholder="Type or pick a strategy…"
              />
              <datalist id="fj-bulk-strategy-options">
                {(strategies || []).map((s) => <option key={s} value={s} />)}
              </datalist>
            </div>
            <div className="fj-form-field">
              <label>Set account(s)</label>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {(accounts || []).map((a) => (
                  <span
                    key={a.id}
                    className={`fj-chip ${bulkAccounts.includes(a.name) ? "active" : ""}`}
                    onClick={() => toggleBulkAccount(a.name)}
                  >
                    {a.name}
                  </span>
                ))}
                {(!accounts || accounts.length === 0) && <span className="fj-sub">No accounts set up.</span>}
              </div>
            </div>
            <button
              className="fj-btn primary"
              disabled={selectedIds.size === 0 || (!bulkStrategy.trim() && bulkAccounts.length === 0)}
              onClick={applyBulk}
            >
              Apply to {selectedIds.size}
            </button>
          </div>
        </div>
      )}

      {bulkMode && onBulkCopy && (
        <div className="fj-panel" style={{ background: "rgba(108,147,173,0.08)", borderColor: "var(--accent-blue, #6C93AD)", marginBottom: 12 }}>
          <div className="fj-sub" style={{ marginBottom: 10 }}>
            Or <b style={{ color: "var(--text-bright)" }}>copy</b> the checked trades into a new strategy instead — the originals stay exactly where they are, untouched, and the copies show up as fresh trades under the new name. Copies are excluded from the portfolio's overall totals and account balances (they're the same underlying trade, not new money) — they only count toward the new strategy's own numbers.
          </div>
          <div className="fj-form-row" style={{ gridTemplateColumns: "1fr 1fr auto", alignItems: "end", gap: 10 }}>
            <div className="fj-form-field">
              <label>Copy to strategy</label>
              <input
                list="fj-bulk-strategy-options"
                className="fj-input"
                value={copyStrategy}
                onChange={(e) => setCopyStrategy(e.target.value)}
                placeholder="New or existing strategy name…"
              />
            </div>
            <div className="fj-form-field">
              <label>Account(s) for copies <span className="fj-sub" style={{ fontWeight: 400 }}>(optional — keeps original if blank)</span></label>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {(accounts || []).map((a) => (
                  <span
                    key={a.id}
                    className={`fj-chip ${copyAccounts.includes(a.name) ? "active" : ""}`}
                    onClick={() => toggleCopyAccount(a.name)}
                  >
                    {a.name}
                  </span>
                ))}
                {(!accounts || accounts.length === 0) && <span className="fj-sub">No accounts set up.</span>}
              </div>
            </div>
            <button
              className="fj-btn primary"
              disabled={selectedIds.size === 0 || !copyStrategy.trim()}
              onClick={applyCopy}
            >
              Copy {selectedIds.size} to "{copyStrategy.trim() || "…"}"
            </button>
          </div>
          {copyDone > 0 && (
            <div className="fj-sub" style={{ marginTop: 10, color: "#8FBF98" }}>
              Copied {copyDone} trade{copyDone === 1 ? "" : "s"} — the originals are untouched and still under their old strategy.
            </div>
          )}
        </div>
      )}

      <table className="fj-table">
        <thead>
          <tr>
            {bulkMode && (
              <th style={{ width: 30 }}>
                <input type="checkbox" checked={allSelected} onChange={toggleSelectAll} />
              </th>
            )}
            <th>Date</th><th>Time</th><th>Market</th><th>Strategy</th><th>Accounts</th><th>Dir</th><th>Qty</th>
            <th>Entry</th><th>Exit</th><th>P&amp;L</th><th>Dur.</th><th style={{ fontFamily: "Inter" }}>Notes</th><th></th>
          </tr>
        </thead>
        <tbody>
          {combined.map((row) => {
            if (row._kind === "note") {
              const n = row.data;
              if (editingNoteId === n.id) {
                return (
                  <tr key={`note-edit-${n.id}`}>
                    <td colSpan={colCount} style={{ padding: 0 }}>
                      <div style={{ padding: "10px 12px" }}>
                        <NoteForm initial={n} strategies={strategies} settings={settings} accounts={accounts} onSave={onSaveNoteEdit} onCancel={onCancelNoteEdit} />
                      </div>
                    </td>
                  </tr>
                );
              }
              return <NoteRow key={`note-${n.id}`} note={n} onEdit={() => onEditNote(n.id)} onDelete={() => onDeleteNote(n.id)} colSpan={colCount} />;
            }
            const t = row.data;
            return (
              <tr key={t.id}>
                {bulkMode && (
                  <td>
                    <input type="checkbox" checked={selectedIds.has(t.id)} onChange={() => toggleSelect(t.id)} />
                  </td>
                )}
                <td>{t.date}</td>
                <td>{t.time || "—"}</td>
                <td>{t.market}</td>
                <td style={{ fontFamily: "Inter, sans-serif" }}>
                  {t.strategy || "—"}
                  {t._isCopy && (
                    <span style={{ marginLeft: 5, fontSize: 10, border: "1px solid #6C93AD", borderRadius: 4, padding: "1px 4px", color: "#8FB4D1", background: "rgba(108,147,173,0.12)" }} title="Copied from another strategy — excluded from portfolio totals and account balances so it isn't double-counted">
                      copy
                    </span>
                  )}
                </td>
                <td style={{ fontFamily: "Inter, sans-serif", color: "var(--text-dim)" }}>{(t.accounts && t.accounts.length) ? t.accounts.join(", ") : "—"}</td>
                <td className={t.direction === "Short" ? "fj-loss" : "fj-profit"}>{t.direction}</td>
                <td>{t.contracts}</td>
                <td>{t.entry || "—"}</td>
                <td>{t.exit || "—"}</td>
                <td className={t.pnl >= 0 ? "fj-profit" : "fj-loss"}>{money(t.pnl)}</td>
                <td style={{ color: "var(--text-dim)" }}>{formatDuration(t.durationSec)}</td>
                <td style={{ fontFamily: "Inter, sans-serif", color: "var(--text-dim)", maxWidth: 180, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{t.notes || ""}</td>
                <td className="actions">
                  <button className="fj-iconbtn" onClick={() => onEdit(t)}><Pencil size={14} /></button>
                  <button className="fj-iconbtn" onClick={() => onDelete(t.id)}><Trash2 size={14} /></button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---------- calendar view ----------

function CalendarView({ trades, strategies, settings }) {
  const today = new Date();
  const [cursor, setCursor] = useState(new Date(today.getFullYear(), today.getMonth(), 1));
  const [selectedStrategies, setSelectedStrategies] = useState([]);
  const [mode, setMode] = useState("month"); // "month" | "year"
  const [category, setCategory] = useState("all"); // all | micro | mini

  const hasMicro = Object.values(settings).some((m) => (m.category || "micro") === "micro");
  const hasMini = Object.values(settings).some((m) => m.category === "mini");

  const categoryFiltered = useMemo(
    () => category === "all" ? trades : trades.filter((t) => (settings[t.market]?.category || "micro") === category),
    [trades, settings, category]
  );

  const scoped = useMemo(
    () => selectedStrategies.length === 0 ? categoryFiltered : categoryFiltered.filter((t) => selectedStrategies.includes(t.strategy)),
    [categoryFiltered, selectedStrategies]
  );

  const toggleStrategy = (s) => setSelectedStrategies((v) => v.includes(s) ? v.filter((x) => x !== s) : [...v, s]);

  const byDate = useMemo(() => {
    const map = {};
    scoped.forEach((t) => {
      map[t.date] = map[t.date] || { pnl: 0, count: 0 };
      map[t.date].pnl += t.pnl;
      map[t.date].count += 1;
    });
    return map;
  }, [scoped]);

  const year = cursor.getFullYear();
  const month = cursor.getMonth();

  const { weeks, monthTotal, monthCount, maxAbs: monthMaxAbs } = useMemo(
    () => buildMonthGrid(year, month, byDate),
    [year, month, byDate]
  );

  const yearMaxAbs = useMemo(() => {
    let max = 1;
    Object.entries(byDate).forEach(([date, d]) => {
      if (date.slice(0, 4) === String(year)) max = Math.max(max, Math.abs(d.pnl));
    });
    return max;
  }, [byDate, year]);

  const yearTotal = useMemo(() => {
    let pnl = 0, count = 0;
    Object.entries(byDate).forEach(([date, d]) => {
      if (date.slice(0, 4) === String(year)) { pnl += d.pnl; count += d.count; }
    });
    return { pnl, count };
  }, [byDate, year]);

  const goPrev = () => setCursor(new Date(year, month - 1, 1));
  const goNext = () => setCursor(new Date(year, month + 1, 1));
  const goToday = () => setCursor(new Date(today.getFullYear(), today.getMonth(), 1));
  const goPrevYear = () => setCursor(new Date(year - 1, month, 1));
  const goNextYear = () => setCursor(new Date(year + 1, month, 1));
  const jumpToMonth = (m) => { setCursor(new Date(year, m, 1)); setMode("month"); };

  return (
    <div>
      <div className="fj-panel">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10, marginBottom: 6 }}>
          <MultiPick label="Strategy" options={strategies} selected={selectedStrategies} onToggle={toggleStrategy} onClear={() => setSelectedStrategies([])} />
          {(hasMicro && hasMini) && (
            <div className="fj-seg-toggle">
              <button className={`fj-seg-btn ${category === "all" ? "active" : ""}`} onClick={() => setCategory("all")}>All contracts</button>
              <button className={`fj-seg-btn ${category === "micro" ? "active" : ""}`} onClick={() => setCategory("micro")}>Micro only</button>
              <button className={`fj-seg-btn ${category === "mini" ? "active" : ""}`} onClick={() => setCategory("mini")}>Mini only</button>
            </div>
          )}
        </div>
      </div>

      <div className="fj-panel">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
          <div className="fj-cal-nav">
            {mode === "month" ? (
              <>
                <button className="fj-iconbtn" onClick={goPrev}>◀</button>
                <span className="fj-cal-month-label">{MONTH_LABELS[month]} {year}</span>
                <button className="fj-iconbtn" onClick={goNext}>▶</button>
                <button className="fj-btn" style={{ padding: "5px 10px" }} onClick={goToday}>Today</button>
              </>
            ) : (
              <>
                <button className="fj-iconbtn" onClick={goPrevYear}>◀</button>
                <span className="fj-cal-month-label">{year}</span>
                <button className="fj-iconbtn" onClick={goNextYear}>▶</button>
                <button className="fj-btn" style={{ padding: "5px 10px" }} onClick={goToday}>This year</button>
              </>
            )}
            <div className="fj-seg-toggle">
              <button className={`fj-seg-btn ${mode === "month" ? "active" : ""}`} onClick={() => setMode("month")}>Month</button>
              <button className={`fj-seg-btn ${mode === "year" ? "active" : ""}`} onClick={() => setMode("year")}>Year</button>
            </div>
          </div>
          <div style={{ display: "flex", gap: 18 }}>
            <div>
              <div className="fj-stat-label">{mode === "month" ? "Month P&L" : "Year P&L"}</div>
              <div className={`fj-stat-value ${(mode === "month" ? monthTotal : yearTotal.pnl) >= 0 ? "fj-profit" : "fj-loss"}`}>
                {(mode === "month" ? monthCount : yearTotal.count) ? money(mode === "month" ? monthTotal : yearTotal.pnl) : "—"}
              </div>
            </div>
            <div>
              <div className="fj-stat-label">Trades</div>
              <div className="fj-stat-value">{mode === "month" ? monthCount : yearTotal.count}</div>
            </div>
          </div>
        </div>

        {mode === "month" ? (
          <div className="fj-cal-grid">
            {DOW_LABELS.map((l) => <div key={l} className="fj-cal-headcell">{l}</div>)}
            <div className="fj-cal-headcell">Week</div>

            {weeks.map((week, wi) => {
              const weekTotal = week.reduce((s, d) => s + d.pnl, 0);
              const weekCount = week.reduce((s, d) => s + d.count, 0);
              return (
                <React.Fragment key={wi}>
                  {week.map((d) => {
                    const hasData = d.count > 0;
                    const lightText = "#F3F1EC";
                    const lightMuted = "rgba(243,241,236,0.75)";
                    return (
                      <div
                        key={d.key}
                        className={`fj-cal-cell ${d.inMonth ? "" : "pad"}`}
                        style={{ background: hasData ? heatColor(d.pnl, monthMaxAbs) : undefined }}
                        title={hasData ? `${d.key} · ${d.count} trade${d.count === 1 ? "" : "s"} · ${money(d.pnl)}` : d.key}
                      >
                        <span className="fj-cal-daynum" style={hasData ? { color: lightMuted } : undefined}>{d.dayNum}</span>
                        {hasData && (
                          <>
                            <span className="fj-cal-cell-pnl" style={{ color: lightText }}>{money(d.pnl)}</span>
                            <span className="fj-cal-cell-count" style={{ color: lightMuted }}>{d.count} trade{d.count === 1 ? "" : "s"}</span>
                          </>
                        )}
                      </div>
                    );
                  })}
                  <div className="fj-cal-weektotal">
                    <span className="fj-cal-weektotal-label">Week {wi + 1}</span>
                    <span className={`fj-cal-weektotal-val ${weekTotal >= 0 ? "fj-profit" : "fj-loss"}`}>{weekCount ? money(weekTotal) : "—"}</span>
                  </div>
                </React.Fragment>
              );
            })}
          </div>
        ) : (
          <div className="fj-year-grid">
            {Array.from({ length: 12 }, (_, m) => m).map((m) => {
              const g = buildMonthGrid(year, m, byDate, yearMaxAbs);
              return (
                <div key={m} className="fj-year-month-card" onClick={() => jumpToMonth(m)} title={`Open ${MONTH_LABELS[m]} ${year}`}>
                  <div className="fj-year-month-head">
                    <span className="fj-year-month-name">{MONTH_LABELS[m].slice(0, 3)}</span>
                    <span className={`fj-year-month-pnl ${g.monthCount ? (g.monthTotal >= 0 ? "fj-profit" : "fj-loss") : "fj-neutral"}`}>
                      {g.monthCount ? money(g.monthTotal) : "—"}
                    </span>
                  </div>
                  <div className="fj-mini-grid">
                    {g.weeks.map((week, wi) => (
                      <div key={wi} className="fj-mini-week">
                        {week.map((d) => (
                          <div
                            key={d.key}
                            className="fj-mini-day"
                            title={d.count ? `${d.key} · ${money(d.pnl)}` : d.key}
                            style={{ background: d.inMonth ? (d.count ? heatColor(d.pnl, yearMaxAbs) : "rgba(139,146,158,0.10)") : "transparent" }}
                          />
                        ))}
                      </div>
                    ))}
                  </div>
                  <div className="fj-sub" style={{ marginTop: 7, fontSize: 10.5 }}>{g.monthCount} trade{g.monthCount === 1 ? "" : "s"}</div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------- heatmaps ----------

// ---------- advanced stats ----------

const WINDOW_OPTIONS = [
  ["15", "15 min"],
  ["30", "30 min"],
  ["60", "1 hour"],
  ["dow", "Day of week"],
  ["date", "Calendar day"],
];
const TRADING_DOW_ORDER = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

function WindowStatsPanel({ trades }) {
  const [windowMode, setWindowMode] = useState("15");

  const isTimeWindow = windowMode === "15" || windowMode === "30" || windowMode === "60";
  const timelessCount = isTimeWindow ? trades.filter((t) => !t.time).length : 0;

  const buckets = useMemo(() => {
    if (windowMode === "dow") {
      const map = {};
      trades.forEach((t) => {
        const label = DOW_LABELS_FULL[dowOf(t.date)];
        map[label] = map[label] || [];
        map[label].push(t);
      });
      return TRADING_DOW_ORDER.filter((l) => map[l]).map((l) => ({ key: l, label: l, trades: map[l] }));
    }
    if (windowMode === "date") {
      const map = {};
      trades.forEach((t) => { map[t.date] = map[t.date] || []; map[t.date].push(t); });
      return Object.keys(map).sort().map((d) => ({ key: d, label: d, trades: map[d] }));
    }
    const windowMinutes = Number(windowMode);
    const map = {};
    trades.filter((t) => t.time).forEach((t) => {
      const [h, m] = t.time.split(":").map(Number);
      if (Number.isNaN(h) || Number.isNaN(m)) return;
      const totalMin = h * 60 + m;
      const bucketStart = Math.floor(totalMin / windowMinutes) * windowMinutes;
      map[bucketStart] = map[bucketStart] || [];
      map[bucketStart].push(t);
    });
    const fmt = (mins) => `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
    return Object.keys(map).map(Number).sort((a, b) => a - b)
      .map((start) => ({ key: start, label: `${fmt(start)}–${fmt(start + windowMinutes)}`, trades: map[start] }));
  }, [trades, windowMode]);

  const rows = buckets.map((b) => ({ ...b, stats: calcStats(b.trades) }));
  const barData = rows.map((r) => ({ name: r.label, pnl: r.stats.totalPnl }));

  const rowsWithTrades = rows.filter((r) => r.stats.n > 0);
  const bestRow = rowsWithTrades.length ? rowsWithTrades.reduce((a, b) => b.stats.totalPnl > a.stats.totalPnl ? b : a) : null;
  const worstRow = rowsWithTrades.length ? rowsWithTrades.reduce((a, b) => b.stats.totalPnl < a.stats.totalPnl ? b : a) : null;
  const allWins = trades.filter((t) => t.pnl > 0);
  const allLosses = trades.filter((t) => t.pnl < 0);
  const largestWin = allWins.length ? Math.max(...allWins.map((t) => t.pnl)) : null;
  const largestLoss = allLosses.length ? Math.min(...allLosses.map((t) => t.pnl)) : null;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
        <span className="fj-sub" style={{ marginRight: 2 }}>Window:</span>
        <div className="fj-seg-toggle">
          {WINDOW_OPTIONS.map(([key, label]) => (
            <button key={key} className={`fj-seg-btn ${windowMode === key ? "active" : ""}`} onClick={() => setWindowMode(key)}>
              {label}
            </button>
          ))}
        </div>
      </div>
      {isTimeWindow && timelessCount > 0 && (
        <div className="fj-sub" style={{ marginBottom: 10 }}>
          {timelessCount} trade{timelessCount === 1 ? "" : "s"} without a logged time excluded from this window.
        </div>
      )}

      {rows.length === 0 ? (
        <div className="fj-empty">No trades in this scope{isTimeWindow ? " — trades need a logged time to appear in 15/30/60-min windows." : "."}</div>
      ) : (
        <>
          <div className="fj-stat-grid">
            {bestRow && (
              <div className="fj-stat-card">
                <div className="fj-stat-label">Best window</div>
                <div className="fj-stat-value fj-profit" style={{ fontSize: 15 }}>{bestRow.label}</div>
                <div className="fj-sub">{money(bestRow.stats.totalPnl)}</div>
              </div>
            )}
            {worstRow && (
              <div className="fj-stat-card">
                <div className="fj-stat-label">Worst window</div>
                <div className="fj-stat-value fj-loss" style={{ fontSize: 15 }}>{worstRow.label}</div>
                <div className="fj-sub">{money(worstRow.stats.totalPnl)}</div>
              </div>
            )}
            <div className="fj-stat-card">
              <div className="fj-stat-label">Largest single win</div>
              <div className="fj-stat-value fj-profit">{largestWin !== null ? money(largestWin) : "—"}</div>
            </div>
            <div className="fj-stat-card">
              <div className="fj-stat-label">Largest single loss</div>
              <div className="fj-stat-value fj-loss">{largestLoss !== null ? money(largestLoss) : "—"}</div>
            </div>
          </div>

          <ResponsiveContainer width="100%" height={190}>
            <BarChart data={barData} margin={{ top: 4, right: 8, left: -10, bottom: 0 }}>
              <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
              <XAxis dataKey="name" stroke="var(--text-dim)" tick={{ fontSize: 10.5, fontFamily: "Inter" }} interval={0} angle={rows.length > 8 ? -40 : 0} textAnchor={rows.length > 8 ? "end" : "middle"} height={rows.length > 8 ? 55 : 30} />
              <YAxis stroke="var(--text-dim)" tick={{ fontSize: 11, fontFamily: "Inter" }} />
              <ReferenceLine y={0} stroke="var(--border-strong)" />
              <Tooltip
                contentStyle={{ background: "var(--panel-alt)", border: "1px solid var(--border)", borderRadius: 8, fontFamily: "Inter", fontSize: 12 }}
                labelStyle={{ color: "var(--text-bright)", fontWeight: 600, marginBottom: 4 }}
                itemStyle={{ color: "var(--text-bright)" }}
                cursor={{ fill: "rgba(139,146,158,0.08)" }}
                formatter={(v) => [money(v), "P&L"]}
              />
              <Bar dataKey="pnl" radius={[4, 4, 0, 0]}>
                {barData.map((d, i) => <Cell key={i} fill={d.pnl >= 0 ? "var(--profit)" : "var(--loss)"} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>

          <div style={{ overflowX: "auto", marginTop: 12 }}>
            <div className="fj-scroll-y"><table className="fj-table">
              <thead>
                <tr>
                  <th>Window</th><th>Trades</th><th>Win %</th><th>P&amp;L</th><th>Avg P&amp;L</th><th>Avg Win</th><th>Avg Loss</th><th>Profit Factor</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.key}>
                    <td>{r.label}</td>
                    <td>{r.stats.n} <span style={{ color: "var(--text-dim)" }}>({r.stats.wins}W/{r.stats.losses}L)</span></td>
                    <td>{pct(r.stats.winRate)}</td>
                    <td className={r.stats.totalPnl >= 0 ? "fj-profit" : "fj-loss"}>{money(r.stats.totalPnl)}</td>
                    <td className={r.stats.expectancy >= 0 ? "fj-profit" : "fj-loss"}>{money(r.stats.expectancy)}</td>
                    <td className="fj-profit">{r.stats.wins ? money(r.stats.avgWin) : "—"}</td>
                    <td className="fj-loss">{r.stats.losses ? money(-r.stats.avgLoss) : "—"}</td>
                    <td>{r.stats.profitFactor === null ? "—" : r.stats.profitFactor === Infinity ? "∞" : r.stats.profitFactor.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          </div>
        </>
      )}
    </div>
  );
}

function MartingaleDepthPanel({ trades }) {
  const stats = useMemo(() => computeMartingaleDepthStats(trades), [trades]);

  if (!stats || stats.rows.length < 2) {
    return (
      <div className="fj-panel">
        <p className="fj-panel-title">Stats by martingale depth</p>
        <div className="fj-empty">
          {stats ? "This strategy has only ever been traded at one size — nothing to compare yet." : "No trades logged for this strategy yet."}
        </div>
      </div>
    );
  }

  const { base, overallWinRate, overallExpectancyPerContract, rows } = stats;

  const winRateData = rows.map((r) => ({
    name: r.label,
    n: r.n,
    winRate: Number(r.winRate.toFixed(1)),
    ciDelta: [
      Math.max(0, r.winRate - r.ciLower),
      Math.max(0, r.ciUpper - r.winRate),
    ],
  }));
  const evData = rows.map((r) => ({ name: r.label, n: r.n, ev: Number(r.expectancyPerContract.toFixed(2)) }));

  const rowsWithSample = rows.filter((r) => !r.lowSample);
  const best = rowsWithSample.length
    ? rowsWithSample.reduce((a, b) => (b.expectancyPerContract > a.expectancyPerContract ? b : a))
    : null;
  const worst = rowsWithSample.length
    ? rowsWithSample.reduce((a, b) => (b.expectancyPerContract < a.expectancyPerContract ? b : a))
    : null;
  const mostTraded = rows.reduce((a, b) => (b.n > a.n ? b : a));

  const winRateTick = (props) => {
    const { x, y, payload } = props;
    const row = winRateData.find((d) => d.name === payload.value);
    return (
      <g transform={`translate(${x},${y})`}>
        <text x={0} y={0} dy={12} textAnchor="middle" fill="var(--text-dim)" fontSize={11} fontFamily="Inter, sans-serif">{payload.value}</text>
        <text x={0} y={0} dy={25} textAnchor="middle" fill="var(--text-dim)" fontSize={9.5} fontFamily="Inter, sans-serif">n={row ? row.n : 0}</text>
      </g>
    );
  };

  return (
    <div className="fj-panel">
      <p className="fj-panel-title">Stats by martingale depth</p>
      <div className="fj-sub" style={{ marginBottom: 12, lineHeight: 1.6 }}>
        Detected base size for this strategy: <b style={{ color: "var(--text-bright)" }}>{base} contract{base === 1 ? "" : "s"}</b>. Trades are bucketed by size relative to that base (1x/2x/4x…), and every number below is normalized to a single contract — otherwise a 4x trade's bigger dollar swing would just look "more effective" by construction.
      </div>

      <div className="fj-stat-grid" style={{ marginBottom: 14 }}>
        <div className="fj-stat-card">
          <div className="fj-stat-label">Most effective size</div>
          <div className="fj-stat-value fj-profit" style={{ fontSize: 15 }}>{best ? best.label : "—"}</div>
          <div className="fj-sub">{best ? `${money(best.expectancyPerContract)}/contract` : "not enough data yet"}</div>
        </div>
        <div className="fj-stat-card">
          <div className="fj-stat-label">Least effective size</div>
          <div className="fj-stat-value fj-loss" style={{ fontSize: 15 }}>{worst ? worst.label : "—"}</div>
          <div className="fj-sub">{worst ? `${money(worst.expectancyPerContract)}/contract` : "not enough data yet"}</div>
        </div>
        <div className="fj-stat-card">
          <div className="fj-stat-label">Most traded size</div>
          <div className="fj-stat-value" style={{ fontSize: 15 }}>{mostTraded.label}</div>
          <div className="fj-sub">{mostTraded.n} trade{mostTraded.n === 1 ? "" : "s"}</div>
        </div>
        <div className="fj-stat-card">
          <div className="fj-stat-label">Blended (all sizes)</div>
          <div className="fj-stat-value" style={{ fontSize: 15 }}>{money(overallExpectancyPerContract)}/contract</div>
          <div className="fj-sub">{pct(overallWinRate)} win rate</div>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 14 }}>
        <div>
          <div className="fj-sub" style={{ marginBottom: 6, fontSize: 11.5, letterSpacing: 0 }}>
            Win rate by size (95% CI)
          </div>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={winRateData} margin={{ top: 4, right: 8, left: -10, bottom: 4 }}>
              <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
              <XAxis dataKey="name" stroke="var(--text-dim)" tick={winRateTick} interval={0} height={38} />
              <YAxis stroke="var(--text-dim)" tick={{ fontSize: 11, fontFamily: "Inter" }} domain={[0, 100]} unit="%" />
              <ReferenceLine y={overallWinRate} stroke="var(--amber)" strokeDasharray="4 3" label={{ value: "blended", position: "insideTopRight", fill: "var(--amber)", fontSize: 10 }} />
              <Tooltip
                contentStyle={{ background: "var(--panel-alt)", border: "1px solid var(--border)", borderRadius: 8, fontFamily: "Inter", fontSize: 12 }}
                labelStyle={{ color: "var(--text-bright)", fontWeight: 600, marginBottom: 4 }}
                itemStyle={{ color: "var(--text-bright)" }}
                cursor={{ fill: "rgba(139,146,158,0.08)" }}
                formatter={(v, key, item) => [`${v}% (n=${item.payload.n})`, "Win rate"]}
              />
              <Bar dataKey="winRate" radius={[4, 4, 0, 0]}>
                {winRateData.map((d, i) => (
                  <Cell key={i} fill={d.winRate >= overallWinRate ? "var(--profit)" : "var(--loss)"} />
                ))}
                <ErrorBar dataKey="ciDelta" width={4} strokeWidth={1.25} stroke="var(--text-dim)" />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div>
          <div className="fj-sub" style={{ marginBottom: 6, fontSize: 11.5, letterSpacing: 0 }}>
            Expected value per contract by size
          </div>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={evData} margin={{ top: 4, right: 8, left: -10, bottom: 4 }}>
              <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
              <XAxis dataKey="name" stroke="var(--text-dim)" tick={winRateTick} interval={0} height={38} />
              <YAxis stroke="var(--text-dim)" tick={{ fontSize: 11, fontFamily: "Inter" }} />
              <ReferenceLine y={0} stroke="var(--border-strong)" />
              <ReferenceLine y={overallExpectancyPerContract} stroke="var(--amber)" strokeDasharray="4 3" label={{ value: "blended", position: "insideTopRight", fill: "var(--amber)", fontSize: 10 }} />
              <Tooltip
                contentStyle={{ background: "var(--panel-alt)", border: "1px solid var(--border)", borderRadius: 8, fontFamily: "Inter", fontSize: 12 }}
                labelStyle={{ color: "var(--text-bright)", fontWeight: 600, marginBottom: 4 }}
                itemStyle={{ color: "var(--text-bright)" }}
                cursor={{ fill: "rgba(139,146,158,0.08)" }}
                formatter={(v, key, item) => [`${money(v)}/contract (n=${item.payload.n})`, "EV"]}
              />
              <Bar dataKey="ev" radius={[4, 4, 0, 0]}>
                {evData.map((d, i) => <Cell key={i} fill={d.ev >= 0 ? "var(--profit)" : "var(--loss)"} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div style={{ overflowX: "auto", marginTop: 14 }}>
        <table className="fj-table">
          <thead>
            <tr>
              <th>Size</th><th>Trades</th><th>Win % (95% CI)</th><th>Avg win /contract</th><th>Avg loss /contract</th><th>EV /contract</th><th>Total $</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.depth}>
                <td style={{ fontFamily: "Inter, sans-serif", fontWeight: 600 }}>
                  {r.label} <span style={{ color: "var(--text-dim)", fontWeight: 400 }}>({r.contractsAtDepth}c)</span>
                  {r.lowSample && <span className="fj-badge eval" style={{ marginLeft: 6 }} title="Under 10 trades — treat this bucket as a rough estimate">Low sample</span>}
                </td>
                <td>{r.n} <span style={{ color: "var(--text-dim)" }}>({r.wins}W/{r.losses}L)</span></td>
                <td>{pct(r.winRate)} <span style={{ color: "var(--text-dim)" }}>({r.ciLower.toFixed(0)}–{r.ciUpper.toFixed(0)}%)</span></td>
                <td className="fj-profit">{r.wins ? money(r.avgWinPerContract) : "—"}</td>
                <td className="fj-loss">{r.losses ? money(r.avgLossPerContract) : "—"}</td>
                <td className={r.expectancyPerContract >= 0 ? "fj-profit" : "fj-loss"}>{money(r.expectancyPerContract)}</td>
                <td className={r.totalPnl >= 0 ? "fj-profit" : "fj-loss"}>{money(r.totalPnl)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="fj-sub" style={{ fontSize: 11, marginTop: 10 }}>
        Deeper sizes only happen after a loss, so their sample sizes are structurally smaller — treat any "low sample" bucket's win rate as a wide guess, not a verdict. Wilson 95% CI shown both on the chart (error bars) and in the table.
      </div>
    </div>
  );
}

// ---------- detail view (strategy or market drill-down) ----------

function DailyLossLimitPanel({ trades }) {
  const [k, setK] = useState(2);
  const stats = useMemo(() => computeDailyLossLimit(trades), [trades]);

  if (!stats) return null;
  const limit = stats.limits[k];

  return (
    <div className="fj-panel">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, marginBottom: 4 }}>
        <p className="fj-panel-title" style={{ margin: 0 }}>Daily loss limit</p>
        {stats.lowSample && (
          <span className="fj-badge eval" title="Under 10 trades — treat this as a rough estimate">Low sample</span>
        )}
      </div>
      <div className="fj-sub" style={{ marginBottom: 12 }}>
        Stop trading this strategy for the day once you've given back this much — scales with its own edge, not a flat guess.
      </div>

      <div style={{ display: "flex", alignItems: "baseline", gap: 14, flexWrap: "wrap", marginBottom: 12 }}>
        <div className="fj-loss" style={{ fontFamily: "'Inter', sans-serif", fontSize: 30, fontWeight: 700 }}>
          {money(limit)}
        </div>
        <div className="fj-seg-toggle">
          {[1.5, 2, 2.5].map((opt) => (
            <button key={opt} className={`fj-seg-btn ${opt === k ? "active" : ""}`} onClick={() => setK(opt)}>k={opt}</button>
          ))}
        </div>
      </div>

      <div className="fj-sub" style={{ marginBottom: 6 }}>
        {pct(stats.winRate * 100)} win rate · {stats.tradesPerDay.toFixed(2)} trades/day · expectancy {money(stats.expectancy)}/trade (flat 1-contract)
      </div>
      <div className="fj-sub" style={{ marginBottom: 10 }}>
        R-multiple check (2–3x avg loss): {money(-stats.rMultiple.low)}–{money(-stats.rMultiple.high)}
      </div>
      <div className="fj-sub" style={{ fontSize: 11 }}>
        Based on {stats.n} trade{stats.n === 1 ? "" : "s"} over {stats.days} day{stats.days === 1 ? "" : "s"}, flat 1-contract basis — scale this to your live contract size before treating it as a hard stop.
      </div>
    </div>
  );
}

function RiskOfRuinPanel({ trades }) {
  const [buffer, setBuffer] = useState(2000);
  const [numTrades, setNumTrades] = useState(100);
  const stats = useMemo(
    () => computeRiskOfRuin(trades, { buffer: Math.max(Number(buffer) || 0, 1), numTrades: Math.max(Number(numTrades) || 1, 1) }),
    [trades, buffer, numTrades]
  );

  if (!stats) return null;
  const rorPct = stats.ror * 100;
  const severity = rorPct >= 50 ? "fj-loss" : rorPct >= 20 ? "" : "fj-profit";

  return (
    <div className="fj-panel">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, marginBottom: 4 }}>
        <p className="fj-panel-title" style={{ margin: 0 }}>Risk of ruin</p>
        {stats.lowSample && <span className="fj-badge eval" title="Under 10 trades — treat this as a rough estimate">Low sample</span>}
      </div>
      <div className="fj-sub" style={{ marginBottom: 12 }}>
        Probability a buffer gets wiped out over the next stretch of trades — simulated from this strategy's own win/loss distribution, not a symmetric-payoff formula that would misstate the real asymmetry.
      </div>

      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "flex-end", marginBottom: 14 }}>
        <div className="fj-form-field" style={{ width: 140 }}>
          <label>Buffer to protect ($)</label>
          <input type="number" step="100" className="fj-input" value={buffer} onChange={(e) => setBuffer(e.target.value)} />
        </div>
        <div className="fj-form-field" style={{ width: 120 }}>
          <label>Trades ahead</label>
          <input type="number" step="10" className="fj-input" value={numTrades} onChange={(e) => setNumTrades(e.target.value)} />
        </div>
      </div>

      <div className={severity} style={{ fontFamily: "'Inter', sans-serif", fontSize: 30, fontWeight: 700, marginBottom: 10 }}>
        {rorPct.toFixed(1)}%
      </div>

      <div className="fj-sub" style={{ marginBottom: 6 }}>
        Median worst drawdown across simulations: {money(stats.medianTrough)} · Worst-case simulated: {money(stats.worstTrough)}
      </div>
      <div className="fj-sub" style={{ fontSize: 11 }}>
        Based on {stats.n} trade{stats.n === 1 ? "" : "s"}, flat 1-contract basis — the buffer and any live-size conversion are yours to set; this doesn't know your real account balance.
      </div>
    </div>
  );
}

function ConsecutiveLossPanel({ trades }) {
  const [numTrades, setNumTrades] = useState(100);
  const stats = useMemo(
    () => computeStreakProbabilities(trades, { numTrades: Math.max(Number(numTrades) || 1, 1) }),
    [trades, numTrades]
  );

  if (!stats) return null;

  return (
    <div className="fj-panel">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, marginBottom: 4 }}>
        <p className="fj-panel-title" style={{ margin: 0 }}>Consecutive loss streak probability</p>
        {stats.lowSample && <span className="fj-badge eval" title="Under 10 trades — treat this as a rough estimate">Low sample</span>}
      </div>
      <div className="fj-sub" style={{ marginBottom: 12 }}>
        Exact probability of hitting a losing streak of a given length within the next N trades — the direct math behind why martingale sizing gets tested more often than it feels like it should.
      </div>

      <div className="fj-form-field" style={{ width: 120, marginBottom: 14 }}>
        <label>Trades ahead</label>
        <input type="number" step="10" className="fj-input" value={numTrades} onChange={(e) => setNumTrades(e.target.value)} />
      </div>

      <div style={{ overflowX: "auto" }}>
        <table className="fj-table">
          <thead>
            <tr><th>Streak length</th>{Object.keys(stats.probabilities).map((L) => <th key={L}>{L} losses</th>)}</tr>
          </thead>
          <tbody>
            <tr>
              <td style={{ fontFamily: "Inter, sans-serif" }}>Probability</td>
              {Object.entries(stats.probabilities).map(([L, p]) => (
                <td key={L} className={p >= 0.5 ? "fj-loss" : ""}>{(p * 100).toFixed(1)}%</td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>

      <div className="fj-sub" style={{ marginTop: 10, fontSize: 11 }}>
        Based on {stats.n} trade{stats.n === 1 ? "" : "s"} · loss rate {pct(stats.lossRate * 100)} · a streak of length L means L in a row — if you're running a martingale sequence, that's L consecutive size increases.
      </div>
    </div>
  );
}

function ChangeComparisonPanel({ trades, notes }) {
  const sortedNotes = useMemo(
    () => [...notes].sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id)),
    [notes]
  );
  const [selectedId, setSelectedId] = useState(sortedNotes[0]?.id || "");

  if (notes.length === 0) return null;
  const selectedNote = sortedNotes.find((n) => n.id === selectedId) || sortedNotes[0];

  const before = trades.filter((t) => t.date < selectedNote.date);
  const after = trades.filter((t) => t.date >= selectedNote.date);
  const beforeStats = calcStats(before);
  const afterStats = calcStats(after);

  const row = (label, key, fmt) => (
    <tr key={key}>
      <td style={{ fontFamily: "Inter, sans-serif", fontWeight: 600 }}>{label}</td>
      <td>{beforeStats.n ? fmt(beforeStats) : "—"}</td>
      <td>{afterStats.n ? fmt(afterStats) : "—"}</td>
    </tr>
  );

  return (
    <div className="fj-panel">
      <p className="fj-panel-title">Compare pre/post change</p>
      <div className="fj-sub" style={{ marginBottom: 12 }}>
        Splits this strategy's trades at a documented change — trades before that date vs. on/after it.
      </div>

      {sortedNotes.length > 1 ? (
        <div className="fj-form-field" style={{ marginBottom: 14, maxWidth: 340 }}>
          <label>Change to compare around</label>
          <select className="fj-select" value={selectedId} onChange={(e) => setSelectedId(e.target.value)}>
            {sortedNotes.map((n) => <option key={n.id} value={n.id}>{n.date} — {n.title}</option>)}
          </select>
        </div>
      ) : (
        <div className="fj-sub" style={{ marginBottom: 14 }}>
          Comparing around: <b style={{ color: "var(--text)" }}>{selectedNote.date} — {selectedNote.title}</b>
        </div>
      )}

      <div style={{ overflowX: "auto" }}>
        <table className="fj-table">
          <thead>
            <tr><th></th><th>Before ({beforeStats.n} trade{beforeStats.n === 1 ? "" : "s"})</th><th>After ({afterStats.n} trade{afterStats.n === 1 ? "" : "s"})</th></tr>
          </thead>
          <tbody>
            {row("Total P&L", "pnl", (s) => <span className={s.totalPnl >= 0 ? "fj-profit" : "fj-loss"}>{money(s.totalPnl)}</span>)}
            {row("Win rate", "wr", (s) => pct(s.winRate))}
            {row("Avg win", "aw", (s) => <span className="fj-profit">{money(s.avgWin)}</span>)}
            {row("Avg loss", "al", (s) => <span className="fj-loss">{money(-s.avgLoss)}</span>)}
            {row("Profit factor", "pf", (s) => s.profitFactor === null ? "—" : s.profitFactor === Infinity ? "∞" : s.profitFactor.toFixed(2))}
            {row("Expectancy / trade", "exp", (s) => <span className={s.expectancy >= 0 ? "fj-profit" : "fj-loss"}>{money(s.expectancy)}</span>)}
            {row("Max drawdown", "dd", (s) => <span className="fj-loss">{money(-s.maxDD)}</span>)}
            {row("Longest loss streak", "ls", (s) => `${s.maxLossStreak} trade${s.maxLossStreak === 1 ? "" : "s"}`)}
          </tbody>
        </table>
      </div>
      {afterStats.n > 0 && afterStats.n < 10 && (
        <div className="fj-sub" style={{ marginTop: 10, fontSize: 11 }}>
          Only {afterStats.n} trade{afterStats.n === 1 ? "" : "s"} since this change — early to draw conclusions from the "after" side yet.
        </div>
      )}
    </div>
  );
}

function DetailView({ selected, trades, settings, strategies, notes, accounts, onAddNote, onUpdateNote, onDeleteNote, onBack, onNavigate, onEdit, onDelete, onBulkUpdate, onBulkCopy }) {
  const isStrategy = selected.type === "strategy";
  const list = isStrategy ? strategies : Object.keys(settings);
  const idx = list.indexOf(selected.key);
  const [showAddNote, setShowAddNote] = useState(false);
  const [editingNoteId, setEditingNoteId] = useState(null);
  const [tab, setTab] = useState("overview"); // overview | performance | risk | trades | notes

  useEffect(() => { setShowAddNote(false); setEditingNoteId(null); setTab("overview"); }, [selected.type, selected.key]);

  const entityNotes = useMemo(
    () => notes.filter((n) => getNoteLinks(n).some((l) => l.type === selected.type && l.key === selected.key))
      .sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id)),
    [notes, selected.type, selected.key]
  );

  const entityTrades = useMemo(
    () => trades.filter((t) => isStrategy
      ? t.strategy === selected.key
      // A copy keeps its original market, so without this it would show up
      // twice in that market's totals (once as itself, once as the copy).
      : t.market === selected.key && !t._isCopy
    ),
    [trades, isStrategy, selected.key]
  );
  const stats = useMemo(() => calcStats(entityTrades), [entityTrades]);
  const curve = useMemo(() => equityCurve(entityTrades), [entityTrades]);
  const longTrades = useMemo(() => entityTrades.filter((t) => t.direction === "Long"), [entityTrades]);
  const shortTrades = useMemo(() => entityTrades.filter((t) => t.direction === "Short"), [entityTrades]);
  const longStats = useMemo(() => calcStats(longTrades), [longTrades]);
  const shortStats = useMemo(() => calcStats(shortTrades), [shortTrades]);
  const accent = isStrategy ? ACCENT_PALETTE[idx >= 0 ? idx % ACCENT_PALETTE.length : 0] : (settings[selected.key]?.accent || "var(--amber)");
  const grade = useMemo(() => (isStrategy ? computeStrategyGrade(entityTrades, { settings }) : null), [isStrategy, entityTrades, settings]);

  const tabs = [
    ["overview", "Overview"], ["performance", "Performance"],
    ...(isStrategy ? [["risk", "Risk"]] : []),
    ...(isStrategy && entityTrades.some((t) => t.adv) ? [["signals", "Signals"]] : []),
    ["trades", `Trades · ${entityTrades.length}`], ["notes", `Notes · ${entityNotes.length}`],
  ];

  const goPrev = () => { if (list.length === 0) return; onNavigate(selected.type, list[(idx - 1 + list.length) % list.length]); };
  const goNext = () => { if (list.length === 0) return; onNavigate(selected.type, list[(idx + 1) % list.length]); };

  return (
    <div>
      <button className="fj-back-btn" onClick={onBack}><ArrowLeft size={15} /> Back to dashboard</button>

      <div className="fj-dash-grid">
        <div>
          <div className="fj-detail-head" style={{ marginBottom: 0 }}>
            <div>
              <div className="fj-sub" style={{ fontSize: 12.5 }}>{isStrategy ? "Strategy" : "Market"}</div>
              <div className="fj-detail-title" style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span>{selected.key}{!isStrategy && settings[selected.key] && ` · ${settings[selected.key].label}`}</span>
                {grade && <GradeBadge grade={grade} />}
              </div>
              <div className={`fj-hero-value ${stats.n === 0 ? "fj-neutral" : stats.totalPnl >= 0 ? "fj-profit" : "fj-loss"}`}>{stats.n ? money(stats.totalPnl) : "$0.00"}</div>
              <div className="fj-hero-meta" style={{ marginTop: 6 }}>
                Net P&amp;L after fees · {stats.n} trade{stats.n === 1 ? "" : "s"}{stats.n > 0 && ` · peak ${money(Math.max(...curve.map((p) => p.equity)))}`}
              </div>
            </div>
            {list.length > 1 && (
              <div style={{ display: "flex", gap: 6 }}>
                <button className="fj-iconbtn" style={{ border: "1px solid var(--border)", borderRadius: 7 }} onClick={goPrev} aria-label="Previous"><ChevronLeft size={16} /></button>
                <button className="fj-iconbtn" style={{ border: "1px solid var(--border)", borderRadius: 7 }} onClick={goNext} aria-label="Next"><ChevronRight size={16} /></button>
              </div>
            )}
          </div>
          {stats.n > 0 && (
            <div className="fj-hero-chart">
              <EquityChart curve={curve} color={accent} changeNotes={entityNotes} />
            </div>
          )}
        </div>
        <aside className="fj-side"><StatList stats={stats} /></aside>
      </div>

      {stats.n === 0 ? (
        <div className="fj-empty">No trades logged for this {isStrategy ? "strategy" : "market"} yet.</div>
      ) : (
        <>
          <div className="fj-tabbar">
            <div className="fj-pills" role="tablist">
              {tabs.map(([k, label]) => (
                <button key={k} role="tab" aria-selected={tab === k} className={`fj-pill lg ${tab === k ? "active" : ""}`} onClick={() => setTab(k)}>{label}</button>
              ))}
            </div>
          </div>

          {tab === "overview" && (
            <div style={{ paddingTop: 16 }}>
              {isStrategy && grade && <StrategyGradePanel grade={grade} />}
              <div className="fj-two-col" style={{ marginTop: 0 }}>
                <div style={{ gridColumn: "1 / -1" }}>
                  <h3 className="fj-sub-title">Long vs short</h3>
                  <LongShortTable longStats={longStats} shortStats={shortStats} />
                </div>
                <div>
                  <h3 className="fj-sub-title">Daily &amp; weekly P&amp;L</h3>
                  <CalendarHeatmap trades={entityTrades} />
                </div>
                <div>
                  <h3 className="fj-sub-title">Day of week × hour of day</h3>
                  <DowHourHeatmap trades={entityTrades} />
                </div>
              </div>
            </div>
          )}

          {tab === "performance" && (
            <div className="fj-two-col" style={{ marginTop: 16 }}>
              <div style={{ gridColumn: "1 / -1" }}>
                <h3 className="fj-sub-title">Stats by time window</h3>
                <WindowStatsPanel trades={entityTrades} />
              </div>
              <div style={{ gridColumn: "1 / -1" }}>
                <h3 className="fj-sub-title">Every trade, plotted</h3>
                <TradeScatterChart trades={entityTrades} settings={settings} strategies={strategies} />
              </div>
            </div>
          )}

          {tab === "risk" && isStrategy && (
            <div style={{ paddingTop: 16 }}>
              <MartingaleDepthPanel trades={entityTrades} />
              <div className="fj-two-col" style={{ marginTop: 0 }}>
                <DailyLossLimitPanel trades={entityTrades} />
                <RiskOfRuinPanel trades={entityTrades} />
                <div style={{ gridColumn: "1 / -1" }}><ConsecutiveLossPanel trades={entityTrades} /></div>
              </div>
            </div>
          )}

          {tab === "signals" && isStrategy && <SignalAnalysisPanel trades={entityTrades} settings={settings} />}

          {tab === "trades" && (
            <div style={{ paddingTop: 16 }}>
              <TradeLog
                trades={entityTrades}
                notes={entityNotes}
                strategies={strategies} settings={settings} accounts={accounts}
                editingNoteId={editingNoteId} onEditNote={setEditingNoteId}
                onSaveNoteEdit={(patch) => { onUpdateNote(editingNoteId, patch); setEditingNoteId(null); }}
                onCancelNoteEdit={() => setEditingNoteId(null)}
                onDeleteNote={onDeleteNote}
                onEdit={onEdit} onDelete={onDelete}
                onBulkUpdate={onBulkUpdate}
                onBulkCopy={onBulkCopy}
              />
            </div>
          )}

          {tab === "notes" && (
            <div style={{ paddingTop: 16 }}>
              <div className="fj-panel">
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: showAddNote ? 12 : 0 }}>
                  <div>
                    <p className="fj-panel-title" style={{ margin: 0 }}>Notes</p>
                    <div className="fj-sub" style={{ marginTop: 2 }}>{entityNotes.length} logged — also shown in the trade log on the date they happened.</div>
                  </div>
                  <button className="fj-btn" onClick={() => setShowAddNote((v) => !v)}><Plus size={14} /> Add note</button>
                </div>
                {showAddNote && (
                  <div style={{ marginTop: 12 }}>
                    <NoteForm
                      strategies={strategies} settings={settings} accounts={accounts}
                      defaultLinks={[{ type: selected.type, key: selected.key }]}
                      onSave={(note) => { onAddNote(note); setShowAddNote(false); }}
                      onCancel={() => setShowAddNote(false)}
                    />
                  </div>
                )}
              </div>
              <ChangeComparisonPanel trades={entityTrades} notes={entityNotes} />
            </div>
          )}
        </>
      )}
    </div>
  );
}

function TradeScatterChart({ trades, settings, strategies }) {
  const [colorMode, setColorMode] = useState("outcome"); // outcome | market | strategy
  const [highlighted, setHighlighted] = useState(null);

  const selectColorMode = (mode) => { setColorMode(mode); setHighlighted(null); };

  const sorted = [...trades].sort(
    (a, b) => new Date(`${a.date}T${a.time || "00:00"}`) - new Date(`${b.date}T${b.time || "00:00"}`)
  );
  const data = sorted.map((t, idx) => ({
    i: idx + 1,
    x: (idx * 0.6180339887) % 1, // deterministic jitter (golden-ratio spacing) so points don't stack in a single line
    pnl: t.pnl,
    date: t.date,
    market: t.market,
    strategy: t.strategy || "—",
    id: t.id,
  }));

  const groupOf = (point) => {
    if (colorMode === "market") return point.market;
    if (colorMode === "strategy") return point.strategy === "—" ? "No strategy" : point.strategy;
    return point.pnl >= 0 ? "Win" : "Loss";
  };

  const colorFor = (point) => {
    if (colorMode === "market") return settings[point.market]?.accent || "var(--text-dim)";
    if (colorMode === "strategy") {
      if (point.strategy === "—") return "var(--text-dim)";
      const idx = strategies.indexOf(point.strategy);
      return ACCENT_PALETTE[idx >= 0 ? idx % ACCENT_PALETTE.length : 0];
    }
    return point.pnl >= 0 ? "var(--profit)" : "var(--loss)";
  };

  const toggleHighlight = (label) => setHighlighted((h) => h === label ? null : label);

  const legendItems = useMemo(() => {
    if (colorMode === "market") {
      return Object.keys(settings).map((m) => ({ label: m, color: settings[m].accent }));
    }
    if (colorMode === "strategy") {
      const items = strategies.map((s, idx) => ({ label: s, color: ACCENT_PALETTE[idx % ACCENT_PALETTE.length] }));
      if (data.some((d) => d.strategy === "—")) items.push({ label: "No strategy", color: "var(--text-dim)" });
      return items;
    }
    return [
      { label: "Win", color: "var(--profit)" },
      { label: "Loss", color: "var(--loss)" },
    ];
  }, [colorMode, settings, strategies, data]);

  return (
    <div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", marginBottom: 12 }}>
        <span className="fj-sub" style={{ marginRight: 2 }}>Color by:</span>
        {[["outcome", "Win / Loss"], ["market", "Market"], ["strategy", "Strategy"]].map(([key, label]) => (
          <span key={key} className={`fj-chip ${colorMode === key ? "active" : ""}`} onClick={() => selectColorMode(key)}>
            {label}
          </span>
        ))}
        {highlighted && (
          <span className="fj-chip" onClick={() => setHighlighted(null)}>Clear highlight</span>
        )}
      </div>
      <div style={{ maxWidth: 360, margin: "0 auto" }}>
        <ResponsiveContainer width="100%" height={340}>
          <ScatterChart margin={{ top: 8, right: 20, left: -10, bottom: 0 }}>
            <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" horizontal={true} vertical={false} />
            <XAxis type="number" dataKey="x" domain={[-0.15, 1.15]} hide />
            <YAxis type="number" dataKey="pnl" name="P&L" stroke="var(--text-dim)" tick={{ fontSize: 11, fontFamily: "Inter" }} />
            <ReferenceLine y={0} stroke="var(--border-strong)" />
            <Tooltip
              cursor={{ strokeDasharray: "3 3", stroke: "var(--border-strong)" }}
              contentStyle={{ background: "var(--panel-alt)", border: "1px solid var(--border)", borderRadius: 8, fontFamily: "Inter", fontSize: 12 }}
              labelStyle={{ color: "var(--text-bright)", fontWeight: 600, marginBottom: 4 }}
              itemStyle={{ color: "var(--text-bright)" }}
              formatter={(value, name) => {
                if (name === "pnl") return [money(value), "P&L"];
                return [value, name];
              }}
              labelFormatter={(_, payload) => {
                const p = payload && payload[0] && payload[0].payload;
                return p ? `Trade #${p.i} · ${p.date} · ${p.market} · ${p.strategy}` : "";
              }}
            />
            <Scatter data={data} isAnimationActive={false}>
              {data.map((point) => {
                const dimmed = highlighted && groupOf(point) !== highlighted;
                return (
                  <Cell
                    key={point.id}
                    fill={dimmed ? "var(--border-strong)" : colorFor(point)}
                    fillOpacity={dimmed ? 0.25 : 0.9}
                  />
                );
              })}
            </Scatter>
          </ScatterChart>
        </ResponsiveContainer>
      </div>
      <div className="fj-legend-row">
        {legendItems.map((item) => {
          const isActive = highlighted === item.label;
          const isDimmed = highlighted && !isActive;
          return (
            <span
              key={item.label}
              className="fj-legend-item"
              onClick={() => toggleHighlight(item.label)}
              style={{
                cursor: "pointer",
                opacity: isDimmed ? 0.4 : 1,
                fontWeight: isActive ? 700 : 400,
                color: isActive ? "var(--text-bright)" : undefined,
              }}
              title={isActive ? `Showing only ${item.label} — click to clear` : `Click to highlight ${item.label}`}
            >
              <span className="fj-legend-swatch" style={{ background: item.color, boxShadow: isActive ? "0 0 0 2px rgba(231,229,224,0.5)" : "none" }} />
              {item.label}
            </span>
          );
        })}
      </div>
    </div>
  );
}

function DowHourHeatmap({ trades }) {
  const timed = trades.filter((t) => t.time);
  if (timed.length === 0) {
    return <div className="fj-empty">No trades with a logged time yet — add a time when entering trades to unlock this view.</div>;
  }

  const grid = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => ({ pnl: 0, count: 0 })));
  timed.forEach((t) => {
    const dow = dowOf(t.date);
    const hour = Number(t.time.split(":")[0]);
    if (Number.isNaN(hour)) return;
    grid[dow][hour].pnl += t.pnl;
    grid[dow][hour].count += 1;
  });

  const maxAbs = Math.max(1, ...grid.flat().map((c) => Math.abs(c.pnl)));
  const activeHours = Array.from({ length: 24 }, (_, h) => h).filter((h) => grid.some((row) => row[h].count > 0));
  const hours = activeHours.length ? activeHours : Array.from({ length: 24 }, (_, h) => h);

  return (
    <div style={{ overflowX: "auto" }}>
      <div style={{ display: "inline-block" }}>
        <div style={{ display: "flex", gap: 3, marginLeft: 30, marginBottom: 4 }}>
          {hours.map((h) => (
            <div key={h} className="fj-sub" style={{ width: 22, textAlign: "center", fontSize: 9.5, fontFamily: "Inter" }}>{h}</div>
          ))}
        </div>
        {DOW_LABELS.map((label, dow) => (
          <div key={label} style={{ display: "flex", alignItems: "center", gap: 3, marginBottom: 3 }}>
            <div className="fj-sub" style={{ width: 28, fontSize: 11, fontFamily: "Inter" }}>{label}</div>
            {hours.map((h) => {
              const cell = grid[dow][h];
              return (
                <div
                  key={h}
                  title={cell.count ? `${label} ${h}:00 · ${cell.count} trade${cell.count === 1 ? "" : "s"} · ${money(cell.pnl)} · avg ${money(cell.pnl / cell.count)}` : `${label} ${h}:00 · no trades`}
                  style={{
                    width: 22, height: 20, borderRadius: 3,
                    background: heatColor(cell.pnl, maxAbs),
                    border: "1px solid var(--border)",
                  }}
                />
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

function CalendarHeatmap({ trades }) {
  const dates = trades.map((t) => t.date).sort();
  const minDate = new Date(`${dates[0]}T00:00:00`);
  const maxDate = new Date(`${dates[dates.length - 1]}T00:00:00`);

  const start = new Date(minDate);
  start.setDate(start.getDate() - start.getDay()); // back up to Sunday

  const byDay = {};
  trades.forEach((t) => {
    byDay[t.date] = byDay[t.date] || { pnl: 0, count: 0 };
    byDay[t.date].pnl += t.pnl;
    byDay[t.date].count += 1;
  });

  const days = [];
  const cursor = new Date(start);
  while (cursor <= maxDate) {
    const key = cursor.toISOString().slice(0, 10);
    days.push({ key, ...(byDay[key] || { pnl: 0, count: 0 }) });
    cursor.setDate(cursor.getDate() + 1);
  }
  while (days.length % 7 !== 0) {
    const key = new Date(cursor).toISOString().slice(0, 10);
    days.push({ key, pnl: 0, count: 0 });
    cursor.setDate(cursor.getDate() + 1);
  }

  const weeks = [];
  for (let i = 0; i < days.length; i += 7) weeks.push(days.slice(i, i + 7));
  const maxAbs = Math.max(1, ...days.map((d) => Math.abs(d.pnl)));

  return (
    <div style={{ overflowX: "auto" }}>
      <div style={{ display: "flex", gap: 4 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 4, marginRight: 3 }}>
          {DOW_LABELS_SHORT.map((l, i) => (
            <div key={i} className="fj-sub" style={{ width: 18, height: 18, fontSize: 10, display: "flex", alignItems: "center", justifyContent: "center" }}>{l}</div>
          ))}
        </div>
        {weeks.map((week, wi) => (
          <div key={wi} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {week.map((d) => (
              <div
                key={d.key}
                title={d.count ? `${d.key} · ${d.count} trade${d.count === 1 ? "" : "s"} · ${money(d.pnl)}` : `${d.key} · no trades`}
                style={{
                  width: 18, height: 18, borderRadius: 4,
                  background: d.count ? heatColor(d.pnl, maxAbs) : "rgba(139,146,158,0.06)",
                  border: "1px solid var(--border)",
                }}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------- trade form ----------

function TradeForm({ initial, strategies, accounts, settings, onCancel, onSave }) {
  const [date, setDate] = useState(initial?.date || new Date().toISOString().slice(0, 10));
  const [time, setTime] = useState(initial?.time || "");
  const [market, setMarket] = useState(initial?.market || "MES");
  const [strategy, setStrategy] = useState(initial?.strategy || "");
  const [direction, setDirection] = useState(initial?.direction || "Long");
  const [contracts, setContracts] = useState(initial?.contracts ?? 1);
  const [entry, setEntry] = useState(initial?.entry ?? "");
  const [exit, setExit] = useState(initial?.exit ?? "");
  const [fees, setFees] = useState(initial?.fees ?? feeForTrade(settings, "MES", 1));
  // For a brand-new trade the fee follows market x contracts until you type
  // your own number; editing an existing trade never overwrites its fee.
  const [feesTouched, setFeesTouched] = useState(Boolean(initial));
  const [grossPnl, setGrossPnl] = useState(initial ? Number((initial.pnl + (initial.fees || 0)).toFixed(2)) : "");
  const [notes, setNotes] = useState(initial?.notes || "");
  const [tradeAccounts, setTradeAccounts] = useState(initial?.accounts || []);

  const toggleTradeAccount = (name) => {
    setTradeAccounts((prev) => prev.includes(name) ? prev.filter((x) => x !== name) : [...prev, name]);
  };

  useEffect(() => {
    if (!feesTouched) setFees(feeForTrade(settings, market, contracts));
  }, [market, contracts, settings, feesTouched]);

  const calcFromPrices = () => {
    const mult = Number(settings[market]?.multiplier) || 1;
    const dir = direction === "Short" ? -1 : 1;
    const raw = (Number(exit) - Number(entry)) * mult * (Number(contracts) || 1) * dir;
    setGrossPnl(Number.isFinite(raw) ? raw.toFixed(2) : "");
  };

  const canCalc = entry !== "" && exit !== "" && contracts !== "";
  const netPnl = grossPnl === "" || isNaN(Number(grossPnl)) ? null : Number(grossPnl) - (Number(fees) || 0);

  const submit = (e) => {
    e.preventDefault();
    if (grossPnl === "" || isNaN(Number(grossPnl))) return;
    onSave({
      date, time, market, strategy: strategy.trim(), direction,
      contracts: Number(contracts) || 1,
      entry: entry === "" ? null : Number(entry),
      exit: exit === "" ? null : Number(exit),
      fees: Number(fees) || 0,
      pnl: Number((Number(grossPnl) - (Number(fees) || 0)).toFixed(2)),
      notes: notes.trim(),
      accounts: tradeAccounts,
    });
  };

  return (
    <div className="fj-modal-backdrop" onClick={onCancel}>
      <div className="fj-modal" onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <p className="fj-panel-title" style={{ margin: 0 }}>{initial ? "Edit trade" : "Add trade"}</p>
          <button className="fj-iconbtn" onClick={onCancel}><X size={18} /></button>
        </div>
        <form onSubmit={submit}>
          <div className="fj-form-row">
            <div className="fj-form-field">
              <label>Date</label>
              <input type="date" className="fj-input" value={date} onChange={(e) => setDate(e.target.value)} required />
            </div>
            <div className="fj-form-field">
              <label>Time (optional)</label>
              <input type="time" className="fj-input" value={time} onChange={(e) => setTime(e.target.value)} />
            </div>
          </div>

          <div className="fj-form-row">
            <div className="fj-form-field">
              <label>Market</label>
              <select className="fj-select" value={market} onChange={(e) => setMarket(e.target.value)}>
                {Object.keys(settings).map((m) => <option key={m} value={m}>{m} — {settings[m].label}</option>)}
              </select>
            </div>
            <div className="fj-form-field">
              <label>Strategy</label>
              <input
                className="fj-input" list="fj-strategy-list" placeholder="e.g. ORB breakout"
                value={strategy} onChange={(e) => setStrategy(e.target.value)}
              />
              <datalist id="fj-strategy-list">
                {strategies.map((s) => <option key={s} value={s} />)}
              </datalist>
            </div>
          </div>

          <div className="fj-form-field" style={{ marginBottom: 10 }}>
            <label>Direction</label>
            <div className="fj-toggle-group">
              <div className={`fj-toggle ${direction === "Long" ? "active-long" : ""}`} onClick={() => setDirection("Long")}>Long</div>
              <div className={`fj-toggle ${direction === "Short" ? "active-short" : ""}`} onClick={() => setDirection("Short")}>Short</div>
            </div>
          </div>

          <div className="fj-form-field" style={{ marginBottom: 10 }}>
            <label>Accounts (optional — tag every account this trade applies to)</label>
            {accounts.length === 0 ? (
              <div className="fj-sub">No accounts added yet — add one under the Accounts tab.</div>
            ) : (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {accounts.map((a) => {
                  const active = tradeAccounts.includes(a.name);
                  return (
                    <span
                      key={a.id}
                      className="fj-chip"
                      style={active ? { background: "var(--amber)", borderColor: "var(--amber)", color: "var(--on-accent)", fontWeight: 600 } : undefined}
                      onClick={() => toggleTradeAccount(a.name)}
                    >
                      {a.name}
                    </span>
                  );
                })}
              </div>
            )}
          </div>

          <div className="fj-form-row">
            <div className="fj-form-field">
              <label>Contracts</label>
              <input type="number" min="1" step="1" className="fj-input" value={contracts} onChange={(e) => setContracts(e.target.value)} />
            </div>
            <div className="fj-form-field">
              <label>Fees ($) — subtracted from Gross P&amp;L{Number(settings[market]?.feePerContract) > 0 && !feesTouched ? ` · auto from ${market} setting` : ""}</label>
              <input type="number" step="0.01" className="fj-input" value={fees} onChange={(e) => { setFeesTouched(true); setFees(e.target.value); }} />
            </div>
          </div>

          <div className="fj-form-row">
            <div className="fj-form-field">
              <label>Entry price (optional)</label>
              <input type="number" step="0.01" className="fj-input" value={entry} onChange={(e) => setEntry(e.target.value)} placeholder="e.g. 5432.25" />
            </div>
            <div className="fj-form-field">
              <label>Exit price (optional)</label>
              <input type="number" step="0.01" className="fj-input" value={exit} onChange={(e) => setExit(e.target.value)} placeholder="e.g. 5440.50" />
            </div>
          </div>

          <div style={{ marginBottom: 10 }}>
            <button type="button" className="fj-btn" disabled={!canCalc} style={{ opacity: canCalc ? 1 : 0.5 }} onClick={calcFromPrices}>
              Calculate P&amp;L from entry/exit
            </button>
          </div>

          <div className="fj-form-field" style={{ marginBottom: 6 }}>
            <label>Gross P&amp;L ($, before fees) — always directly editable</label>
            <input type="number" step="0.01" className="fj-input" value={grossPnl} onChange={(e) => setGrossPnl(e.target.value)} required placeholder="e.g. 62.50 or -37.50" />
          </div>
          {netPnl !== null && Number(fees) !== 0 && (
            <div className="fj-sub" style={{ marginBottom: 12 }}>
              Net P&amp;L after {money(Number(fees) || 0)} in fees: <b style={{ color: netPnl >= 0 ? "var(--profit)" : "var(--loss)", fontFamily: "Inter, sans-serif" }}>{money(netPnl)}</b> — this is what's saved and used everywhere.
            </div>
          )}
          {(netPnl === null || Number(fees) === 0) && <div style={{ marginBottom: 12 }} />}

          <div className="fj-form-field" style={{ marginBottom: 16 }}>
            <label>Notes (optional)</label>
            <input className="fj-input" style={{ fontFamily: "Inter, sans-serif" }} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Setup, mistakes, market context…" />
          </div>

          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button type="button" className="fj-btn" onClick={onCancel}>Cancel</button>
            <button type="submit" className="fj-btn primary">{initial ? "Save changes" : "Add trade"}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ---------- bulk manual trade entry ----------

function emptyBulkRow(defaults) {
  return {
    _key: uid(),
    date: defaults.date || new Date().toISOString().slice(0, 10),
    time: "",
    market: defaults.market || "MES",
    strategy: defaults.strategy || "",
    direction: "Long",
    contracts: 1,
    entry: "",
    exit: "",
    pnl: "",
    notes: "",
  };
}

function BulkTradeForm({ strategies, accounts, settings, onCancel, onSave }) {
  const today = new Date().toISOString().slice(0, 10);
  const [defaultDate, setDefaultDate] = useState(today);
  const [defaultMarket, setDefaultMarket] = useState("MES");
  const [defaultStrategy, setDefaultStrategy] = useState("");
  const [defaultAccounts, setDefaultAccounts] = useState([]);

  const [rows, setRows] = useState(() => [
    emptyBulkRow({ date: today, market: "MES", strategy: "" }),
    emptyBulkRow({ date: today, market: "MES", strategy: "" }),
    emptyBulkRow({ date: today, market: "MES", strategy: "" }),
  ]);

  const toggleDefaultAccount = (name) =>
    setDefaultAccounts((prev) => (prev.includes(name) ? prev.filter((a) => a !== name) : [...prev, name]));

  const addRow = () => {
    setRows((prev) => [...prev, emptyBulkRow({ date: defaultDate, market: defaultMarket, strategy: defaultStrategy })]);
  };

  const removeRow = (key) => setRows((prev) => (prev.length === 1 ? prev : prev.filter((r) => r._key !== key)));

  const updateRow = (key, field, value) => {
    setRows((prev) => prev.map((r) => (r._key === key ? { ...r, [field]: value } : r)));
  };

  const calcRowPnl = (row) => {
    const mult = Number(settings[row.market]?.multiplier) || 1;
    const dir = row.direction === "Short" ? -1 : 1;
    const raw = (Number(row.exit) - Number(row.entry)) * mult * (Number(row.contracts) || 1) * dir;
    if (!Number.isFinite(raw)) return;
    updateRow(row._key, "pnl", raw.toFixed(2));
  };

  const validRows = useMemo(
    () => rows.filter((r) => r.date && r.market && r.pnl !== "" && !isNaN(Number(r.pnl))),
    [rows]
  );
  const invalidCount = rows.length - validRows.length;

  const submit = () => {
    if (validRows.length === 0) return;
    const toSave = validRows.map((r) => ({
      date: r.date,
      time: r.time || "",
      market: r.market,
      strategy: r.strategy.trim(),
      direction: r.direction,
      contracts: Number(r.contracts) || 1,
      entry: r.entry === "" ? null : Number(r.entry),
      exit: r.exit === "" ? null : Number(r.exit),
      fees: feeForTrade(settings, r.market, r.contracts),
      pnl: Number((Number(r.pnl) - feeForTrade(settings, r.market, r.contracts)).toFixed(2)),
      notes: r.notes.trim(),
      accounts: defaultAccounts,
    }));
    onSave(toSave);
  };

  return (
    <div className="fj-modal-backdrop" onClick={onCancel}>
      <div className="fj-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 980 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <p className="fj-panel-title" style={{ margin: 0 }}>Add multiple trades</p>
          <button className="fj-iconbtn" onClick={onCancel}><X size={18} /></button>
        </div>

        <div className="fj-sub" style={{ marginBottom: 14, lineHeight: 1.6 }}>
          Log several trades in one go — set defaults below to pre-fill new rows, edit anything per row, then save them all at once.{Object.values(settings).some((m) => Number(m.feePerContract) > 0) && " Enter each row's gross P&L — per-contract fees from Contract Settings are subtracted automatically when you save."}
        </div>

        <div className="fj-form-row" style={{ gridTemplateColumns: "1fr 1fr 1fr", marginBottom: 6 }}>
          <div className="fj-form-field">
            <label>Default date (for new rows)</label>
            <input type="date" className="fj-input" value={defaultDate} onChange={(e) => setDefaultDate(e.target.value)} />
          </div>
          <div className="fj-form-field">
            <label>Default market (for new rows)</label>
            <select className="fj-select" value={defaultMarket} onChange={(e) => setDefaultMarket(e.target.value)}>
              {Object.keys(settings).map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>
          <div className="fj-form-field">
            <label>Default strategy (for new rows)</label>
            <input
              list="fj-bulkform-strategy-list" className="fj-input" placeholder="e.g. m1 MNQ NY"
              value={defaultStrategy} onChange={(e) => setDefaultStrategy(e.target.value)}
            />
            <datalist id="fj-bulkform-strategy-list">
              {strategies.map((s) => <option key={s} value={s} />)}
            </datalist>
          </div>
        </div>

        <div className="fj-form-field" style={{ marginBottom: 14 }}>
          <label>Account(s) to tag on every row (optional)</label>
          {accounts.length === 0 ? (
            <div className="fj-sub">No accounts added yet — add one under the Accounts tab.</div>
          ) : (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {accounts.map((a) => {
                const active = defaultAccounts.includes(a.name);
                return (
                  <span
                    key={a.id}
                    className="fj-chip"
                    style={active ? { background: "var(--amber)", borderColor: "var(--amber)", color: "var(--on-accent)", fontWeight: 600 } : undefined}
                    onClick={() => toggleDefaultAccount(a.name)}
                  >
                    {a.name}
                  </span>
                );
              })}
            </div>
          )}
        </div>

        <div style={{ overflowX: "auto", marginBottom: 12 }}>
          <table className="fj-table">
            <thead>
              <tr>
                <th>Date</th><th>Time</th><th>Market</th><th style={{ minWidth: 140 }}>Strategy</th><th>Dir</th><th>Qty</th>
                <th>Entry</th><th>Exit</th><th style={{ minWidth: 90 }}>P&amp;L</th><th style={{ fontFamily: "Inter" }}>Notes</th><th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const canCalc = r.entry !== "" && r.exit !== "" && r.contracts !== "";
                return (
                  <tr key={r._key}>
                    <td><input type="date" className="fj-input" style={{ minWidth: 128 }} value={r.date} onChange={(e) => updateRow(r._key, "date", e.target.value)} /></td>
                    <td><input type="time" className="fj-input" style={{ minWidth: 96 }} value={r.time} onChange={(e) => updateRow(r._key, "time", e.target.value)} /></td>
                    <td>
                      <select className="fj-select" value={r.market} onChange={(e) => updateRow(r._key, "market", e.target.value)}>
                        {Object.keys(settings).map((m) => <option key={m} value={m}>{m}</option>)}
                      </select>
                    </td>
                    <td>
                      <input
                        list="fj-bulkform-strategy-list" className="fj-input" style={{ minWidth: 130 }}
                        value={r.strategy} onChange={(e) => updateRow(r._key, "strategy", e.target.value)}
                      />
                    </td>
                    <td>
                      <select className="fj-select" value={r.direction} onChange={(e) => updateRow(r._key, "direction", e.target.value)}>
                        <option value="Long">Long</option>
                        <option value="Short">Short</option>
                      </select>
                    </td>
                    <td><input type="number" min="1" step="1" className="fj-input" style={{ width: 56 }} value={r.contracts} onChange={(e) => updateRow(r._key, "contracts", e.target.value)} /></td>
                    <td><input type="number" step="0.01" className="fj-input" style={{ width: 84 }} value={r.entry} onChange={(e) => updateRow(r._key, "entry", e.target.value)} /></td>
                    <td><input type="number" step="0.01" className="fj-input" style={{ width: 84 }} value={r.exit} onChange={(e) => updateRow(r._key, "exit", e.target.value)} /></td>
                    <td>
                      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                        <input type="number" step="0.01" className="fj-input" style={{ width: 90 }} value={r.pnl} onChange={(e) => updateRow(r._key, "pnl", e.target.value)} placeholder="e.g. 62.50" />
                        {canCalc && (
                          <button type="button" className="fj-iconbtn" title="Calculate P&L from entry/exit" onClick={() => calcRowPnl(r)}>↻</button>
                        )}
                      </div>
                    </td>
                    <td><input className="fj-input" style={{ fontFamily: "Inter, sans-serif", minWidth: 120 }} value={r.notes} onChange={(e) => updateRow(r._key, "notes", e.target.value)} /></td>
                    <td className="actions">
                      <button type="button" className="fj-iconbtn" onClick={() => removeRow(r._key)} disabled={rows.length === 1}><Trash2 size={14} /></button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
          <button type="button" className="fj-btn" onClick={addRow}><Plus size={14} /> Add row</button>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <span className="fj-sub">
              {validRows.length} of {rows.length} row{rows.length === 1 ? "" : "s"} ready to save
              {invalidCount > 0 ? ` — ${invalidCount} need a date, market, and P&L` : ""}.
            </span>
            <button type="button" className="fj-btn" onClick={onCancel}>Cancel</button>
            <button type="button" className="fj-btn primary" disabled={validRows.length === 0} onClick={submit}>
              Save {validRows.length || ""} trade{validRows.length === 1 ? "" : "s"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
