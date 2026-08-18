import React, { useState, useEffect, useMemo, useCallback, useRef, useId } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, BarChart, Bar, ReferenceLine, ScatterChart, Scatter, Cell,
  Area, ComposedChart
} from "recharts";
import { Plus, Trash2, Pencil, X, TrendingUp, TrendingDown, RotateCcw, Settings2, ChevronLeft, ChevronRight, ArrowLeft, Upload, Download } from "lucide-react";
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

const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

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

// ---------- stats ----------

function calcStats(trades) {
  const n = trades.length;
  const base = {
    n, totalPnl: 0, winRate: 0, avgWin: 0, avgLoss: 0,
    profitFactor: null, expectancy: 0, maxDD: 0,
    largestWin: 0, largestLoss: 0, wins: 0, losses: 0, scratches: 0,
    maxWinStreak: 0, maxLossStreak: 0,
  };
  if (n === 0) return base;

  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl < 0);
  const scratches = trades.filter((t) => t.pnl === 0);
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
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
  const points = [{ i: 0, date: sorted[0].date, equity: 0 }];
  sorted.forEach((t, idx) => {
    equity += t.pnl;
    points.push({ i: idx + 1, date: t.date, equity: Number(equity.toFixed(2)) });
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
  const stratEq = {};
  strategyList.forEach((s) => { stratEq[s] = 0; });

  const firstRow = { i: 0, date: sorted[0].date, portfolio: 0 };
  strategyList.forEach((s) => { firstRow[s] = 0; });
  const rows = [firstRow];

  sorted.forEach((t, idx) => {
    portfolioEq += t.pnl;
    if (t.strategy && Object.prototype.hasOwnProperty.call(stratEq, t.strategy)) {
      stratEq[t.strategy] += t.pnl;
    }
    const row = { i: idx + 1, date: t.date, portfolio: Number(portfolioEq.toFixed(2)) };
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
  const taggedTrades = trades.filter((t) => (t.accounts || []).includes(account.name));
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
  const taggedTrades = trades.filter((t) => (t.accounts || []).includes(account.name));
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
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [accounts, setAccounts] = useState([]);

  const [view, setView] = useState("home"); // home | calendar | accounts | log
  const [selectedEntity, setSelectedEntity] = useState(null); // { type: 'strategy'|'market', key } | null
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [showSettings, setShowSettings] = useState(false);

  const [importPreview, setImportPreview] = useState(null); // { parsed, errorCount, total }
  const fileInputRef = useRef(null);
  const [restorePreview, setRestorePreview] = useState(null); // { data, tradeCount, accountCount } | { error }
  const backupFileInputRef = useRef(null);

  useEffect(() => {
    (async () => {
      const [t, s, a] = await Promise.all([
        loadJSON(TRADES_KEY, []),
        loadJSON(SETTINGS_KEY, DEFAULT_SETTINGS),
        loadJSON(ACCOUNTS_KEY, []),
      ]);
      setTrades(t);
      setSettings({ ...DEFAULT_SETTINGS, ...s });
      setAccounts(a);
      setReady(true);
    })();
  }, []);

  useEffect(() => { if (ready) saveJSON(TRADES_KEY, trades); }, [trades, ready]);
  useEffect(() => { if (ready) saveJSON(SETTINGS_KEY, settings); }, [settings, ready]);
  useEffect(() => { if (ready) saveJSON(ACCOUNTS_KEY, accounts); }, [accounts, ready]);

  const strategies = useMemo(
    () => Array.from(new Set(trades.map((t) => t.strategy).filter(Boolean))).sort(),
    [trades]
  );

  const handleSave = (trade) => {
    setTrades((prev) => {
      if (editingId) return prev.map((t) => (t.id === editingId ? { ...trade, id: editingId } : t));
      return [...prev, { ...trade, id: uid() }];
    });
    setShowForm(false);
    setEditingId(null);
  };

  const handleDelete = (id) => setTrades((prev) => prev.filter((t) => t.id !== id));
  const startEdit = (t) => { setEditingId(t.id); setShowForm(true); };

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

  const handleBackup = () => {
    const payload = {
      kind: "position-ledger-backup",
      version: 1,
      exportedAt: new Date().toISOString(),
      trades,
      accounts,
      settings,
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
    setSettings({ ...DEFAULT_SETTINGS, ...(data.settings || {}) });
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
    <div className="fj-root">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700&family=Inter:wght@400;500;600&display=swap');

        .fj-root {
          --bg: #14161B;
          --panel: #1B1E24;
          --panel-alt: #21252D;
          --border: #2B303A;
          --text: #E7E5E0;
          --text-dim: #8B929E;
          --amber: #D9A441;
          --profit: #5FA37A;
          --loss: #C2634A;
          font-family: 'Inter', system-ui, sans-serif;
          background: var(--bg);
          color: var(--text);
          border-radius: 10px;
          padding: 20px;
          min-height: 100%;
        }
        .fj-root * { box-sizing: border-box; }
        .fj-mono { font-family: 'JetBrains Mono', monospace; }
        .fj-display { font-family: 'Space Grotesk', sans-serif; }

        .fj-header { display:flex; justify-content:space-between; align-items:flex-end; margin-bottom:18px; flex-wrap: wrap; gap: 12px; }
        .fj-title { font-family:'Space Grotesk', sans-serif; font-size:22px; font-weight:700; letter-spacing:0.3px; margin:0; }
        .fj-sub { color:var(--text-dim); font-size:12.5px; margin-top:2px; }

        .fj-btn {
          background: var(--panel-alt); color: var(--text); border: 1px solid var(--border);
          border-radius: 7px; padding: 8px 14px; font-size: 13px; font-weight: 500;
          cursor: pointer; display:flex; align-items:center; gap:6px; transition: border-color .15s, background .15s;
          font-family: 'Inter', sans-serif;
        }
        .fj-btn:hover { border-color: var(--amber); }
        .fj-btn:focus-visible { outline: 2px solid var(--amber); outline-offset: 1px; }
        .fj-btn.primary { background: var(--amber); color: #1B1E24; border-color: var(--amber); font-weight:600; }
        .fj-btn.primary:hover { filter: brightness(1.08); }
        .fj-btn.danger:hover { border-color: var(--loss); }

        .fj-ticker { display:grid; grid-template-columns: repeat(auto-fit, minmax(190px,1fr)); gap:10px; margin-bottom:18px; }
        .fj-ticker-card {
          background: var(--panel); border: 1px solid var(--border); border-radius: 9px; padding: 12px 14px;
          cursor: pointer; transition: border-color .15s, transform .1s;
        }
        .fj-ticker-card:hover { transform: translateY(-1px); }
        .fj-ticker-card.active { border-color: var(--dot); }
        .fj-ticker-top { display:flex; justify-content:space-between; align-items:center; }
        .fj-ticker-sym { font-family:'Space Grotesk',sans-serif; font-weight:700; font-size:14px; display:flex; align-items:center; gap:6px;}
        .fj-dot { width:8px; height:8px; border-radius:50%; }
        .fj-ticker-pnl { font-family:'JetBrains Mono',monospace; font-size:15px; font-weight:600; margin-top:6px; }
        .fj-ticker-meta { color: var(--text-dim); font-size:11px; margin-top:3px; }

        .fj-tabs { display:flex; gap:4px; border-bottom:1px solid var(--border); margin-bottom:16px; flex-wrap:wrap; }
        .fj-tab { background:none; border:none; color:var(--text-dim); padding:9px 14px; font-size:13px; font-weight:500;
          cursor:pointer; border-bottom:2px solid transparent; font-family:'Inter',sans-serif; }
        .fj-tab.active { color: var(--text); border-bottom-color: var(--amber); }
        .fj-tab:hover { color: var(--text); }

        .fj-filterbar { display:flex; flex-wrap:wrap; gap:8px; align-items:center; background:var(--panel); border:1px solid var(--border);
          border-radius: 9px; padding: 10px 12px; margin-bottom:18px; }
        .fj-chip { background:var(--panel-alt); border:1px solid var(--border); color:var(--text-dim); border-radius:20px;
          padding:4px 11px; font-size:12px; cursor:pointer; font-family:'JetBrains Mono',monospace; }
        .fj-chip.active { color:#1B1E24; background:var(--amber); border-color:var(--amber); font-weight:600; }
        .fj-date-input { background:var(--panel-alt); border:1px solid var(--border); color:var(--text); border-radius:6px; padding:5px 8px; font-size:12px; font-family:'JetBrains Mono',monospace; }

        .fj-stat-grid { display:grid; grid-template-columns: repeat(auto-fit, minmax(140px,1fr)); gap:10px; margin-bottom:20px; }
        .fj-stat-card { background:var(--panel); border:1px solid var(--border); border-radius:9px; padding:12px 14px; }
        .fj-stat-label { font-size:10.5px; text-transform:uppercase; letter-spacing:0.6px; color:var(--text-dim); }
        .fj-stat-value { font-family:'JetBrains Mono',monospace; font-size:19px; font-weight:600; margin-top:5px; }

        .fj-panel { background:var(--panel); border:1px solid var(--border); border-radius:10px; padding:16px; margin-bottom:18px; }
        .fj-panel-title { font-family:'Space Grotesk',sans-serif; font-weight:600; font-size:14px; margin:0 0 12px 0; }

        table.fj-table { width:100%; border-collapse:collapse; font-size:13px; }
        table.fj-table th { text-align:left; color:var(--text-dim); font-weight:500; font-size:11px; text-transform:uppercase;
          letter-spacing:0.4px; padding:6px 10px; border-bottom:1px solid var(--border); }
        table.fj-table td { padding:8px 10px; border-bottom:1px solid var(--border); font-family:'JetBrains Mono',monospace; }
        table.fj-table tr:hover td { background: var(--panel-alt); }
        table.fj-table td.actions { display:flex; gap:6px; font-family:'Inter',sans-serif; }
        .fj-iconbtn { background:none; border:none; color:var(--text-dim); cursor:pointer; padding:4px; border-radius:5px; }
        .fj-iconbtn:hover { color: var(--text); background: var(--border); }

        .fj-cards-grid { display:grid; grid-template-columns: repeat(auto-fit, minmax(230px,1fr)); gap:12px; }
        .fj-strat-card { background:var(--panel); border:1px solid var(--border); border-radius:10px; padding:14px; }
        .fj-strat-card-clickable { cursor:pointer; transition:border-color .15s, transform .1s; }
        .fj-strat-card-clickable:hover { border-color:var(--amber); transform:translateY(-2px); }
        .fj-strat-pnl-big { font-family:'JetBrains Mono',monospace; font-size:19px; font-weight:700; margin-top:2px; }
        .fj-strat-meta-row { display:flex; gap:12px; margin-top:5px; margin-bottom:8px; font-size:11px; color:var(--text-dim); font-family:'JetBrains Mono',monospace; }
        .fj-section-label { font-family:'Space Grotesk',sans-serif; font-weight:600; font-size:13px; color:var(--text-dim); margin:22px 0 10px; text-transform:uppercase; letter-spacing:0.5px; }

        .fj-back-btn { display:flex; align-items:center; gap:6px; background:none; border:none; color:var(--text-dim); cursor:pointer; font-size:13px; padding:6px 0; margin-bottom:14px; font-family:'Inter',sans-serif; }
        .fj-back-btn:hover { color:var(--text); }
        .fj-detail-head { display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:16px; flex-wrap:wrap; gap:10px; }
        .fj-detail-title { font-family:'Space Grotesk',sans-serif; font-size:22px; font-weight:700; margin-top:2px; }
        .fj-strat-name { font-family:'Space Grotesk',sans-serif; font-weight:600; font-size:14.5px; margin-bottom:8px; }
        .fj-strat-row { display:flex; justify-content:space-between; font-size:12.5px; color:var(--text-dim); padding:2px 0; }
        .fj-strat-row b { color: var(--text); font-family:'JetBrains Mono',monospace; font-weight:500; }

        .fj-cal-nav { display:flex; align-items:center; gap:10px; }
        .fj-cal-month-label { font-family:'Space Grotesk',sans-serif; font-weight:700; font-size:15px; min-width:150px; text-align:center; }
        .fj-cal-grid { display:grid; grid-template-columns: repeat(7, 1fr) 110px; gap:4px; margin-top:10px; }
        .fj-cal-headcell { font-size:10.5px; text-transform:uppercase; letter-spacing:0.5px; color:var(--text-dim); text-align:center; padding-bottom:4px; }
        .fj-cal-cell { background:var(--panel-alt); border:1px solid var(--border); border-radius:7px; padding:6px 7px; min-height:64px; display:flex; flex-direction:column; justify-content:space-between; }
        .fj-cal-cell.pad { opacity:0.35; }
        .fj-cal-daynum { font-family:'JetBrains Mono',monospace; font-size:11px; color:var(--text-dim); }
        .fj-cal-cell-pnl { font-family:'JetBrains Mono',monospace; font-size:12.5px; font-weight:600; align-self:flex-end; }
        .fj-cal-cell-count { font-size:9.5px; color:var(--text-dim); align-self:flex-end; }
        .fj-cal-weektotal { background:var(--panel); border:1px solid var(--border); border-radius:7px; padding:6px 8px; display:flex; flex-direction:column;
          justify-content:center; align-items:flex-end; gap:2px; }
        .fj-cal-weektotal-label { font-size:9.5px; color:var(--text-dim); text-transform:uppercase; letter-spacing:0.4px; }
        .fj-cal-weektotal-val { font-family:'JetBrains Mono',monospace; font-size:13px; font-weight:700; }

        .fj-seg-toggle { display:flex; border:1px solid var(--border); border-radius:7px; overflow:hidden; margin-left:4px; }
        .fj-seg-btn { background:var(--panel-alt); color:var(--text-dim); border:none; padding:6px 12px; font-size:12.5px; cursor:pointer; font-family:'Inter',sans-serif; }
        .fj-seg-btn + .fj-seg-btn { border-left:1px solid var(--border); }
        .fj-seg-btn.active { background:var(--amber); color:#1B1E24; font-weight:600; }

        .fj-year-grid { display:grid; grid-template-columns: repeat(auto-fit, minmax(220px,1fr)); gap:12px; margin-top:14px; }
        .fj-year-month-card { background:var(--panel-alt); border:1px solid var(--border); border-radius:9px; padding:12px; cursor:pointer; transition:border-color .15s, transform .1s; }
        .fj-year-month-card:hover { border-color: var(--amber); transform: translateY(-1px); }
        .fj-year-month-head { display:flex; justify-content:space-between; align-items:baseline; margin-bottom:9px; }
        .fj-year-month-name { font-family:'Space Grotesk',sans-serif; font-weight:700; font-size:13.5px; letter-spacing:0.3px; }
        .fj-year-month-pnl { font-family:'JetBrains Mono',monospace; font-size:12px; font-weight:600; }
        .fj-mini-grid { display:flex; gap:3px; }
        .fj-mini-week { display:flex; flex-direction:column; gap:3px; }
        .fj-mini-day { width:14px; height:14px; border-radius:3px; }

        .fj-acct-grid { display:grid; grid-template-columns: repeat(auto-fit, minmax(280px,1fr)); gap:14px; }
        .fj-acct-card { background:var(--panel); border:1px solid var(--border); border-radius:10px; padding:16px; }
        .fj-acct-head { display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:10px; }
        .fj-acct-name { font-family:'Space Grotesk',sans-serif; font-weight:700; font-size:15px; }
        .fj-badge { font-size:10.5px; text-transform:uppercase; letter-spacing:0.5px; font-weight:700; padding:3px 8px; border-radius:20px; display:inline-block; margin-top:4px; }
        .fj-badge.eval { background:rgba(217,164,65,0.18); color:var(--amber); border:1px solid rgba(217,164,65,0.4); }
        .fj-badge.passed { background:rgba(95,163,122,0.18); color:var(--profit); border:1px solid rgba(95,163,122,0.4); }
        .fj-badge.failed { background:rgba(194,99,74,0.18); color:var(--loss); border:1px solid rgba(194,99,74,0.4); }
        .fj-badge.cash { background:rgba(139,146,158,0.15); color:var(--text-dim); border:1px solid rgba(139,146,158,0.35); }
        .fj-acct-row { display:flex; justify-content:space-between; font-size:12.5px; color:var(--text-dim); padding:3px 0; }
        .fj-acct-row b { color: var(--text); font-family:'JetBrains Mono',monospace; font-weight:500; }
        .fj-acct-updateform { display:flex; gap:6px; align-items:flex-end; margin:12px 0 4px; }
        .fj-acct-history { max-height:140px; overflow-y:auto; margin-top:8px; }
        .fj-acct-history-row { display:flex; justify-content:space-between; align-items:center; font-size:11.5px; font-family:'JetBrains Mono',monospace; padding:4px 2px; border-bottom:1px solid var(--border); color:var(--text-dim); }
        .fj-acct-history-row b { color:var(--text); font-weight:500; }

        .fj-legend-row { display:flex; flex-wrap:wrap; gap:12px; margin-top:12px; }
        .fj-legend-item { display:flex; align-items:center; gap:6px; font-size:11.5px; color:var(--text-dim); font-family:'JetBrains Mono',monospace; }
        .fj-legend-swatch { width:9px; height:9px; border-radius:50%; flex-shrink:0; }

        .fj-empty { color:var(--text-dim); font-size:13px; text-align:center; padding:30px 10px; }



        .fj-modal-backdrop { position:fixed; inset:0; background:rgba(0,0,0,0.55); display:flex; align-items:center;
          justify-content:center; z-index:50; padding:16px; }
        .fj-modal { background:var(--panel); border:1px solid var(--border); border-radius:12px; padding:20px; width:100%;
          max-width:520px; max-height:88vh; overflow-y:auto; }
        .fj-form-row { display:grid; grid-template-columns: 1fr 1fr; gap:10px; margin-bottom:10px; }
        .fj-form-field { display:flex; flex-direction:column; gap:4px; }
        .fj-form-field label { font-size:11px; color:var(--text-dim); text-transform:uppercase; letter-spacing:0.4px; }
        .fj-input, .fj-select {
          background: var(--panel-alt); border:1px solid var(--border); color:var(--text); border-radius:6px;
          padding:8px 9px; font-size:13px; font-family:'JetBrains Mono',monospace;
        }
        .fj-input:focus, .fj-select:focus { outline:2px solid var(--amber); outline-offset:0; border-color:var(--amber); }
        .fj-input::placeholder { color: #545B68; }
        .fj-toggle-group { display:flex; gap:6px; }
        .fj-toggle { flex:1; padding:8px; text-align:center; border-radius:6px; border:1px solid var(--border);
          background:var(--panel-alt); cursor:pointer; font-size:13px; font-weight:500; }
        .fj-toggle.active-long { background: rgba(95,163,122,0.18); border-color:var(--profit); color:var(--profit); }
        .fj-toggle.active-short { background: rgba(194,99,74,0.18); border-color:var(--loss); color:var(--loss); }

        .fj-profit { color: var(--profit); }
        .fj-loss { color: var(--loss); }
        .fj-neutral { color: var(--text-dim); }

        @media (max-width: 520px) {
          .fj-form-row { grid-template-columns: 1fr; }
        }
      `}</style>

      <Header
        onAdd={() => { setEditingId(null); setShowForm(true); }}
        onSettings={() => setShowSettings((s) => !s)}
        onExport={handleExport}
        onImportClick={triggerImport}
        onBackup={handleBackup}
        onRestoreClick={triggerRestore}
      />

      <input
        ref={fileInputRef}
        type="file"
        accept=".csv,text/csv"
        style={{ display: "none" }}
        onChange={handleFileChange}
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
        <SettingsPanel settings={settings} setSettings={setSettings} onClose={() => setShowSettings(false)} />
      )}

      <div className="fj-tabs">
        {[
          ["home", "Dashboard"],
          ["calendar", "Calendar"],
          ["accounts", "Accounts"],
          ["log", "Trade Log"],
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
            onBack={() => setSelectedEntity(null)}
            onNavigate={(type, key) => setSelectedEntity({ type, key })}
            onEdit={startEdit}
            onDelete={handleDelete}
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
        <TradeLogView trades={trades} strategies={strategies} accounts={accounts} settings={settings} onEdit={startEdit} onDelete={handleDelete} />
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
    </div>
  );
}

// ---------- header ----------

function Header({ onAdd, onSettings, onExport, onImportClick, onBackup, onRestoreClick }) {
  return (
    <div className="fj-header">
      <div>
        <h1 className="fj-title">Position Ledger</h1>
        <div className="fj-sub">Futures trade journal — MES · MNQ · MCL · MGC, tracked across strategies</div>
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button className="fj-btn" onClick={onSettings}><Settings2 size={14} /> Contract settings</button>
        <button className="fj-btn" onClick={onImportClick}><Upload size={14} /> Import CSV</button>
        <button className="fj-btn" onClick={onExport}><Download size={14} /> Export CSV</button>
        <button className="fj-btn" onClick={onRestoreClick} title="Restore trades, accounts, and settings from a backup file"><Upload size={14} /> Restore backup</button>
        <button className="fj-btn" onClick={onBackup} title="Download everything — trades, accounts, settings — as one file"><Download size={14} /> Backup all data</button>
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
          Found <b style={{ color: "#E7E5E0" }}>{parsed.length}</b> valid trade{parsed.length === 1 ? "" : "s"} out of {total} row{total === 1 ? "" : "s"}.
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
            You currently have <b style={{ color: "#E7E5E0" }}>{existingCount}</b> trade{existingCount === 1 ? "" : "s"} logged. Choose how to bring these in:
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
              This backup contains <b style={{ color: "#E7E5E0" }}>{preview.tradeCount}</b> trade{preview.tradeCount === 1 ? "" : "s"} and <b style={{ color: "#E7E5E0" }}>{preview.accountCount}</b> account{preview.accountCount === 1 ? "" : "s"}.
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


const ACCENT_PALETTE = ["#6C93AD", "#9385C9", "#D9A441", "#C7B15A", "#7FAE8E", "#B87F9E", "#8AA3C2", "#C0895F"];

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

function SettingsPanel({ settings, setSettings, onClose }) {
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
      [sym]: { label: newLabel.trim() || sym, multiplier: Number(newMultiplier) || 1, accent, category: newCategory },
    }));
    setNewSymbol(""); setNewLabel(""); setNewMultiplier(""); setNewCategory("micro"); setError("");
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
        Point values only affect the optional entry/exit calculator in the trade form — P&amp;L is always stored as a plain number you can edit directly. Micro/Mini controls the toggle on the Portfolio tab. Removing a market keeps any trades already logged under it in your journal, but hides it from the ticker strip and By Market breakdown.
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

// ---------- filter bar ----------

function FilterBar({ settings, strategies, accounts, filterMarkets, filterStrategies, filterAccounts, toggleMarketFilter, toggleStrategyFilter, toggleAccountFilter, dateFrom, dateTo, setDateFrom, setDateTo, onReset }) {
  const markets = Object.keys(settings);
  return (
    <div className="fj-filterbar">
      <span className="fj-sub" style={{ marginRight: 2 }}>Market:</span>
      {markets.map((m) => (
        <span key={m} className={`fj-chip ${filterMarkets.includes(m) ? "active" : ""}`} onClick={() => toggleMarketFilter(m)}>
          {m}
        </span>
      ))}
      <span className="fj-sub" style={{ marginLeft: 10 }}>Strategy:</span>
      {strategies.length === 0 && <span className="fj-sub">none yet</span>}
      {strategies.map((s) => (
        <span key={s} className={`fj-chip ${filterStrategies.includes(s) ? "active" : ""}`} onClick={() => toggleStrategyFilter(s)}>
          {s}
        </span>
      ))}
      {accounts.length > 0 && (
        <>
          <span className="fj-sub" style={{ marginLeft: 10 }}>Account:</span>
          {accounts.map((a) => (
            <span key={a.id} className={`fj-chip ${filterAccounts.includes(a.name) ? "active" : ""}`} onClick={() => toggleAccountFilter(a.name)}>
              {a.name}
            </span>
          ))}
        </>
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

function TradeLogView({ trades, strategies, accounts, settings, onEdit, onDelete }) {
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
      <TradeLog trades={filtered} onEdit={onEdit} onDelete={onDelete} />
    </div>
  );
}

// ---------- stat grid ----------

function StatGrid({ stats }) {
  const items = [
    ["Total P&L", stats.n ? money(stats.totalPnl) : "—", stats.totalPnl >= 0 ? "fj-profit" : "fj-loss"],
    ["Trades", stats.n, ""],
    ["Win rate", stats.n ? pct(stats.winRate) : "—", ""],
    ["Profit factor", stats.profitFactor === null ? "—" : stats.profitFactor === Infinity ? "∞" : stats.profitFactor.toFixed(2), ""],
    ["Avg win", stats.n ? money(stats.avgWin) : "—", "fj-profit"],
    ["Avg loss", stats.n ? money(-stats.avgLoss) : "—", "fj-loss"],
    ["Expectancy / trade", stats.n ? money(stats.expectancy) : "—", stats.expectancy >= 0 ? "fj-profit" : "fj-loss"],
    ["Max drawdown", stats.n ? money(-stats.maxDD) : "—", "fj-loss"],
    ["Longest win streak", stats.n ? `${stats.maxWinStreak} trade${stats.maxWinStreak === 1 ? "" : "s"}` : "—", "fj-profit"],
    ["Longest loss streak", stats.n ? `${stats.maxLossStreak} trade${stats.maxLossStreak === 1 ? "" : "s"}` : "—", "fj-loss"],
  ];
  return (
    <div className="fj-stat-grid">
      {items.map(([label, val, cls]) => (
        <div key={label} className="fj-stat-card">
          <div className="fj-stat-label">{label}</div>
          <div className={`fj-stat-value ${cls}`}>{val}</div>
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
  const colorFor = (dir) => (dir === "up" ? "#5FA37A" : "#C2634A");
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
  const labelFor = (key) => key === "portfolio" ? "Portfolio" : key === "equity" ? "Equity" : key;
  return (
    <div style={{ background: "#21252D", border: "1px solid #2B303A", borderRadius: 8, padding: "8px 10px", fontFamily: "JetBrains Mono", fontSize: 12 }}>
      <div style={{ color: "#E7E5E0", fontWeight: 600, marginBottom: 4 }}>{`Trade #${label}`}</div>
      {real.map((entry) => (
        <div key={entry.dataKey} style={{ color: entry.stroke || "#E7E5E0" }}>
          {`${labelFor(entry.dataKey)}: ${money(entry.value)}`}
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
      <text x={x} y={yBase} fill="#5FA37A" fontSize={10.5} fontFamily="JetBrains Mono" fontWeight={600}>{`High ${money(peak)}`}</text>
      {date && <text x={x} y={yBase + 13} fill="#5FA37A" fontSize={9.5} fontFamily="JetBrains Mono" opacity={0.8}>{date}</text>}
    </g>
  );
}

function EquityChart({ curve, color = "#D9A441" }) {
  const gradId = useId();
  if (curve.length === 0) {
    return <div className="fj-empty">No trades yet — add one to start the equity curve.</div>;
  }
  const peak = Math.max(...curve.map((p) => p.equity));
  const peakPoint = curve.find((p) => p.equity === peak);
  const stops = buildTrendGradientStops(curve, "equity");
  return (
    <ResponsiveContainer width="100%" height={220}>
      <ComposedChart data={curve} margin={{ top: 8, right: 12, left: -10, bottom: 0 }}>
        <defs>
          <linearGradient id={`eqFill-${gradId}`} x1="0" y1="0" x2="1" y2="0">
            {stops.map((s, idx) => <stop key={idx} offset={s.offset} stopColor={s.color} stopOpacity={0.22} />)}
          </linearGradient>
        </defs>
        <CartesianGrid stroke="#2B303A" strokeDasharray="3 3" />
        <XAxis dataKey="i" type="number" stroke="#8B929E" tick={{ fontSize: 11, fontFamily: "JetBrains Mono" }} />
        <YAxis stroke="#8B929E" tick={{ fontSize: 11, fontFamily: "JetBrains Mono" }} />
        <Area
          dataKey={(d) => d.equity} type="monotone" stroke="none"
          fill={`url(#eqFill-${gradId})`} isAnimationActive={false} legendType="none"
        />
        <ReferenceLine y={0} stroke="#3A4150" />
        <ReferenceLine x={peakPoint?.i} stroke="#5FA37A" strokeDasharray="4 3" label={<HighLineLabel peak={peak} date={peakPoint?.date} />} />
        <Tooltip content={<ChartTooltip />} cursor={{ stroke: "#3A4150", strokeDasharray: "3 3" }} />
        <Line type="monotone" dataKey="equity" stroke={color} strokeWidth={2} dot={false} />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

function PortfolioEquityChart({ data, strategies, visible, colorFor }) {
  const gradId = useId();
  if (!data || data.length === 0) {
    return <div className="fj-empty">No trades yet — add one to start the equity curve.</div>;
  }
  const peak = Math.max(...data.map((p) => p.portfolio));
  const peakPoint = data.find((p) => p.portfolio === peak);
  const stops = buildTrendGradientStops(data, "portfolio");
  return (
    <ResponsiveContainer width="100%" height={260}>
      <ComposedChart data={data} margin={{ top: 8, right: 12, left: -10, bottom: 0 }}>
        <defs>
          <linearGradient id={`pfFill-${gradId}`} x1="0" y1="0" x2="1" y2="0">
            {stops.map((s, idx) => <stop key={idx} offset={s.offset} stopColor={s.color} stopOpacity={0.2} />)}
          </linearGradient>
        </defs>
        <CartesianGrid stroke="#2B303A" strokeDasharray="3 3" />
        <XAxis dataKey="i" type="number" stroke="#8B929E" tick={{ fontSize: 11, fontFamily: "JetBrains Mono" }} />
        <YAxis stroke="#8B929E" tick={{ fontSize: 11, fontFamily: "JetBrains Mono" }} />
        <Area
          dataKey={(d) => d.portfolio} type="monotone" stroke="none"
          fill={`url(#pfFill-${gradId})`} isAnimationActive={false} legendType="none"
        />
        <ReferenceLine y={0} stroke="#3A4150" />
        <ReferenceLine x={peakPoint?.i} stroke="#5FA37A" strokeDasharray="4 3" label={<HighLineLabel peak={peak} date={peakPoint?.date} />} />
        <Tooltip content={<ChartTooltip />} cursor={{ stroke: "#3A4150", strokeDasharray: "3 3" }} />
        {strategies.filter((s) => visible.includes(s)).map((s) => (
          <Line key={s} type="monotone" dataKey={s} stroke={colorFor(s)} strokeWidth={1.5} strokeOpacity={0.5} dot={false} isAnimationActive={false} />
        ))}
        <Line type="monotone" dataKey="portfolio" stroke="#D9A441" strokeWidth={2.5} dot={false} isAnimationActive={false} />
      </ComposedChart>
    </ResponsiveContainer>
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

function HomeView({ settings, trades, accounts, strategies, onSelect, onViewAccounts }) {
  const [selectedStrategies, setSelectedStrategies] = useState([]);
  const [category, setCategory] = useState("all"); // all | micro | mini
  const [marketSort, setMarketSort] = useState("pnl");
  const [strategySort, setStrategySort] = useState("pnl");

  const hasMicro = Object.values(settings).some((m) => (m.category || "micro") === "micro");
  const hasMini = Object.values(settings).some((m) => m.category === "mini");

  // Category-only scope — drives the market row and strategy grid, so every
  // strategy/market stays visible to browse and toggle even while filtered.
  const categoryScopedTrades = useMemo(() => {
    if (category === "all") return trades;
    return trades.filter((t) => (settings[t.market]?.category || "micro") === category);
  }, [trades, settings, category]);

  // Category + selected-strategy scope — drives the stat grid and the main
  // equity curve, so picking strategy chips actually narrows the numbers,
  // not just overlays extra lines on top of the unfiltered portfolio.
  const statsScopedTrades = useMemo(() => {
    if (selectedStrategies.length === 0) return categoryScopedTrades;
    return categoryScopedTrades.filter((t) => selectedStrategies.includes(t.strategy));
  }, [categoryScopedTrades, selectedStrategies]);

  const stats = useMemo(() => calcStats(statsScopedTrades), [statsScopedTrades]);
  const multiCurve = useMemo(() => buildMultiEquityCurve(statsScopedTrades, strategies), [statsScopedTrades, strategies]);

  const byMarket = useMemo(() => {
    const list = Object.keys(settings)
      .filter((m) => category === "all" || (settings[m].category || "micro") === category)
      .map((m) => {
        const marketTrades = categoryScopedTrades.filter((t) => t.market === m);
        return { key: m, ...settings[m], stats: calcStats(marketTrades) };
      });
    return sortGroups(list, marketSort);
  }, [settings, categoryScopedTrades, category, marketSort]);

  const byStrategy = useMemo(() => {
    const names = Array.from(new Set(categoryScopedTrades.map((t) => t.strategy).filter(Boolean)));
    const list = names
      .map((s) => ({ key: s, stats: calcStats(categoryScopedTrades.filter((t) => t.strategy === s)), curve: equityCurve(categoryScopedTrades.filter((t) => t.strategy === s)) }));
    return sortGroups(list, strategySort);
  }, [categoryScopedTrades, strategySort]);

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
      {(hasMicro && hasMini) && (
        <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 12 }}>
          <div className="fj-seg-toggle">
            <button className={`fj-seg-btn ${category === "all" ? "active" : ""}`} onClick={() => setCategory("all")}>All contracts</button>
            <button className={`fj-seg-btn ${category === "micro" ? "active" : ""}`} onClick={() => setCategory("micro")}>Micro only</button>
            <button className={`fj-seg-btn ${category === "mini" ? "active" : ""}`} onClick={() => setCategory("mini")}>Mini only</button>
          </div>
        </div>
      )}

      <StatGrid stats={stats} />

      <div className="fj-panel">
        <p className="fj-panel-title">Equity curve</p>
        {strategies.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", marginBottom: 10 }}>
            <span className="fj-sub" style={{ marginRight: 2 }}>Filter by strategy:</span>
            {strategies.map((s) => {
              const active = selectedStrategies.includes(s);
              const c = colorFor(s);
              return (
                <span
                  key={s}
                  className="fj-chip"
                  style={active ? { background: c, borderColor: c, color: "#14161B", fontWeight: 600 } : undefined}
                  onClick={() => toggleStrategy(s)}
                >
                  {s}
                </span>
              );
            })}
            {selectedStrategies.length > 0 && (
              <span className="fj-chip" onClick={() => setSelectedStrategies([])}>Clear</span>
            )}
          </div>
        )}
        <PortfolioEquityChart data={multiCurve} strategies={strategies} visible={selectedStrategies} colorFor={colorFor} />
      </div>

      {acctRollup && (
        <div className="fj-panel" style={{ cursor: "pointer" }} onClick={onViewAccounts}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <p className="fj-panel-title" style={{ margin: 0 }}>Accounts</p>
            <span className="fj-sub">{accounts.length} account{accounts.length === 1 ? "" : "s"} · view all →</span>
          </div>
          <div className="fj-stat-grid" style={{ marginTop: 12, marginBottom: 0 }}>
            <div className="fj-stat-card">
              <div className="fj-stat-label">Total current balance</div>
              <div className="fj-stat-value">{money(acctRollup.currentTotal)}</div>
            </div>
            <div className="fj-stat-card">
              <div className="fj-stat-label">Below floor</div>
              <div className={`fj-stat-value ${acctRollup.breachedCount > 0 ? "fj-loss" : "fj-profit"}`}>{acctRollup.breachedCount}</div>
            </div>
          </div>
        </div>
      )}

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10, marginTop: 22, marginBottom: 10 }}>
        <div className="fj-section-label" style={{ margin: 0 }}>Markets — click to break down</div>
        <SortToggle value={marketSort} onChange={setMarketSort} />
      </div>
      <div className="fj-ticker" style={{ marginBottom: 22 }}>
        {byMarket.map((m) => {
          const isProfit = m.stats.totalPnl >= 0;
          return (
            <div
              key={m.key}
              className="fj-ticker-card"
              style={{ "--dot": m.accent }}
              onClick={() => onSelect("market", m.key)}
            >
              <div className="fj-ticker-top">
                <span className="fj-ticker-sym"><span className="fj-dot" style={{ background: m.accent }} />{m.key}</span>
                {m.stats.n > 0 && (isProfit ? <TrendingUp size={14} color="#5FA37A" /> : <TrendingDown size={14} color="#C2634A" />)}
              </div>
              <div className={`fj-ticker-pnl ${m.stats.n === 0 ? "fj-neutral" : isProfit ? "fj-profit" : "fj-loss"}`}>
                {m.stats.n === 0 ? "—" : money(m.stats.totalPnl)}
              </div>
              <div className="fj-ticker-meta">{m.stats.n} trade{m.stats.n === 1 ? "" : "s"} · {m.stats.n ? pct(m.stats.winRate) + " win" : "no data"}</div>
            </div>
          );
        })}
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10, marginTop: 22, marginBottom: 10 }}>
        <div className="fj-section-label" style={{ margin: 0 }}>Strategies — click to break down</div>
        <SortToggle value={strategySort} onChange={setStrategySort} />
      </div>
      {byStrategy.length === 0 ? (
        <div className="fj-empty">No strategies logged yet.</div>
      ) : (
        <div className="fj-cards-grid">
          {byStrategy.map((s) => {
            const isProfit = s.stats.totalPnl >= 0;
            return (
              <div key={s.key} className="fj-strat-card fj-strat-card-clickable" onClick={() => onSelect("strategy", s.key)}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                  <div className="fj-strat-name">{s.key}</div>
                  {isProfit ? <TrendingUp size={14} color="#5FA37A" /> : <TrendingDown size={14} color="#C2634A" />}
                </div>
                <div className={`fj-strat-pnl-big ${isProfit ? "fj-profit" : "fj-loss"}`}>{money(s.stats.totalPnl)}</div>
                <div className="fj-strat-meta-row">
                  <span>{pct(s.stats.winRate)} win</span>
                  <span>{s.stats.n} trades</span>
                  <span>PF {s.stats.profitFactor === null ? "—" : s.stats.profitFactor === Infinity ? "∞" : s.stats.profitFactor.toFixed(2)}</span>
                </div>
                <ResponsiveContainer width="100%" height={40}>
                  <LineChart data={s.curve} margin={{ top: 6, right: 0, left: 0, bottom: 0 }}>
                    <YAxis hide domain={["dataMin", "dataMax"]} />
                    <Line type="monotone" dataKey="equity" stroke={isProfit ? "#5FA37A" : "#C2634A"} strokeWidth={1.75} dot={false} isAnimationActive={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            );
          })}
        </div>
      )}

      <div className="fj-section-label">Advanced stats</div>
      <div className="fj-panel">
        <WindowStatsPanel trades={statsScopedTrades} />
      </div>
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
        <div style={{ position: "absolute", left: `${pct}%`, top: -4, transform: "translateX(-50%)", width: 2, height: 18, background: "#E7E5E0" }} />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 5, fontSize: 10.5, fontFamily: "JetBrains Mono, monospace" }}>
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
            <Line type="monotone" dataKey="balance" stroke={curveTrendUp ? "#5FA37A" : "#C2634A"} strokeWidth={1.75} dot={false} isAnimationActive={false} />
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

function TradeLog({ trades, onEdit, onDelete }) {
  const sorted = [...trades].sort((a, b) => new Date(`${b.date}T${b.time || "00:00"}`) - new Date(`${a.date}T${a.time || "00:00"}`));
  if (sorted.length === 0) return <div className="fj-empty">No trades match the current filters.</div>;
  return (
    <div className="fj-panel" style={{ overflowX: "auto" }}>
      <table className="fj-table">
        <thead>
          <tr>
            <th>Date</th><th>Time</th><th>Market</th><th>Strategy</th><th>Accounts</th><th>Dir</th><th>Qty</th>
            <th>Entry</th><th>Exit</th><th>P&amp;L</th><th style={{ fontFamily: "Inter" }}>Notes</th><th></th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((t) => (
            <tr key={t.id}>
              <td>{t.date}</td>
              <td>{t.time || "—"}</td>
              <td>{t.market}</td>
              <td style={{ fontFamily: "Inter, sans-serif" }}>{t.strategy || "—"}</td>
              <td style={{ fontFamily: "Inter, sans-serif", color: "#8B929E" }}>{(t.accounts && t.accounts.length) ? t.accounts.join(", ") : "—"}</td>
              <td className={t.direction === "Short" ? "fj-loss" : "fj-profit"}>{t.direction}</td>
              <td>{t.contracts}</td>
              <td>{t.entry || "—"}</td>
              <td>{t.exit || "—"}</td>
              <td className={t.pnl >= 0 ? "fj-profit" : "fj-loss"}>{money(t.pnl)}</td>
              <td style={{ fontFamily: "Inter, sans-serif", color: "#8B929E", maxWidth: 180, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{t.notes || ""}</td>
              <td className="actions">
                <button className="fj-iconbtn" onClick={() => onEdit(t)}><Pencil size={14} /></button>
                <button className="fj-iconbtn" onClick={() => onDelete(t.id)}><Trash2 size={14} /></button>
              </td>
            </tr>
          ))}
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
          <span className="fj-sub">Strategy:</span>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", flex: 1 }}>
            {strategies.map((s) => {
              const active = selectedStrategies.includes(s);
              return (
                <span key={s} className={`fj-chip ${active ? "active" : ""}`} onClick={() => toggleStrategy(s)}>
                  {s}
                </span>
              );
            })}
            {selectedStrategies.length > 0 && (
              <span className="fj-chip" onClick={() => setSelectedStrategies([])}>Clear</span>
            )}
          </div>
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
              <CartesianGrid stroke="#2B303A" strokeDasharray="3 3" />
              <XAxis dataKey="name" stroke="#8B929E" tick={{ fontSize: 10.5, fontFamily: "JetBrains Mono" }} interval={0} angle={rows.length > 8 ? -40 : 0} textAnchor={rows.length > 8 ? "end" : "middle"} height={rows.length > 8 ? 55 : 30} />
              <YAxis stroke="#8B929E" tick={{ fontSize: 11, fontFamily: "JetBrains Mono" }} />
              <ReferenceLine y={0} stroke="#3A4150" />
              <Tooltip
                contentStyle={{ background: "#21252D", border: "1px solid #2B303A", borderRadius: 8, fontFamily: "JetBrains Mono", fontSize: 12 }}
                labelStyle={{ color: "#E7E5E0", fontWeight: 600, marginBottom: 4 }}
                itemStyle={{ color: "#E7E5E0" }}
                cursor={{ fill: "rgba(139,146,158,0.08)" }}
                formatter={(v) => [money(v), "P&L"]}
              />
              <Bar dataKey="pnl" radius={[4, 4, 0, 0]}>
                {barData.map((d, i) => <Cell key={i} fill={d.pnl >= 0 ? "#5FA37A" : "#C2634A"} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>

          <div style={{ overflowX: "auto", marginTop: 12 }}>
            <table className="fj-table">
              <thead>
                <tr>
                  <th>Window</th><th>Trades</th><th>Win %</th><th>P&amp;L</th><th>Avg P&amp;L</th><th>Avg Win</th><th>Avg Loss</th><th>Profit Factor</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.key}>
                    <td>{r.label}</td>
                    <td>{r.stats.n} <span style={{ color: "#8B929E" }}>({r.stats.wins}W/{r.stats.losses}L)</span></td>
                    <td>{pct(r.stats.winRate)}</td>
                    <td className={r.stats.totalPnl >= 0 ? "fj-profit" : "fj-loss"}>{money(r.stats.totalPnl)}</td>
                    <td className={r.stats.expectancy >= 0 ? "fj-profit" : "fj-loss"}>{money(r.stats.expectancy)}</td>
                    <td className="fj-profit">{r.stats.wins ? money(r.stats.avgWin) : "—"}</td>
                    <td className="fj-loss">{r.stats.losses ? money(-r.stats.avgLoss) : "—"}</td>
                    <td>{r.stats.profitFactor === null ? "—" : r.stats.profitFactor === Infinity ? "∞" : r.stats.profitFactor.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

// ---------- detail view (strategy or market drill-down) ----------

function DetailView({ selected, trades, settings, strategies, onBack, onNavigate, onEdit, onDelete }) {
  const isStrategy = selected.type === "strategy";
  const list = isStrategy ? strategies : Object.keys(settings);
  const idx = list.indexOf(selected.key);

  const entityTrades = useMemo(
    () => trades.filter((t) => isStrategy ? t.strategy === selected.key : t.market === selected.key),
    [trades, isStrategy, selected.key]
  );
  const stats = useMemo(() => calcStats(entityTrades), [entityTrades]);
  const curve = useMemo(() => equityCurve(entityTrades), [entityTrades]);
  const accent = isStrategy ? ACCENT_PALETTE[idx >= 0 ? idx % ACCENT_PALETTE.length : 0] : (settings[selected.key]?.accent || "#D9A441");

  const goPrev = () => { if (list.length === 0) return; onNavigate(selected.type, list[(idx - 1 + list.length) % list.length]); };
  const goNext = () => { if (list.length === 0) return; onNavigate(selected.type, list[(idx + 1) % list.length]); };

  return (
    <div>
      <button className="fj-back-btn" onClick={onBack}><ArrowLeft size={15} /> Back to dashboard</button>

      <div className="fj-detail-head">
        <div>
          <div className="fj-sub" style={{ textTransform: "uppercase", letterSpacing: 0.5, fontSize: 11 }}>{isStrategy ? "Strategy" : "Market"}</div>
          <div className="fj-detail-title">{selected.key}{!isStrategy && settings[selected.key] && ` — ${settings[selected.key].label}`}</div>
          <div className="fj-sub" style={{ marginTop: 3 }}>{stats.n} trade{stats.n === 1 ? "" : "s"}</div>
        </div>
        {list.length > 1 && (
          <div style={{ display: "flex", gap: 6 }}>
            <button className="fj-iconbtn" style={{ border: "1px solid var(--border)", borderRadius: 7 }} onClick={goPrev}><ChevronLeft size={16} /></button>
            <button className="fj-iconbtn" style={{ border: "1px solid var(--border)", borderRadius: 7 }} onClick={goNext}><ChevronRight size={16} /></button>
          </div>
        )}
      </div>

      <StatGrid stats={stats} />

      {stats.n === 0 ? (
        <div className="fj-empty">No trades logged for this {isStrategy ? "strategy" : "market"} yet.</div>
      ) : (
        <>
          <div className="fj-panel">
            <p className="fj-panel-title">Equity curve</p>
            <EquityChart curve={curve} color={accent} />
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 14 }}>
            <div className="fj-panel">
              <p className="fj-panel-title">Daily &amp; weekly P&amp;L</p>
              <CalendarHeatmap trades={entityTrades} />
            </div>
            <div className="fj-panel">
              <p className="fj-panel-title">Day of week × hour of day</p>
              <DowHourHeatmap trades={entityTrades} />
            </div>
            <div className="fj-panel">
              <p className="fj-panel-title">Every trade, plotted</p>
              <TradeScatterChart trades={entityTrades} settings={settings} strategies={strategies} />
            </div>
          </div>

          <div className="fj-panel">
            <p className="fj-panel-title">Stats by time window</p>
            <WindowStatsPanel trades={entityTrades} />
          </div>

          <div className="fj-panel">
            <p className="fj-panel-title">Trade log</p>
            <TradeLog trades={entityTrades} onEdit={onEdit} onDelete={onDelete} />
          </div>
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
    if (colorMode === "market") return settings[point.market]?.accent || "#8B929E";
    if (colorMode === "strategy") {
      if (point.strategy === "—") return "#8B929E";
      const idx = strategies.indexOf(point.strategy);
      return ACCENT_PALETTE[idx >= 0 ? idx % ACCENT_PALETTE.length : 0];
    }
    return point.pnl >= 0 ? "#5FA37A" : "#C2634A";
  };

  const toggleHighlight = (label) => setHighlighted((h) => h === label ? null : label);

  const legendItems = useMemo(() => {
    if (colorMode === "market") {
      return Object.keys(settings).map((m) => ({ label: m, color: settings[m].accent }));
    }
    if (colorMode === "strategy") {
      const items = strategies.map((s, idx) => ({ label: s, color: ACCENT_PALETTE[idx % ACCENT_PALETTE.length] }));
      if (data.some((d) => d.strategy === "—")) items.push({ label: "No strategy", color: "#8B929E" });
      return items;
    }
    return [
      { label: "Win", color: "#5FA37A" },
      { label: "Loss", color: "#C2634A" },
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
            <CartesianGrid stroke="#2B303A" strokeDasharray="3 3" horizontal={true} vertical={false} />
            <XAxis type="number" dataKey="x" domain={[-0.15, 1.15]} hide />
            <YAxis type="number" dataKey="pnl" name="P&L" stroke="#8B929E" tick={{ fontSize: 11, fontFamily: "JetBrains Mono" }} />
            <ReferenceLine y={0} stroke="#3A4150" />
            <Tooltip
              cursor={{ strokeDasharray: "3 3", stroke: "#3A4150" }}
              contentStyle={{ background: "#21252D", border: "1px solid #2B303A", borderRadius: 8, fontFamily: "JetBrains Mono", fontSize: 12 }}
              labelStyle={{ color: "#E7E5E0", fontWeight: 600, marginBottom: 4 }}
              itemStyle={{ color: "#E7E5E0" }}
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
                    fill={dimmed ? "#3A4150" : colorFor(point)}
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
                color: isActive ? "#E7E5E0" : undefined,
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
            <div key={h} className="fj-sub" style={{ width: 22, textAlign: "center", fontSize: 9.5, fontFamily: "JetBrains Mono" }}>{h}</div>
          ))}
        </div>
        {DOW_LABELS.map((label, dow) => (
          <div key={label} style={{ display: "flex", alignItems: "center", gap: 3, marginBottom: 3 }}>
            <div className="fj-sub" style={{ width: 28, fontSize: 11, fontFamily: "JetBrains Mono" }}>{label}</div>
            {hours.map((h) => {
              const cell = grid[dow][h];
              return (
                <div
                  key={h}
                  title={cell.count ? `${label} ${h}:00 · ${cell.count} trade${cell.count === 1 ? "" : "s"} · ${money(cell.pnl)} · avg ${money(cell.pnl / cell.count)}` : `${label} ${h}:00 · no trades`}
                  style={{
                    width: 22, height: 20, borderRadius: 3,
                    background: heatColor(cell.pnl, maxAbs),
                    border: "1px solid #2B303A",
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
                  border: "1px solid #2B303A",
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
  const [fees, setFees] = useState(initial?.fees ?? 0);
  const [grossPnl, setGrossPnl] = useState(initial ? Number((initial.pnl + (initial.fees || 0)).toFixed(2)) : "");
  const [notes, setNotes] = useState(initial?.notes || "");
  const [tradeAccounts, setTradeAccounts] = useState(initial?.accounts || []);

  const toggleTradeAccount = (name) => {
    setTradeAccounts((prev) => prev.includes(name) ? prev.filter((x) => x !== name) : [...prev, name]);
  };

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
                      style={active ? { background: "var(--amber)", borderColor: "var(--amber)", color: "#14161B", fontWeight: 600 } : undefined}
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
              <label>Fees (optional, $) — subtracted from Gross P&amp;L</label>
              <input type="number" step="0.01" className="fj-input" value={fees} onChange={(e) => setFees(e.target.value)} />
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
              Net P&amp;L after {money(Number(fees) || 0)} in fees: <b style={{ color: netPnl >= 0 ? "var(--profit)" : "var(--loss)", fontFamily: "JetBrains Mono, monospace" }}>{money(netPnl)}</b> — this is what's saved and used everywhere.
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
