import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, BarChart, Bar, ReferenceLine
} from "recharts";
import { Plus, Trash2, Pencil, X, TrendingUp, TrendingDown, RotateCcw, Settings2, ChevronDown, ChevronUp, Upload, Download } from "lucide-react";
import Papa from "papaparse";

// ---------- constants ----------

const DEFAULT_SETTINGS = {
  MES: { label: "Micro E-mini S&P 500", multiplier: 5, accent: "#6C93AD" },
  MNQ: { label: "Micro E-mini Nasdaq-100", multiplier: 2, accent: "#9385C9" },
  MCL: { label: "Micro WTI Crude Oil", multiplier: 100, accent: "#D9A441" },
  MGC: { label: "Micro Gold", multiplier: 10, accent: "#C7B15A" },
  M2K: { label: "Micro Russell 2000", multiplier: 5, accent: "#7FAE8E" },
};

const TRADES_KEY = "futures_journal_trades_v1";
const SETTINGS_KEY = "futures_journal_settings_v1";
const ACCOUNTS_KEY = "futures_journal_accounts_v1";

const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

const DOW_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DOW_LABELS_SHORT = ["S", "M", "T", "W", "T", "F", "S"];

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
  sorted.forEach((t) => {
    equity += t.pnl;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDD) maxDD = dd;
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

  const currentBalance = timeline.length ? timeline[timeline.length - 1].balance : account.startingBalance;
  const priorDayBalance = timeline.length >= 2 ? timeline[timeline.length - 2].balance : account.startingBalance;
  const peakBalance = Math.max(account.startingBalance, ...timeline.map((t) => t.balance));
  const totalPaidOut = (account.payouts || []).reduce((s, p) => s + p.amount, 0);

  return {
    timeline, currentBalance, priorDayBalance, peakBalance, totalPaidOut,
    tradingPnl: taggedTrades.reduce((s, t) => s + t.pnl, 0),
  };
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

  const [view, setView] = useState("portfolio"); // portfolio | strategy | market | calendar | heatmaps | accounts | log
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [showSettings, setShowSettings] = useState(false);

  const [filterMarkets, setFilterMarkets] = useState([]); // empty = all
  const [filterStrategies, setFilterStrategies] = useState([]);
  const [filterAccounts, setFilterAccounts] = useState([]);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [importPreview, setImportPreview] = useState(null); // { parsed, errorCount, total }
  const fileInputRef = useRef(null);

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

  const filteredTrades = useMemo(() => {
    return trades.filter((t) => {
      if (filterMarkets.length && !filterMarkets.includes(t.market)) return false;
      if (filterStrategies.length && !filterStrategies.includes(t.strategy)) return false;
      if (filterAccounts.length && !(t.accounts || []).some((a) => filterAccounts.includes(a))) return false;
      if (dateFrom && t.date < dateFrom) return false;
      if (dateTo && t.date > dateTo) return false;
      return true;
    });
  }, [trades, filterMarkets, filterStrategies, filterAccounts, dateFrom, dateTo]);

  const portfolioStats = useMemo(() => calcStats(filteredTrades), [filteredTrades]);
  const curve = useMemo(() => equityCurve(filteredTrades), [filteredTrades]);

  const byMarket = useMemo(() => {
    return Object.keys(settings).map((m) => {
      const marketTrades = trades.filter((t) => t.market === m);
      return {
        key: m,
        ...settings[m],
        stats: calcStats(marketTrades),
        curve: equityCurve(marketTrades),
        trades: marketTrades,
      };
    });
  }, [trades, settings]);

  const byStrategy = useMemo(() => {
    return strategies.map((s) => {
      const strategyTrades = trades.filter((t) => t.strategy === s);
      return {
        key: s,
        stats: calcStats(strategyTrades),
        curve: equityCurve(strategyTrades),
        trades: strategyTrades,
      };
    }).sort((a, b) => b.stats.totalPnl - a.stats.totalPnl);
  }, [strategies, trades]);

  const resetFilters = () => {
    setFilterMarkets([]); setFilterStrategies([]); setFilterAccounts([]); setDateFrom(""); setDateTo("");
  };

  const toggleMarketFilter = (m) => {
    setFilterMarkets((prev) => prev.includes(m) ? prev.filter((x) => x !== m) : [...prev, m]);
  };
  const toggleStrategyFilter = (s) => {
    setFilterStrategies((prev) => prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]);
  };
  const toggleAccountFilter = (a) => {
    setFilterAccounts((prev) => prev.includes(a) ? prev.filter((x) => x !== a) : [...prev, a]);
  };

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
    if (mode === "replace") setTrades(importPreview.parsed);
    setImportPreview(null);
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
      />

      <input
        ref={fileInputRef}
        type="file"
        accept=".csv,text/csv"
        style={{ display: "none" }}
        onChange={handleFileChange}
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

      {showSettings && (
        <SettingsPanel settings={settings} setSettings={setSettings} onClose={() => setShowSettings(false)} />
      )}

      <TickerStrip
        byMarket={byMarket}
        activeMarkets={filterMarkets}
        onToggle={toggleMarketFilter}
      />

      <div className="fj-tabs">
        {[
          ["portfolio", "Portfolio"],
          ["strategy", "By Strategy"],
          ["market", "By Market"],
          ["calendar", "Calendar"],
          ["heatmaps", "Heatmaps"],
          ["accounts", "Accounts"],
          ["log", "Trade Log"],
        ].map(([key, label]) => (
          <button key={key} className={`fj-tab ${view === key ? "active" : ""}`} onClick={() => setView(key)}>
            {label}
          </button>
        ))}
      </div>

      {(view === "portfolio" || view === "log" || view === "heatmaps") && (
        <FilterBar
          strategies={strategies}
          accounts={accounts}
          filterMarkets={filterMarkets}
          filterStrategies={filterStrategies}
          filterAccounts={filterAccounts}
          toggleStrategyFilter={toggleStrategyFilter}
          toggleAccountFilter={toggleAccountFilter}
          dateFrom={dateFrom} dateTo={dateTo}
          setDateFrom={setDateFrom} setDateTo={setDateTo}
          onReset={resetFilters}
        />
      )}

      {view === "portfolio" && (
        <PortfolioView stats={portfolioStats} curve={curve} byMarket={byMarket} byStrategy={byStrategy} settings={settings} trades={filteredTrades} strategies={strategies} />
      )}
      {view === "strategy" && <GroupCards groups={byStrategy} emptyLabel="No strategies logged yet." />}
      {view === "market" && (
        <GroupCards
          groups={byMarket.map((m) => ({ key: `${m.key} — ${m.label}`, stats: m.stats, curve: m.curve, accent: m.accent, trades: m.trades }))}
          emptyLabel="No trades logged yet."
        />
      )}
      {view === "calendar" && (
        <CalendarView trades={trades} filterMarkets={filterMarkets} strategies={strategies} />
      )}
      {view === "heatmaps" && (
        <HeatmapsView trades={filteredTrades} settings={settings} />
      )}
      {view === "accounts" && (
        <AccountsView accounts={accounts} setAccounts={setAccounts} trades={trades} />
      )}
      {view === "log" && (
        <TradeLog trades={filteredTrades} onEdit={startEdit} onDelete={handleDelete} />
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

function Header({ onAdd, onSettings, onExport, onImportClick }) {
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
      [sym]: { label: newLabel.trim() || sym, multiplier: Number(newMultiplier) || 1, accent },
    }));
    setNewSymbol(""); setNewLabel(""); setNewMultiplier(""); setError("");
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

      <div className="fj-form-row" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(170px,1fr))" }}>
        {markets.map((m) => (
          <div key={m} className="fj-form-field">
            <label style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span>{m} — {settings[m].label}</span>
              <button
                type="button" className="fj-iconbtn" style={{ padding: 2 }}
                onClick={() => removeMarket(m)} title={`Remove ${m}`}
              >
                <Trash2 size={12} />
              </button>
            </label>
            <input
              type="number" step="0.01" className="fj-input"
              value={settings[m].multiplier}
              onChange={(e) => setSettings((s) => ({ ...s, [m]: { ...s[m], multiplier: e.target.value } }))}
            />
          </div>
        ))}
      </div>

      <div className="fj-sub" style={{ margin: "10px 0" }}>
        These only affect the optional entry/exit calculator in the trade form — P&amp;L is always stored as a plain number you can edit directly. Removing a market keeps any trades already logged under it in your journal, but hides it from the ticker strip and By Market breakdown.
      </div>

      <form onSubmit={addMarket} className="fj-form-row" style={{ gridTemplateColumns: "90px 1fr 110px auto", alignItems: "end", marginBottom: 0 }}>
        <div className="fj-form-field">
          <label>Symbol</label>
          <input className="fj-input" placeholder="M2K" value={newSymbol} onChange={(e) => setNewSymbol(e.target.value)} />
        </div>
        <div className="fj-form-field">
          <label>Name</label>
          <input className="fj-input" style={{ fontFamily: "Inter, sans-serif" }} placeholder="Micro Russell 2000" value={newLabel} onChange={(e) => setNewLabel(e.target.value)} />
        </div>
        <div className="fj-form-field">
          <label>$/point</label>
          <input type="number" step="0.01" className="fj-input" placeholder="5" value={newMultiplier} onChange={(e) => setNewMultiplier(e.target.value)} />
        </div>
        <button type="submit" className="fj-btn primary" style={{ height: 37 }}><Plus size={14} /> Add market</button>
      </form>
      {error && <div className="fj-loss" style={{ fontSize: 12, marginTop: 6 }}>{error}</div>}
    </div>
  );
}

// ---------- ticker strip ----------

function TickerStrip({ byMarket, activeMarkets, onToggle }) {
  return (
    <div className="fj-ticker">
      {byMarket.map((m) => {
        const active = activeMarkets.includes(m.key);
        const isProfit = m.stats.totalPnl >= 0;
        return (
          <div
            key={m.key}
            className={`fj-ticker-card ${active ? "active" : ""}`}
            style={{ "--dot": m.accent, borderColor: active ? m.accent : undefined }}
            onClick={() => onToggle(m.key)}
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
  );
}

// ---------- filter bar ----------

function FilterBar({ strategies, accounts, filterStrategies, filterAccounts, toggleStrategyFilter, toggleAccountFilter, dateFrom, dateTo, setDateFrom, setDateTo, onReset }) {
  return (
    <div className="fj-filterbar">
      <span className="fj-sub" style={{ marginRight: 2 }}>Strategy:</span>
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

// ---------- stat grid ----------

function StatGrid({ stats }) {
  const items = [
    ["Total P&L", money(stats.totalPnl), stats.totalPnl >= 0 ? "fj-profit" : "fj-loss"],
    ["Trades", stats.n, ""],
    ["Win rate", stats.n ? pct(stats.winRate) : "—", ""],
    ["Profit factor", stats.profitFactor === null ? "—" : stats.profitFactor === Infinity ? "∞" : stats.profitFactor.toFixed(2), ""],
    ["Avg win", money(stats.avgWin), "fj-profit"],
    ["Avg loss", money(-stats.avgLoss), "fj-loss"],
    ["Expectancy / trade", money(stats.expectancy), stats.expectancy >= 0 ? "fj-profit" : "fj-loss"],
    ["Max drawdown", money(-stats.maxDD), "fj-loss"],
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

function EquityChart({ curve, color = "#D9A441" }) {
  if (curve.length === 0) {
    return <div className="fj-empty">No trades yet — add one to start the equity curve.</div>;
  }
  return (
    <ResponsiveContainer width="100%" height={220}>
      <LineChart data={curve} margin={{ top: 8, right: 12, left: -10, bottom: 0 }}>
        <CartesianGrid stroke="#2B303A" strokeDasharray="3 3" />
        <XAxis dataKey="i" stroke="#8B929E" tick={{ fontSize: 11, fontFamily: "JetBrains Mono" }} />
        <YAxis stroke="#8B929E" tick={{ fontSize: 11, fontFamily: "JetBrains Mono" }} />
        <ReferenceLine y={0} stroke="#3A4150" />
        <Tooltip
          contentStyle={{ background: "#21252D", border: "1px solid #2B303A", borderRadius: 8, fontFamily: "JetBrains Mono", fontSize: 12 }}
          labelStyle={{ color: "#E7E5E0", fontWeight: 600, marginBottom: 4 }}
          itemStyle={{ color: "#E7E5E0" }}
          formatter={(v) => [money(v), "Equity"]}
          labelFormatter={(i) => `Trade #${i}`}
        />
        <Line type="monotone" dataKey="equity" stroke={color} strokeWidth={2} dot={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}

function PortfolioEquityChart({ data, strategies, visible, colorFor }) {
  if (!data || data.length === 0) {
    return <div className="fj-empty">No trades yet — add one to start the equity curve.</div>;
  }
  return (
    <ResponsiveContainer width="100%" height={260}>
      <LineChart data={data} margin={{ top: 8, right: 12, left: -10, bottom: 0 }}>
        <CartesianGrid stroke="#2B303A" strokeDasharray="3 3" />
        <XAxis dataKey="i" stroke="#8B929E" tick={{ fontSize: 11, fontFamily: "JetBrains Mono" }} />
        <YAxis stroke="#8B929E" tick={{ fontSize: 11, fontFamily: "JetBrains Mono" }} />
        <ReferenceLine y={0} stroke="#3A4150" />
        <Tooltip
          contentStyle={{ background: "#21252D", border: "1px solid #2B303A", borderRadius: 8, fontFamily: "JetBrains Mono", fontSize: 12 }}
          labelStyle={{ color: "#E7E5E0", fontWeight: 600, marginBottom: 4 }}
          itemStyle={{ color: "#E7E5E0" }}
          formatter={(v, name) => [money(v), name === "portfolio" ? "Portfolio" : name]}
          labelFormatter={(i) => `Trade #${i}`}
        />
        {strategies.filter((s) => visible.includes(s)).map((s) => (
          <Line key={s} type="monotone" dataKey={s} stroke={colorFor(s)} strokeWidth={1.5} strokeOpacity={0.5} dot={false} isAnimationActive={false} />
        ))}
        <Line type="monotone" dataKey="portfolio" stroke="#D9A441" strokeWidth={2.5} dot={false} isAnimationActive={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}

// ---------- portfolio view ----------

function PortfolioView({ stats, byMarket, byStrategy, settings, trades, strategies }) {
  const barData = byMarket.map((m) => ({ name: m.key, pnl: m.stats.totalPnl, fill: m.accent }));
  const [visibleStrategies, setVisibleStrategies] = useState([]);
  const multiCurve = useMemo(() => buildMultiEquityCurve(trades, strategies), [trades, strategies]);
  const colorFor = (s) => ACCENT_PALETTE[strategies.indexOf(s) % ACCENT_PALETTE.length];
  const toggleStrategy = (s) => setVisibleStrategies((v) => v.includes(s) ? v.filter((x) => x !== s) : [...v, s]);

  return (
    <div>
      <StatGrid stats={stats} />
      <div className="fj-panel">
        <p className="fj-panel-title">Equity curve</p>
        {strategies.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", marginBottom: 10 }}>
            <span className="fj-sub" style={{ marginRight: 2 }}>Overlay strategies:</span>
            {strategies.map((s) => {
              const active = visibleStrategies.includes(s);
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
            {visibleStrategies.length > 0 && (
              <span className="fj-chip" onClick={() => setVisibleStrategies([])}>Clear</span>
            )}
          </div>
        )}
        <PortfolioEquityChart data={multiCurve} strategies={strategies} visible={visibleStrategies} colorFor={colorFor} />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1.1fr 1fr", gap: 14 }}>
        <div className="fj-panel">
          <p className="fj-panel-title">P&amp;L by market</p>
          {byMarket.every((m) => m.stats.n === 0) ? (
            <div className="fj-empty">No trades yet.</div>
          ) : (
            <ResponsiveContainer width="100%" height={180}>
              <BarChart data={barData} margin={{ top: 4, right: 8, left: -10, bottom: 0 }}>
                <CartesianGrid stroke="#2B303A" strokeDasharray="3 3" />
                <XAxis dataKey="name" stroke="#8B929E" tick={{ fontSize: 11, fontFamily: "JetBrains Mono" }} />
                <YAxis stroke="#8B929E" tick={{ fontSize: 11, fontFamily: "JetBrains Mono" }} />
                <ReferenceLine y={0} stroke="#3A4150" />
                <Tooltip
                  contentStyle={{ background: "#21252D", border: "1px solid #2B303A", borderRadius: 8, fontFamily: "JetBrains Mono", fontSize: 12 }}
                  labelStyle={{ color: "#E7E5E0", fontWeight: 600, marginBottom: 4 }}
                  itemStyle={{ color: "#E7E5E0" }}
                  cursor={{ fill: "rgba(139,146,158,0.08)" }}
                  formatter={(v) => [money(v), "P&L"]}
                />
                <Bar dataKey="pnl" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
        <div className="fj-panel">
          <p className="fj-panel-title">Top strategies</p>
          {byStrategy.length === 0 ? (
            <div className="fj-empty">No strategies logged yet.</div>
          ) : (
            <table className="fj-table">
              <thead><tr><th>Strategy</th><th>P&amp;L</th><th>Win %</th><th>Trades</th></tr></thead>
              <tbody>
                {byStrategy.slice(0, 6).map((s) => (
                  <tr key={s.key}>
                    <td style={{ fontFamily: "Inter, sans-serif" }}>{s.key}</td>
                    <td className={s.stats.totalPnl >= 0 ? "fj-profit" : "fj-loss"}>{money(s.stats.totalPnl)}</td>
                    <td>{pct(s.stats.winRate)}</td>
                    <td>{s.stats.n}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------- group cards (strategy / market) ----------

function GroupCards({ groups, emptyLabel }) {
  const [expanded, setExpanded] = useState(null);
  if (groups.length === 0) return <div className="fj-empty">{emptyLabel}</div>;
  return (
    <div className="fj-cards-grid">
      {groups.map((g) => {
        const isOpen = expanded === g.key;
        const isProfit = g.stats.totalPnl >= 0;
        const hasTrades = g.stats.n > 0;
        return (
          <div key={g.key} className="fj-strat-card">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div className="fj-strat-name">{g.key}</div>
              <button className="fj-iconbtn" onClick={() => setExpanded(isOpen ? null : g.key)} title="More stats">
                {isOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
              </button>
            </div>
            <div className="fj-strat-row"><span>Total P&amp;L</span><b className={isProfit ? "fj-profit" : "fj-loss"}>{hasTrades ? money(g.stats.totalPnl) : "—"}</b></div>
            <div className="fj-strat-row"><span>Trades</span><b>{g.stats.n}</b></div>
            <div className="fj-strat-row"><span>Win rate</span><b>{hasTrades ? pct(g.stats.winRate) : "—"}</b></div>
            <div className="fj-strat-row"><span>Profit factor</span><b>{g.stats.profitFactor === null ? "—" : g.stats.profitFactor === Infinity ? "∞" : g.stats.profitFactor.toFixed(2)}</b></div>
            <div className="fj-strat-row"><span>Expectancy</span><b className={g.stats.expectancy >= 0 ? "fj-profit" : "fj-loss"}>{hasTrades ? money(g.stats.expectancy) : "—"}</b></div>

            {isOpen && (
              <div style={{ marginTop: 10 }}>
                <div className="fj-strat-row"><span>Avg win</span><b className="fj-profit">{money(g.stats.avgWin)}</b></div>
                <div className="fj-strat-row"><span>Avg loss</span><b className="fj-loss">{money(-g.stats.avgLoss)}</b></div>
                <div className="fj-strat-row"><span>Largest win</span><b className="fj-profit">{money(g.stats.largestWin)}</b></div>
                <div className="fj-strat-row"><span>Largest loss</span><b className="fj-loss">{money(g.stats.largestLoss)}</b></div>
                <div className="fj-strat-row"><span>Max drawdown</span><b className="fj-loss">{money(-g.stats.maxDD)}</b></div>
              </div>
            )}

            {hasTrades ? (
              <>
                <div style={{ marginTop: 12 }}>
                  <EquityChart curve={g.curve} color={g.accent || "#D9A441"} />
                </div>
                <div style={{ marginTop: 10 }}>
                  <div className="fj-stat-label" style={{ marginBottom: 6 }}>Daily &amp; weekly P&amp;L</div>
                  <CalendarHeatmap trades={g.trades} />
                </div>
              </>
            ) : (
              <div className="fj-empty" style={{ padding: "16px 0" }}>No trades yet.</div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ---------- accounts ----------

function AccountsView({ accounts, setAccounts, trades }) {
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
    };
    setAccounts((prev) => [...prev, account]);
    setNewName(""); setNewStarting(""); setNewMinimum(""); setNewDrawdownAmount(""); setNewProfitTarget("");
    setNewDrawdownType("eod"); setNewTrailingLock("target"); setNewStatus("Evaluation"); setNewIsCash(false);
    setPreset("custom"); setError(""); setShowAdd(false);
  };

  const removeAccount = (id) => setAccounts((prev) => prev.filter((a) => a.id !== id));

  const updateAccount = (id, patch) => {
    setAccounts((prev) => prev.map((a) => a.id === id ? { ...a, ...patch } : a));
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

  return (
    <div>
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

          <div className="fj-form-field" style={{ marginBottom: 12 }}>
            <label>Flat minimum balance ($, optional — only if this isn't a trailing/EOD account)</label>
            <input type="number" step="0.01" className="fj-input" placeholder="e.g. a personal risk floor for a cash account" value={newMinimum} onChange={(e) => setNewMinimum(e.target.value)} />
          </div>

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

function AccountCard({ account, trades, onRemove, onUpdate, onAddPayout, onRemovePayout }) {
  const [payoutDate, setPayoutDate] = useState(new Date().toISOString().slice(0, 10));
  const [payoutAmount, setPayoutAmount] = useState("");

  const timelineData = buildAccountBalanceTimeline(account, trades);
  const { currentBalance, peakBalance, tradingPnl } = timelineData;
  const { floor, locked, mode } = computeAccountFloor(account, timelineData);
  const payouts = account.payouts || [];
  const totalPaidOut = payouts.reduce((s, p) => s + p.amount, 0);
  const distanceToFloor = currentBalance - floor;
  const profitTarget = Number(account.profitTarget) || 0;
  const isEvalWithTarget = account.status === "Evaluation" && profitTarget > 0;

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

  const badgeClass = account.isCash ? "cash" : account.status === "Passed" ? "passed" : account.status === "Failed" ? "failed" : "eval";
  const badgeLabel = account.isCash ? "Cash Account" : account.status === "Passed" ? "Passed / Funded" : account.status;
  const hasFloor = (Number(account.drawdownAmount) || 0) > 0 || (account.minimum || 0) > 0;

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
          <button className="fj-iconbtn" onClick={onRemove} title="Remove account"><Trash2 size={14} /></button>
        </div>
      </div>

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

      <div className="fj-acct-row" style={{ marginTop: hasFloor ? 12 : 0 }}><span>Current balance</span><b>{money(currentBalance)}</b></div>
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
    </div>
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

function CalendarView({ trades, filterMarkets, strategies }) {
  const today = new Date();
  const [cursor, setCursor] = useState(new Date(today.getFullYear(), today.getMonth(), 1));
  const [selectedStrategy, setSelectedStrategy] = useState("ALL");
  const [mode, setMode] = useState("month"); // "month" | "year"

  const marketFiltered = useMemo(
    () => trades.filter((t) => filterMarkets.length === 0 || filterMarkets.includes(t.market)),
    [trades, filterMarkets]
  );
  const scoped = useMemo(
    () => selectedStrategy === "ALL" ? marketFiltered : marketFiltered.filter((t) => t.strategy === selectedStrategy),
    [marketFiltered, selectedStrategy]
  );

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
            <span className={`fj-chip ${selectedStrategy === "ALL" ? "active" : ""}`} onClick={() => setSelectedStrategy("ALL")}>
              All strategies combined
            </span>
            {strategies.map((s) => (
              <span key={s} className={`fj-chip ${selectedStrategy === s ? "active" : ""}`} onClick={() => setSelectedStrategy(s)}>
                {s}
              </span>
            ))}
          </div>
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

function HeatmapsView({ trades, settings }) {
  if (trades.length === 0) {
    return <div className="fj-empty">No trades match the current filters — log a few trades to see the heatmaps.</div>;
  }
  return (
    <div>
      <div className="fj-panel">
        <p className="fj-panel-title">Trade sequence by market</p>
        <div className="fj-sub" style={{ marginBottom: 12 }}>
          Each square is one trade, in chronological order. Color intensity scales with P&amp;L size relative to the biggest trade in view — hover a square for details.
        </div>
        <TradeSequenceHeatmap trades={trades} settings={settings} />
      </div>

      <div className="fj-panel">
        <p className="fj-panel-title">Day of week × hour of day</p>
        <div className="fj-sub" style={{ marginBottom: 12 }}>
          Total P&amp;L for trades entered at each hour/day combination. Requires a trade time — trades logged without one are excluded from this view.
        </div>
        <DowHourHeatmap trades={trades} />
      </div>

      <div className="fj-panel">
        <p className="fj-panel-title">Daily P&amp;L calendar</p>
        <div className="fj-sub" style={{ marginBottom: 12 }}>
          One square per calendar day. Darker means a bigger day, green for net winning days, red for net losing days.
        </div>
        <CalendarHeatmap trades={trades} />
      </div>
    </div>
  );
}

function TradeSequenceHeatmap({ trades, settings }) {
  const maxAbs = Math.max(1, ...trades.map((t) => Math.abs(t.pnl)));
  const rows = Object.keys(settings).map((m) => {
    const marketTrades = trades
      .filter((t) => t.market === m)
      .sort((a, b) => new Date(`${a.date}T${a.time || "00:00"}`) - new Date(`${b.date}T${b.time || "00:00"}`));
    return { market: m, accent: settings[m].accent, trades: marketTrades };
  }).filter((r) => r.trades.length > 0);

  if (rows.length === 0) return <div className="fj-empty">No trades yet.</div>;

  return (
    <div style={{ overflowX: "auto" }}>
      {rows.map((r) => (
        <div key={r.market} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
          <div style={{ width: 46, flexShrink: 0, fontFamily: "Space Grotesk, sans-serif", fontWeight: 700, fontSize: 12.5, display: "flex", alignItems: "center", gap: 5 }}>
            <span className="fj-dot" style={{ background: r.accent, display: "inline-block", width: 7, height: 7, borderRadius: "50%" }} />
            {r.market}
          </div>
          <div style={{ display: "flex", gap: 3, flexWrap: "wrap" }}>
            {r.trades.map((t) => (
              <div
                key={t.id}
                title={`${t.date}${t.time ? " " + t.time : ""} · ${t.strategy || "no strategy"} · ${money(t.pnl)}`}
                style={{
                  width: 15, height: 15, borderRadius: 3,
                  background: heatColor(t.pnl, maxAbs),
                  border: "1px solid #2B303A",
                  cursor: "default",
                }}
              />
            ))}
          </div>
        </div>
      ))}
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
      <div style={{ display: "flex", gap: 3 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 3, marginRight: 2 }}>
          {DOW_LABELS_SHORT.map((l, i) => (
            <div key={i} className="fj-sub" style={{ width: 14, height: 14, fontSize: 9, textAlign: "center" }}>{l}</div>
          ))}
        </div>
        {weeks.map((week, wi) => (
          <div key={wi} style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            {week.map((d) => (
              <div
                key={d.key}
                title={d.count ? `${d.key} · ${d.count} trade${d.count === 1 ? "" : "s"} · ${money(d.pnl)}` : `${d.key} · no trades`}
                style={{
                  width: 14, height: 14, borderRadius: 3,
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
  const [pnl, setPnl] = useState(initial?.pnl ?? "");
  const [notes, setNotes] = useState(initial?.notes || "");
  const [tradeAccounts, setTradeAccounts] = useState(initial?.accounts || []);

  const toggleTradeAccount = (name) => {
    setTradeAccounts((prev) => prev.includes(name) ? prev.filter((x) => x !== name) : [...prev, name]);
  };

  const calcFromPrices = () => {
    const mult = Number(settings[market]?.multiplier) || 1;
    const dir = direction === "Short" ? -1 : 1;
    const raw = (Number(exit) - Number(entry)) * mult * (Number(contracts) || 1) * dir - (Number(fees) || 0);
    setPnl(Number.isFinite(raw) ? raw.toFixed(2) : "");
  };

  const canCalc = entry !== "" && exit !== "" && contracts !== "";

  const submit = (e) => {
    e.preventDefault();
    if (pnl === "" || isNaN(Number(pnl))) return;
    onSave({
      date, time, market, strategy: strategy.trim(), direction,
      contracts: Number(contracts) || 1,
      entry: entry === "" ? null : Number(entry),
      exit: exit === "" ? null : Number(exit),
      fees: Number(fees) || 0,
      pnl: Number(pnl),
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
              <label>Fees (optional, $)</label>
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

          <div className="fj-form-field" style={{ marginBottom: 12 }}>
            <label>P&amp;L ($) — always directly editable</label>
            <input type="number" step="0.01" className="fj-input" value={pnl} onChange={(e) => setPnl(e.target.value)} required placeholder="e.g. 62.50 or -37.50" />
          </div>

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
