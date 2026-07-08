import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, BarChart, Bar, ReferenceLine
} from "recharts";
import { Plus, Trash2, Pencil, X, TrendingUp, TrendingDown, RotateCcw, Settings2, ChevronDown, ChevronUp, Upload, Download } from "lucide-react";
import Papa from "papaparse";

// ---------- constants ----------

const MARKET_ORDER = ["MES", "MNQ", "MCL", "MGC"];

const DEFAULT_SETTINGS = {
  MES: { label: "Micro E-mini S&P 500", multiplier: 5, accent: "#6C93AD" },
  MNQ: { label: "Micro E-mini Nasdaq-100", multiplier: 2, accent: "#9385C9" },
  MCL: { label: "Micro WTI Crude Oil", multiplier: 100, accent: "#D9A441" },
  MGC: { label: "Micro Gold", multiplier: 10, accent: "#C7B15A" },
};

const TRADES_KEY = "futures_journal_trades_v1";
const SETTINGS_KEY = "futures_journal_settings_v1";

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

  const [view, setView] = useState("portfolio"); // portfolio | strategy | market | log
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [showSettings, setShowSettings] = useState(false);

  const [filterMarkets, setFilterMarkets] = useState([]); // empty = all
  const [filterStrategies, setFilterStrategies] = useState([]);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [importPreview, setImportPreview] = useState(null); // { parsed, errorCount, total }
  const fileInputRef = useRef(null);

  useEffect(() => {
    (async () => {
      const [t, s] = await Promise.all([
        loadJSON(TRADES_KEY, []),
        loadJSON(SETTINGS_KEY, DEFAULT_SETTINGS),
      ]);
      setTrades(t);
      setSettings({ ...DEFAULT_SETTINGS, ...s });
      setReady(true);
    })();
  }, []);

  useEffect(() => { if (ready) saveJSON(TRADES_KEY, trades); }, [trades, ready]);
  useEffect(() => { if (ready) saveJSON(SETTINGS_KEY, settings); }, [settings, ready]);

  const strategies = useMemo(
    () => Array.from(new Set(trades.map((t) => t.strategy).filter(Boolean))).sort(),
    [trades]
  );

  const filteredTrades = useMemo(() => {
    return trades.filter((t) => {
      if (filterMarkets.length && !filterMarkets.includes(t.market)) return false;
      if (filterStrategies.length && !filterStrategies.includes(t.strategy)) return false;
      if (dateFrom && t.date < dateFrom) return false;
      if (dateTo && t.date > dateTo) return false;
      return true;
    });
  }, [trades, filterMarkets, filterStrategies, dateFrom, dateTo]);

  const portfolioStats = useMemo(() => calcStats(filteredTrades), [filteredTrades]);
  const curve = useMemo(() => equityCurve(filteredTrades), [filteredTrades]);

  const byMarket = useMemo(() => {
    return MARKET_ORDER.map((m) => ({
      key: m,
      ...settings[m],
      stats: calcStats(trades.filter((t) => t.market === m)),
      curve: equityCurve(trades.filter((t) => t.market === m)),
    }));
  }, [trades, settings]);

  const byStrategy = useMemo(() => {
    return strategies.map((s) => ({
      key: s,
      stats: calcStats(trades.filter((t) => t.strategy === s)),
      curve: equityCurve(trades.filter((t) => t.strategy === s)),
    })).sort((a, b) => b.stats.totalPnl - a.stats.totalPnl);
  }, [strategies, trades]);

  const resetFilters = () => {
    setFilterMarkets([]); setFilterStrategies([]); setDateFrom(""); setDateTo("");
  };

  const toggleMarketFilter = (m) => {
    setFilterMarkets((prev) => prev.includes(m) ? prev.filter((x) => x !== m) : [...prev, m]);
  };
  const toggleStrategyFilter = (s) => {
    setFilterStrategies((prev) => prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]);
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
          filterMarkets={filterMarkets}
          filterStrategies={filterStrategies}
          toggleStrategyFilter={toggleStrategyFilter}
          dateFrom={dateFrom} dateTo={dateTo}
          setDateFrom={setDateFrom} setDateTo={setDateTo}
          onReset={resetFilters}
        />
      )}

      {view === "portfolio" && (
        <PortfolioView stats={portfolioStats} curve={curve} byMarket={byMarket} byStrategy={byStrategy} settings={settings} />
      )}
      {view === "strategy" && <GroupCards groups={byStrategy} emptyLabel="No strategies logged yet." />}
      {view === "market" && (
        <GroupCards
          groups={byMarket.map((m) => ({ key: `${m.key} — ${m.label}`, stats: m.stats, curve: m.curve, accent: m.accent }))}
          emptyLabel="No trades logged yet."
        />
      )}
      {view === "calendar" && (
        <CalendarView trades={trades} filterMarkets={filterMarkets} strategies={strategies} />
      )}
      {view === "heatmaps" && (
        <HeatmapsView trades={filteredTrades} settings={settings} />
      )}
      {view === "log" && (
        <TradeLog trades={filteredTrades} onEdit={startEdit} onDelete={handleDelete} />
      )}

      {showForm && (
        <TradeForm
          initial={editingTrade}
          strategies={strategies}
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


function SettingsPanel({ settings, setSettings, onClose }) {
  return (
    <div className="fj-panel">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <p className="fj-panel-title" style={{ margin: 0 }}>Point value per contract ($/point) — used by the P&amp;L calculator</p>
        <button className="fj-iconbtn" onClick={onClose}><X size={16} /></button>
      </div>
      <div className="fj-form-row" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(150px,1fr))" }}>
        {MARKET_ORDER.map((m) => (
          <div key={m} className="fj-form-field">
            <label>{m} — {settings[m].label}</label>
            <input
              type="number" step="0.01" className="fj-input"
              value={settings[m].multiplier}
              onChange={(e) => setSettings((s) => ({ ...s, [m]: { ...s[m], multiplier: e.target.value } }))}
            />
          </div>
        ))}
      </div>
      <div className="fj-sub" style={{ marginTop: 8 }}>
        These only affect the optional entry/exit calculator in the trade form — P&amp;L is always stored as a plain number you can edit directly.
      </div>
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

function FilterBar({ strategies, filterStrategies, toggleStrategyFilter, dateFrom, dateTo, setDateFrom, setDateTo, onReset }) {
  return (
    <div className="fj-filterbar">
      <span className="fj-sub" style={{ marginRight: 2 }}>Strategy:</span>
      {strategies.length === 0 && <span className="fj-sub">none yet</span>}
      {strategies.map((s) => (
        <span key={s} className={`fj-chip ${filterStrategies.includes(s) ? "active" : ""}`} onClick={() => toggleStrategyFilter(s)}>
          {s}
        </span>
      ))}
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

// ---------- portfolio view ----------

function PortfolioView({ stats, curve, byMarket, byStrategy, settings }) {
  const barData = byMarket.map((m) => ({ name: m.key, pnl: m.stats.totalPnl, fill: m.accent }));
  return (
    <div>
      <StatGrid stats={stats} />
      <div className="fj-panel">
        <p className="fj-panel-title">Equity curve</p>
        <EquityChart curve={curve} />
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
        return (
          <div key={g.key} className="fj-strat-card">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div className="fj-strat-name">{g.key}</div>
              <button className="fj-iconbtn" onClick={() => setExpanded(isOpen ? null : g.key)}>
                {isOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
              </button>
            </div>
            <div className="fj-strat-row"><span>Total P&amp;L</span><b className={isProfit ? "fj-profit" : "fj-loss"}>{g.stats.n ? money(g.stats.totalPnl) : "—"}</b></div>
            <div className="fj-strat-row"><span>Trades</span><b>{g.stats.n}</b></div>
            <div className="fj-strat-row"><span>Win rate</span><b>{g.stats.n ? pct(g.stats.winRate) : "—"}</b></div>
            <div className="fj-strat-row"><span>Profit factor</span><b>{g.stats.profitFactor === null ? "—" : g.stats.profitFactor === Infinity ? "∞" : g.stats.profitFactor.toFixed(2)}</b></div>
            <div className="fj-strat-row"><span>Expectancy</span><b className={g.stats.expectancy >= 0 ? "fj-profit" : "fj-loss"}>{g.stats.n ? money(g.stats.expectancy) : "—"}</b></div>
            {isOpen && (
              <div style={{ marginTop: 10 }}>
                <div className="fj-strat-row"><span>Avg win</span><b className="fj-profit">{money(g.stats.avgWin)}</b></div>
                <div className="fj-strat-row"><span>Avg loss</span><b className="fj-loss">{money(-g.stats.avgLoss)}</b></div>
                <div className="fj-strat-row"><span>Largest win</span><b className="fj-profit">{money(g.stats.largestWin)}</b></div>
                <div className="fj-strat-row"><span>Largest loss</span><b className="fj-loss">{money(g.stats.largestLoss)}</b></div>
                <div className="fj-strat-row"><span>Max drawdown</span><b className="fj-loss">{money(-g.stats.maxDD)}</b></div>
                <div style={{ marginTop: 10 }}><EquityChart curve={g.curve} color={g.accent || "#D9A441"} /></div>
              </div>
            )}
          </div>
        );
      })}
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
            <th>Date</th><th>Time</th><th>Market</th><th>Strategy</th><th>Dir</th><th>Qty</th>
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
  const monthMaxAbs = Math.max(1, ...days.map((d) => Math.abs(d.pnl)));

  const goPrev = () => setCursor(new Date(year, month - 1, 1));
  const goNext = () => setCursor(new Date(year, month + 1, 1));
  const goToday = () => setCursor(new Date(today.getFullYear(), today.getMonth(), 1));

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
            <button className="fj-iconbtn" onClick={goPrev}>◀</button>
            <span className="fj-cal-month-label">{MONTH_LABELS[month]} {year}</span>
            <button className="fj-iconbtn" onClick={goNext}>▶</button>
            <button className="fj-btn" style={{ padding: "5px 10px" }} onClick={goToday}>Today</button>
          </div>
          <div style={{ display: "flex", gap: 18 }}>
            <div>
              <div className="fj-stat-label">Month P&amp;L</div>
              <div className={`fj-stat-value ${monthTotal >= 0 ? "fj-profit" : "fj-loss"}`}>{monthCount ? money(monthTotal) : "—"}</div>
            </div>
            <div>
              <div className="fj-stat-label">Trades</div>
              <div className="fj-stat-value">{monthCount}</div>
            </div>
          </div>
        </div>

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
  const rows = MARKET_ORDER.map((m) => {
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

function TradeForm({ initial, strategies, settings, onCancel, onSave }) {
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
                {MARKET_ORDER.map((m) => <option key={m} value={m}>{m} — {settings[m].label}</option>)}
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
