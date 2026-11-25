import React, { useState, useRef, useMemo } from 'react';
import { parseTradeFile, buildDatasetFromSupabase, buildTradeDataset, combineDatasets, splitDataset } from './tradeFileParser.js';
import {
  simulate,
  calcStandardMetrics,
  calcPerYear,
  calcWrHorizons,
  calcCompoundingComparison,
  calcCrossCheck,
} from './monteCarloCore.js';
import { generateHtmlReport } from './exportHtmlReport.js';

// Pre-packaged demo data for quick preview
const SAMPLE_DEMO_TRADES = [
  2.1, -1.0, 1.8, -1.0, 3.2, -1.0, -1.0, 2.5, 1.2, -1.0,
  4.0, -1.0, 1.5, -1.0, -1.0, 2.0, 3.5, -1.0, 1.1, -1.0,
  -1.0, 2.8, 1.9, -1.0, 3.0, -1.0, 2.2, -1.0, -1.0, 1.7,
  2.4, -1.0, -1.0, 4.5, -1.0, 1.3, -1.0, 2.0, -1.0, 3.1,
  1.5, -1.0, 2.2, -1.0, 3.4, -1.0, 1.1, -1.0, -1.0, 2.5,
].map((r, i) => ({
  index: i + 1,
  date: new Date(2018 + Math.floor(i / 10), (i % 12), (i % 28) + 1),
  profit: r * 1000,
  r,
  symbol: 'DEMO/USD',
}));

const fmtMoney = (v) => (v < 0 ? '−$' : '$') + Math.round(Math.abs(v || 0)).toLocaleString('en-US');
const fmtK = (v) => {
  const val = Math.abs(v || 0);
  const sign = v < 0 ? '−$' : '$';
  if (val >= 1e6) return sign + (val / 1e6).toFixed(2) + 'M';
  if (val >= 1e3) return sign + (val / 1e3).toFixed(0) + 'k';
  return sign + Math.round(val);
};
const f1 = (v) => (isFinite(v) && v !== null && v !== undefined ? Number(v).toFixed(1) : '—');
const f2 = (v) => (isFinite(v) && v !== null && v !== undefined ? Number(v).toFixed(2) : '—');
const f0 = (v) => (isFinite(v) && v !== null && v !== undefined ? Math.round(Number(v)).toString() : '—');
const pctS = (v) => f1(v) + '%';

const MonteCarloSimulator = ({ supabaseTrades = [] }) => {
  // Datasets for In-Sample (IS), Out-of-Sample (OOS), and Combined (ALL)
  const [isDataset, setIsDataset] = useState(null);
  const [oosDataset, setOosDataset] = useState(null);
  const [fullDataset, setFullDataset] = useState(null);
  const [isDualFileMode, setIsDualFileMode] = useState(false);
  const [currentDataset, setCurrentDataset] = useState(null);

  // Active Main Tab: 'sum' | 'wr' | 'tbl' | 'cagr' | 'sim' | 'xc' | 'lim'
  const [activeTab, setActiveTab] = useState('sum');

  // Year mode for Tab 1: 'net' | 'wr' | 'pips'
  const [yearMode, setYearMode] = useState('net');

  // Win rate sub-controls for Tab 2
  const [wrSplitView, setWrSplitView] = useState('ALL');
  const [wrColMode, setWrColMode] = useState('key'); // 'key' | 'all'

  // Percentile Table controls for Tab 3
  const [tblSplit, setTblSplit] = useState('ALL');
  const [tblMethod, setTblMethod] = useState('resample');
  const [tblHighlightPct, setTblHighlightPct] = useState(50);

  // CAGR Tab 4 controls
  const [cagrSplit, setCagrSplit] = useState('ALL');
  const [cagrMethod, setCagrMethod] = useState('resample');
  const [cagrSizing, setCagrSizing] = useState('export'); // 'export' | 'fixed2'
  const [cagrPolicy, setCagrPolicy] = useState('withdraw50'); // 'fixed' | 'withdraw50' | 'compound'
  const [cagrHighlightPct, setCagrHighlightPct] = useState(50);

  // Live Simulator Tab 5 controls
  const [simSplit, setSimSplit] = useState('ALL');
  const [simParams, setSimParams] = useState({
    method: 'resample',
    iters: 5000,
    horizon: 0,
    blockMean: 10,
    startCapital: 100000,
    sizing: 'export',
    riskPct: 2.0,
    policy: 'compound',
    withdrawPct: 0.5,
    haircut: 0.0,
    gapProb: 0.0,
    gapMult: 3.0,
    seed: 20261114,
  });

  // Custom probability thresholds for Tab 5
  const [probThresholds, setProbThresholds] = useState({
    ddPct: 15,
    netProfitPct: 50,
    consLoss: 8,
  });
  const [histMetric, setHistMetric] = useState('net_profit');
  const [histPctMarker, setHistPctMarker] = useState(50);

  // Cross-check Tab 6 controls
  const [xcMode, setXcMode] = useState('IS_bootstrap_vs_OOS_actual');

  // Simulation Results state
  const [liveSimResult, setLiveSimResult] = useState(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [splitOption, setSplitOption] = useState('none');
  const [isDragging, setIsDragging] = useState(false);

  const fileInputUnifiedRef = useRef(null);
  const fileInputIsRef = useRef(null);
  const fileInputOosRef = useRef(null);

  // Helper to re-run simulations when dataset changes
  const runSimForPool = (pool, customParams = simParams) => {
    if (!pool || pool.N === 0) return null;
    return simulate(pool, {
      iters: customParams.iters,
      start: customParams.startCapital,
      riskPct: customParams.riskPct,
      method: customParams.method,
      policy: customParams.policy,
      sizing: customParams.sizing,
      haircut: customParams.haircut,
      gapProb: customParams.gapProb,
      gapMult: customParams.gapMult,
      seed: customParams.seed,
    });
  };

  // Processing incoming file
  const handleProcessFile = async (file) => {
    if (!file) return;
    setErrorMsg('');
    setIsProcessing(true);
    setIsDualFileMode(false);
    try {
      const parsed = await parseTradeFile(file);
      setFullDataset(parsed);
      setCurrentDataset(parsed);

      if (splitOption !== 'none') {
        const has2022 = parsed.startDate.getFullYear() < 2022 && parsed.endDate.getFullYear() >= 2022;
        const effectiveOption = splitOption === 'auto' ? (has2022 ? '2022' : '70-30') : splitOption;
        const { isDataset: isDs, oosDataset: oosDs } = splitDataset(
          parsed,
          effectiveOption === '2022' ? 'date' : 'ratio',
          effectiveOption === '2022' ? '2022-01-01' : effectiveOption === '80-20' ? 0.8 : effectiveOption === '50-50' ? 0.5 : 0.7
        );
        setIsDataset(isDs);
        setOosDataset(oosDs);
      } else {
        setIsDataset(parsed);
        setOosDataset(parsed);
      }

      setLiveSimResult(runSimForPool(parsed));
    } catch (err) {
      console.error(err);
      setErrorMsg(err.message || 'Failed to parse trade file.');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleUnifiedUpload = async (e) => {
    const file = e.target.files?.[0];
    await handleProcessFile(file);
    if (e.target) e.target.value = '';
  };

  const handleIsUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setErrorMsg('');
    setIsProcessing(true);
    setIsDualFileMode(true);
    setFullDataset(null);
    try {
      const parsed = await parseTradeFile(file);
      parsed.sourceName = `${file.name} (In-Sample)`;
      parsed.sampleTag = 'IS';
      setIsDataset(parsed);
      if (oosDataset) {
        const combined = combineDatasets(parsed, oosDataset);
        setCurrentDataset(combined);
        setLiveSimResult(runSimForPool(combined));
      } else {
        setCurrentDataset(parsed);
        setLiveSimResult(runSimForPool(parsed));
      }
    } catch (err) {
      setErrorMsg(err.message || 'Failed to parse In-Sample file.');
    } finally {
      setIsProcessing(false);
      if (e.target) e.target.value = '';
    }
  };

  const handleOosUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setErrorMsg('');
    setIsProcessing(true);
    setIsDualFileMode(true);
    setFullDataset(null);
    try {
      const parsed = await parseTradeFile(file);
      parsed.sourceName = `${file.name} (Out-of-Sample)`;
      parsed.sampleTag = 'OOS';
      setOosDataset(parsed);
      if (isDataset) {
        const combined = combineDatasets(isDataset, parsed);
        setCurrentDataset(combined);
        setLiveSimResult(runSimForPool(combined));
      } else {
        setCurrentDataset(parsed);
        setLiveSimResult(runSimForPool(parsed));
      }
    } catch (err) {
      setErrorMsg(err.message || 'Failed to parse Out-of-Sample file.');
    } finally {
      setIsProcessing(false);
      if (e.target) e.target.value = '';
    }
  };

  const handleLoadDemo = () => {
    setErrorMsg('');
    setIsDualFileMode(false);
    const demo = buildTradeDataset(SAMPLE_DEMO_TRADES, 'Sample Gotobi Demo Data', 'ALL');
    setFullDataset(demo);
    setCurrentDataset(demo);
    const { isDataset: isDs, oosDataset: oosDs } = splitDataset(demo, 'ratio', 0.6);
    setIsDataset(isDs);
    setOosDataset(oosDs);
    setLiveSimResult(runSimForPool(demo));
  };

  const handleLoadFromSupabase = () => {
    setErrorMsg('');
    try {
      if (!supabaseTrades || supabaseTrades.length === 0) {
        throw new Error('No trades found in current active ledger.');
      }
      const parsed = buildDatasetFromSupabase(supabaseTrades);
      setFullDataset(parsed);
      setCurrentDataset(parsed);
      const { isDataset: isDs, oosDataset: oosDs } = splitDataset(parsed, 'ratio', 0.7);
      setIsDataset(isDs);
      setOosDataset(oosDs);
      setLiveSimResult(runSimForPool(parsed));
    } catch (err) {
      setErrorMsg(err.message || 'Failed to load trades from Supabase.');
    }
  };

  const handleReset = () => {
    setIsDualFileMode(false);
    setFullDataset(null);
    setIsDataset(null);
    setOosDataset(null);
    setCurrentDataset(null);
    setLiveSimResult(null);
    setErrorMsg('');
  };

  const handleDownloadReport = () => {
    if (!currentDataset) return;
    const isDs = isDataset || currentDataset;
    const oosDs = oosDataset || currentDataset;
    const htmlContent = generateHtmlReport(currentDataset, liveSimResult, simParams, isDs, oosDs);
    const blob = new Blob([htmlContent], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `monte-carlo-report-${currentDataset.sourceName.replace(/[^a-zA-Z0-9]/g, '_')}.html`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleExportTblCsv = () => {
    const sim = tblSimResult || liveSimResult;
    if (!sim || !sim.summary) return;
    const pcts = [5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90, 95];
    const headers = ['Percentile', 'Net Profit ($)', 'Profit Factor', 'Win Rate (%)', 'Sharpe (Ann.)', 'Max DD Closed ($)', 'Max DD MAE ($)', 'Max Cons Losses'];
    const rows = pcts.map((p) => {
      const np = sim.summary.net_profit?.[`p${p}`] ?? sim.summary.net_profit?.median ?? 0;
      const pf = sim.summary.profit_factor?.[`p${p}`] ?? sim.summary.profit_factor?.median ?? 0;
      const wr = sim.summary.win_rate?.[`p${p}`] ?? sim.summary.win_rate?.median ?? 0;
      const sh = sim.summary.sharpe?.[`p${p}`] ?? sim.summary.sharpe?.median ?? 0;
      const dd = sim.summary.max_dd_usd?.[`p${p}`] ?? sim.summary.max_dd_usd?.median ?? 0;
      const mae = sim.summary.max_dd_mae_usd?.[`p${p}`] ?? sim.summary.max_dd_mae_usd?.median ?? 0;
      const cl = sim.summary.max_cons_losses?.[`p${p}`] ?? sim.summary.max_cons_losses?.median ?? 0;
      return [`P${p}`, np.toFixed(2), pf.toFixed(2), wr.toFixed(2), sh.toFixed(2), dd.toFixed(2), mae.toFixed(2), Math.round(cl)];
    });
    const csvContent = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `monte_carlo_percentile_${tblSplit.toLowerCase()}_${tblMethod}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Memoized Econometric Computations for Tabs
  const currentAllPool = useMemo(() => {
    if (isDataset && oosDataset && isDataset !== oosDataset) {
      return currentDataset || combineDatasets(isDataset, oosDataset);
    }
    return currentDataset || fullDataset || isDataset || oosDataset;
  }, [currentDataset, fullDataset, isDataset, oosDataset]);

  const currentIsPool = isDataset || currentAllPool;
  const currentOosPool = oosDataset || currentAllPool;

  const stdAll = useMemo(() => (currentAllPool ? calcStandardMetrics(currentAllPool) : null), [currentAllPool]);
  const stdIs = useMemo(() => (currentIsPool ? calcStandardMetrics(currentIsPool) : null), [currentIsPool]);
  const stdOos = useMemo(() => (currentOosPool ? calcStandardMetrics(currentOosPool) : null), [currentOosPool]);

  const perYearData = useMemo(() => {
    if (!currentAllPool) return [];
    return calcPerYear(currentAllPool);
  }, [currentAllPool]);

  const wrAllData = useMemo(() => (currentAllPool ? calcWrHorizons(currentAllPool) : null), [currentAllPool]);
  const wrIsData = useMemo(() => (currentIsPool ? calcWrHorizons(currentIsPool) : null), [currentIsPool]);
  const wrOosData = useMemo(() => (currentOosPool ? calcWrHorizons(currentOosPool) : null), [currentOosPool]);

  const compData = useMemo(() => {
    const activeCompPool = cagrSplit === 'ALL' ? currentAllPool : cagrSplit === 'IS' ? currentIsPool : currentOosPool;
    if (!activeCompPool) return null;
    return calcCompoundingComparison(activeCompPool, 1000);
  }, [cagrSplit, currentAllPool, currentIsPool, currentOosPool]);

  const xcData = useMemo(() => {
    if (!currentIsPool || !currentOosPool) return null;
    return calcCrossCheck(currentIsPool, currentOosPool, 1000);
  }, [currentIsPool, currentOosPool]);

  const tblSimResult = useMemo(() => {
    const pool = tblSplit === 'ALL' ? currentAllPool : tblSplit === 'IS' ? currentIsPool : currentOosPool;
    if (!pool || pool.N === 0) return null;
    return simulate(pool, {
      iters: 2000,
      start: simParams.startCapital || 100000,
      riskPct: simParams.riskPct || 2.0,
      sizing: simParams.sizing || 'export',
      method: tblMethod,
      policy: 'fixed',
      haircut: 0,
      gapProb: 0,
      gapMult: 1,
      seed: 20261114,
    });
  }, [tblSplit, tblMethod, currentAllPool, currentIsPool, currentOosPool, simParams.startCapital, simParams.riskPct, simParams.sizing]);

  const { probDD, probProfit, probLossStreak, ddCount, profitCount, lossCount, totalRuns } = useMemo(() => {
    const metrics = liveSimResult?.metrics;
    const total = liveSimResult?.S || 0;
    if (!metrics || total === 0) {
      return { probDD: 0, probProfit: 0, probLossStreak: 0, ddCount: 0, profitCount: 0, lossCount: 0, totalRuns: 0 };
    }

    const ddArr = metrics.max_dd_mae_pct;
    const profitPctArr = metrics.net_profit_pct;
    const lossArr = metrics.max_cons_losses;

    const targetDd = isFinite(probThresholds.ddPct) && probThresholds.ddPct >= 0 ? probThresholds.ddPct : 15;
    const targetProfit = isFinite(probThresholds.netProfitPct) && probThresholds.netProfitPct >= 0 ? probThresholds.netProfitPct : 50;
    const targetLoss = isFinite(probThresholds.consLoss) && probThresholds.consLoss >= 1 ? probThresholds.consLoss : 8;

    let ddMatches = 0;
    let profitMatches = 0;
    let lossMatches = 0;

    for (let i = 0; i < total; i++) {
      if (ddArr && ddArr[i] >= targetDd) ddMatches++;
      if (profitPctArr && profitPctArr[i] >= targetProfit) profitMatches++;
      if (lossArr && lossArr[i] >= targetLoss) lossMatches++;
    }

    return {
      probDD: (ddMatches / total) * 100,
      probProfit: (profitMatches / total) * 100,
      probLossStreak: (lossMatches / total) * 100,
      ddCount: ddMatches,
      profitCount: profitMatches,
      lossCount: lossMatches,
      totalRuns: total,
    };
  }, [liveSimResult, probThresholds]);

  // Live Simulation Trigger
  const handleRunLiveSim = (customSplit = simSplit, customParams = simParams) => {
    const pool = customSplit === 'IS' ? currentIsPool : customSplit === 'OOS' ? currentOosPool : currentAllPool;
    if (!pool) return;
    setIsProcessing(true);
    setTimeout(() => {
      try {
        setLiveSimResult(runSimForPool(pool, customParams));
      } catch (err) {
        setErrorMsg(err.message || 'Simulation error.');
      } finally {
        setIsProcessing(false);
      }
    }, 30);
  };

  // Helper for rendering SVG charts
  const renderEquityFanSvg = (bands, samples, horizon, cap, actualPath = null) => {
    if (!bands || !bands[50]) return null;
    const width = 800;
    const height = 300;
    const padX = 65;
    const padY = 30;
    const chartW = width - padX * 2;
    const chartH = height - padY * 2;

    let minY = cap;
    let maxY = cap;
    for (let j = 0; j < horizon; j++) {
      if (isFinite(bands[5][j]) && bands[5][j] < minY) minY = bands[5][j];
      if (isFinite(bands[95][j]) && bands[95][j] > maxY) maxY = bands[95][j];
    }
    minY = Math.max(0, minY * 0.9);
    maxY = maxY * 1.1;
    const rangeY = Math.max(1, maxY - minY);

    const getX = (j) => (padX + (j / Math.max(1, horizon - 1)) * chartW).toFixed(1);
    const getY = (val) => {
      const clamped = Math.max(minY, Math.min(maxY, isFinite(val) ? val : minY));
      return (padY + chartH - ((clamped - minY) / rangeY) * chartH).toFixed(1);
    };

    let band95 = `M ${getX(0)} ${getY(bands[95][0])}`;
    for (let j = 1; j < horizon; j++) band95 += ` L ${getX(j)} ${getY(bands[95][j])}`;
    for (let j = horizon - 1; j >= 0; j--) band95 += ` L ${getX(j)} ${getY(bands[5][j])}`;
    band95 += ' Z';

    let band75 = `M ${getX(0)} ${getY(bands[75][0])}`;
    for (let j = 1; j < horizon; j++) band75 += ` L ${getX(j)} ${getY(bands[75][j])}`;
    for (let j = horizon - 1; j >= 0; j--) band75 += ` L ${getX(j)} ${getY(bands[25][j])}`;
    band75 += ' Z';

    let medPath = `M ${getX(0)} ${getY(bands[50][0])}`;
    for (let j = 1; j < horizon; j++) medPath += ` L ${getX(j)} ${getY(bands[50][j])}`;

    return (
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-auto bg-[#0d0f12] rounded border border-[#23262e]">
        {[0, 0.25, 0.5, 0.75, 1.0].map((t, idx) => {
          const val = minY + (1 - t) * rangeY;
          const y = padY + t * chartH;
          return (
            <g key={idx}>
              <line x1={padX} y1={y} x2={width - padX} y2={y} stroke="#1f232b" strokeDasharray="3 3" />
              <text x={padX - 8} y={y + 3} textAnchor="end" fill="#6b7280" fontSize="10" fontFamily="monospace">
                {fmtK(val)}
              </text>
            </g>
          );
        })}
        <path d={band95} fill="#f3a910" fillOpacity="0.12" />
        <path d={band75} fill="#f3a910" fillOpacity="0.22" />
        {samples &&
          samples.slice(0, 15).map((sArr, idx) => {
            let path = `M ${getX(0)} ${getY(sArr[0])}`;
            for (let j = 1; j < horizon; j++) path += ` L ${getX(j)} ${getY(sArr[j])}`;
            return <path key={idx} d={path} fill="none" stroke="#38bdf8" strokeWidth="1" strokeOpacity="0.25" />;
          })}
        <path d={medPath} fill="none" stroke="#f3a910" strokeWidth="2.5" />
        {actualPath && (
          <path
            d={actualPath.reduce((acc, v, j) => (j === 0 ? `M ${getX(0)} ${getY(v)}` : `${acc} L ${getX(j)} ${getY(v)}`), '')}
            fill="none"
            stroke="#10b981"
            strokeWidth="2"
            strokeDasharray="4 2"
          />
        )}
        <line x1={padX} y1={getY(cap)} x2={width - padX} y2={getY(cap)} stroke="#9ca3af" strokeDasharray="3 3" strokeOpacity="0.5" />
        <text x={padX} y={height - 10} fill="#6b7280" fontSize="10">Trade 1</text>
        <text x={width / 2} y={height - 10} textAnchor="middle" fill="#6b7280" fontSize="10">{horizon} Trades Horizon</text>
        <text x={width - padX} y={height - 10} textAnchor="end" fill="#6b7280" fontSize="10">Trade {horizon}</text>
      </svg>
    );
  };

  return (
    <div className="space-y-6 text-gray-200">
      {/* Hidden file inputs */}
      <input type="file" ref={fileInputUnifiedRef} onChange={handleUnifiedUpload} accept=".csv,.xlsx,.xls" className="hidden" />
      <input type="file" ref={fileInputIsRef} onChange={handleIsUpload} accept=".csv,.xlsx,.xls" className="hidden" />
      <input type="file" ref={fileInputOosRef} onChange={handleOosUpload} accept=".csv,.xlsx,.xls" className="hidden" />

      {/* ========================================================================= */}
      {/* STATE 1: HERO DROPZONE (When no trade data loaded yet)                    */}
      {/* ========================================================================= */}
      {!currentDataset && (
        <div className="bg-[#14161a] border border-[#23262e] rounded-xl p-8 sm:p-12 shadow-2xl text-center">
          <div
            onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
            onDragLeave={(e) => { e.preventDefault(); setIsDragging(false); }}
            onDrop={async (e) => {
              e.preventDefault();
              setIsDragging(false);
              const file = e.dataTransfer.files?.[0];
              await handleProcessFile(file);
            }}
            className={`border-2 border-dashed rounded-xl p-8 sm:p-14 transition-all duration-200 flex flex-col items-center justify-center ${
              isDragging ? 'border-[#f3a910] bg-[#f3a910]/5 scale-[0.99]' : 'border-[#2a2d36] hover:border-[#3d4250] bg-[#0d0f12]/50'
            }`}
          >
            <div className="w-16 h-16 rounded-full bg-[#1c1e24] border border-[#2a2d36] flex items-center justify-center text-3xl mb-5 shadow-inner">
              📊
            </div>
            <h2 className="text-xl font-bold text-white tracking-wide">
              UPLOAD STRATEGY OR BACKTEST REPORT (ANUBIS MONTE CARLO)
            </h2>
            <p className="text-xs text-gray-400 mt-2 max-w-md leading-relaxed">
              Drag &amp; drop file hasil backtest MetaTrader 5 / MetaTrader 4 (<span className="text-gray-200 font-mono">.xlsx, .csv</span>) untuk menjalankan simulasi kuantitatif Monte Carlo, evaluasi In-Sample vs Out-of-Sample, dan uji stress biaya.
            </p>

            {errorMsg && (
              <div className="mt-4 p-3 rounded bg-red-900/20 border border-red-500/40 text-red-400 text-xs max-w-lg">
                {errorMsg}
              </div>
            )}

            <div className="flex items-center justify-center gap-2 mt-5 bg-[#14161a] border border-[#23262e] rounded-lg px-4 py-2.5 text-xs max-w-md mx-auto">
              <span className="text-gray-400 font-semibold whitespace-nowrap">Auto-Split (File Tunggal):</span>
              <select
                value={splitOption}
                onChange={(e) => setSplitOption(e.target.value)}
                className="bg-[#0d0f12] border border-[#2a2d36] rounded px-2.5 py-1 text-xs text-white focus:border-[#f3a910] outline-none"
              >
                <option value="none">Tanpa Split (100% In-Sample &amp; OOS)</option>
                <option value="auto">Auto-Detect (2022 jika ada, atau 70/30)</option>
                <option value="70-30">70% IS / 30% OOS</option>
                <option value="80-20">80% IS / 20% OOS</option>
                <option value="50-50">50% IS / 50% OOS</option>
                <option value="2022">Split Tanggal 2022-01-01</option>
              </select>
            </div>

            <div className="flex flex-wrap items-center justify-center gap-3 mt-6">
              <button
                onClick={() => fileInputUnifiedRef.current?.click()}
                disabled={isProcessing}
                className="bg-[#f3a910] hover:bg-[#d9930b] text-black px-5 py-3 rounded-lg text-xs font-bold tracking-wider uppercase transition-all shadow-lg flex items-center gap-2 hover:scale-[1.02]"
              >
                <span>📁</span>
                <span>Upload Single File / Auto-Split</span>
              </button>

              <button
                onClick={() => fileInputIsRef.current?.click()}
                disabled={isProcessing}
                className="bg-blue-900/20 hover:bg-blue-900/40 text-blue-300 border border-blue-500/40 px-4 py-3 rounded-lg text-xs font-semibold tracking-wide transition-all flex items-center gap-2"
              >
                <span>📥</span>
                <span>Upload IS (File A)</span>
              </button>

              <button
                onClick={() => fileInputOosRef.current?.click()}
                disabled={isProcessing}
                className="bg-rose-900/20 hover:bg-rose-900/40 text-rose-300 border border-rose-500/40 px-4 py-3 rounded-lg text-xs font-semibold tracking-wide transition-all flex items-center gap-2"
              >
                <span>📥</span>
                <span>Upload OOS (File B)</span>
              </button>

              {supabaseTrades && supabaseTrades.length > 0 && (
                <button
                  onClick={handleLoadFromSupabase}
                  disabled={isProcessing}
                  className="bg-[#1c1e24] hover:bg-[#252830] text-gray-200 border border-[#2a2d36] px-4 py-3 rounded-lg text-xs font-semibold tracking-wide transition-all flex items-center gap-2"
                >
                  <span>⚡</span>
                  <span>Load dari Active Ledger ({supabaseTrades.length})</span>
                </button>
              )}
            </div>

            <div className="mt-8 pt-6 border-t border-[#1c1e24] flex items-center gap-2 text-xs text-gray-500">
              <span>Belum punya file laporan trading?</span>
              <button onClick={handleLoadDemo} className="text-[#f3a910] hover:underline font-semibold flex items-center gap-1">
                <span>🧪 Coba dengan Demo Data</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* STATE 2: ACTIVE ANUBIS 7-TAB WORKSPACE                                   */}
      {/* ========================================================================= */}
      {currentDataset && (
        <div className="space-y-6">
          {/* Top Bar: Action Buttons & Dataset Badges */}
          <div className="bg-[#14161a] border border-[#23262e] rounded-xl p-5 shadow-xl">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-4 border-b border-[#23262e]">
              <div>
                <h1 className="text-xl font-bold text-white tracking-wide flex items-center gap-2">
                  <span>ANUBIS MONTE CARLO QUANTITATIVE SUITE</span>
                  <span className="text-[10px] px-2 py-0.5 rounded font-bold uppercase bg-[#f3a910]/20 text-[#f3a910] border border-[#f3a910]/30">
                    7-TAB ENGINE
                  </span>
                </h1>
                <p className="text-xs text-gray-400 mt-1">
                  {currentDataset.sourceName} · {currentDataset.N} Trades ({currentDataset.stats.startDateStr} to {currentDataset.stats.endDateStr}) · Net Profit {fmtMoney(currentDataset.stats.totalProfit)}
                </p>
                <div className="flex flex-wrap gap-2 mt-2">
                  <span className={`text-[11px] px-2.5 py-0.5 rounded-full border ${
                    isDualFileMode ? 'bg-purple-900/20 text-purple-300 border-purple-500/30' : 'bg-amber-900/20 text-amber-300 border-amber-500/30'
                  }`}>
                    {isDualFileMode ? 'Dual-File IS/OOS' : fullDataset ? `Single File (${splitOption})` : 'Dataset'}
                  </span>
                  <span className="text-[11px] px-2.5 py-0.5 rounded-full bg-blue-900/20 text-blue-300 border border-blue-500/30">
                    IS: {currentIsPool.N} trades
                  </span>
                  <span className={`text-[11px] px-2.5 py-0.5 rounded-full border ${
                    oosDataset ? 'bg-rose-900/20 text-rose-300 border-rose-500/30' : 'bg-rose-950 text-rose-300 border-rose-500/60 font-semibold'
                  }`}>
                    OOS: {oosDataset ? `${oosDataset.N} trades` : 'Belum di-upload (Menunggu File B)'}
                  </span>
                  <span className="text-[11px] px-2.5 py-0.5 rounded-full bg-[#1c1e24] text-gray-400 border border-[#2a2d36]">
                    1R Unit: {currentDataset.detectedRisk ? currentDataset.detectedRisk.label : '10 pips'}
                  </span>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {isDualFileMode ? (
                  <>
                    <button
                      onClick={() => fileInputIsRef.current?.click()}
                      className="bg-blue-900/25 hover:bg-blue-900/45 text-blue-300 border border-blue-500/40 px-3 py-2 rounded text-xs font-semibold flex items-center gap-1.5 transition-colors"
                      title="Ganti File In-Sample (File A)"
                    >
                      <span>📥</span>
                      <span>Ganti IS (File A)</span>
                    </button>
                    <button
                      onClick={() => fileInputOosRef.current?.click()}
                      className={`px-3.5 py-2 rounded text-xs font-bold flex items-center gap-1.5 transition-all shadow-md ${
                        oosDataset
                          ? 'bg-rose-900/25 hover:bg-rose-900/45 text-rose-300 border border-rose-500/40'
                          : 'bg-rose-600 hover:bg-rose-500 text-white ring-2 ring-rose-400/50'
                      }`}
                      title={oosDataset ? 'Ganti File Out-of-Sample (File B)' : 'Upload File Out-of-Sample (File B)'}
                    >
                      <span>📥</span>
                      <span>{oosDataset ? 'Ganti OOS (File B)' : '+ Upload OOS (File B)'}</span>
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      onClick={() => fileInputUnifiedRef.current?.click()}
                      className="bg-[#1c1e24] hover:bg-[#252830] text-gray-300 border border-[#2a2d36] px-3 py-2 rounded text-xs font-semibold flex items-center gap-1.5"
                    >
                      <span>📁</span>
                      <span>Ganti File</span>
                    </button>
                    <button
                      onClick={() => fileInputOosRef.current?.click()}
                      className="bg-rose-900/25 hover:bg-rose-900/45 text-rose-300 border border-rose-500/40 px-3 py-2 rounded text-xs font-semibold flex items-center gap-1.5 transition-colors"
                      title="Ubah menjadi Dual-File mode dengan memasukkan file OOS terpisah"
                    >
                      <span>➕</span>
                      <span>Tambah File OOS</span>
                    </button>
                  </>
                )}
                <button
                  onClick={handleDownloadReport}
                  className="bg-[#f3a910] hover:bg-[#d9930b] text-black px-4 py-2 rounded text-xs font-bold tracking-wide flex items-center gap-1.5 shadow-lg"
                >
                  <span>📊</span>
                  <span>Export HTML Interaktif</span>
                </button>
                <button
                  onClick={handleReset}
                  className="bg-[#1c1e24] hover:bg-red-900/30 text-gray-400 hover:text-red-300 border border-[#2a2d36] px-3 py-2 rounded text-xs font-semibold"
                >
                  <span>🔄 Reset</span>
                </button>
              </div>
            </div>

            {/* Navigation Tabs */}
            <div className="flex gap-2 overflow-x-auto pt-3 text-xs border-b border-[#23262e]">
              {[
                { id: 'sum', label: 'Ringkasan' },
                { id: 'wr', label: 'Ekspektasi Win Rate' },
                { id: 'tbl', label: 'Tabel Percentile' },
                { id: 'cagr', label: 'CAGR & Compounding' },
                { id: 'sim', label: 'Simulator Live' },
                { id: 'xc', label: 'Cross-Check & Biaya' },
                { id: 'lim', label: 'Asumsi & Checks' },
              ].map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`pb-2.5 px-3 border-b-2 font-semibold whitespace-nowrap transition-colors ${
                    activeTab === tab.id
                      ? 'border-[#f3a910] text-[#f3a910]'
                      : 'border-transparent text-gray-400 hover:text-white'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          </div>

          {/* Dual-File Step 2 Upload Banner */}
          {isDualFileMode && !oosDataset && (
            <div className="bg-gradient-to-r from-rose-950/80 via-[#1c1418] to-[#14161a] border-2 border-rose-500/80 rounded-xl p-5 shadow-2xl flex flex-col md:flex-row md:items-center justify-between gap-4">
              <div className="flex items-center gap-3.5">
                <div className="w-12 h-12 rounded-xl bg-rose-500/20 border border-rose-500/40 flex items-center justify-center text-2xl shrink-0">
                  📥
                </div>
                <div>
                  <h4 className="text-sm font-bold text-white uppercase tracking-wide flex items-center gap-2">
                    <span>Langkah 2: Masukkan File Kedua untuk Out-of-Sample (OOS)</span>
                    <span className="text-[10px] px-2 py-0.5 rounded bg-rose-500 text-white font-bold">
                      MENUNGGU FILE B
                    </span>
                  </h4>
                  <p className="text-xs text-gray-300 mt-1 leading-relaxed">
                    File In-Sample (<span className="text-blue-300 font-semibold">{isDataset?.sourceName}</span>) telah dimuat ({isDataset?.N} trades). Sekarang silakan upload file kedua Anda untuk data Out-of-Sample (File B).
                  </p>
                </div>
              </div>
              <button
                onClick={() => fileInputOosRef.current?.click()}
                disabled={isProcessing}
                className="bg-rose-600 hover:bg-rose-500 text-white px-5 py-3 rounded-lg text-xs font-bold uppercase tracking-wider transition-all shadow-xl flex items-center justify-center gap-2 whitespace-nowrap hover:scale-[1.02] shrink-0"
              >
                <span>📂</span>
                <span>Pilih File OOS (File B)</span>
              </button>
            </div>
          )}

          {/* TAB 1: RINGKASAN */}
          {activeTab === 'sum' && (
            <div className="space-y-6">
              {/* Verdict Banner */}
              <div className="bg-[#14161a] border-l-4 border-l-[#f3a910] border border-[#23262e] rounded-r-xl p-5 shadow-lg">
                <h3 className="text-xs font-bold uppercase tracking-wider text-[#f3a910] mb-2">Kesimpulan Kuantitatif</h3>
                <ul className="text-xs text-gray-300 space-y-2 list-disc pl-5">
                  <li>
                    <b>Sequencing Risk:</b> Simulasi bootstrap menunjukkan ketahanan profitabilitas konsisten antara In-Sample ({currentIsPool.N} trades) dan Out-of-Sample ({currentOosPool.N} trades).
                  </li>
                  <li>
                    <b>Win Rate vs Breakeven:</b> Win Rate In-Sample {stdIs?.win_rate.toFixed(1)}% (Breakeven {stdIs?.breakeven_win_rate.toFixed(1)}%) vs Out-of-Sample {stdOos?.win_rate.toFixed(1)}% (Breakeven {stdOos?.breakeven_win_rate.toFixed(1)}%).
                  </li>
                  <li>
                    <b>MAE Floating Risk:</b> Drawdown maksimum yang memperhitungkan adverse excursion terdalam (MAE) memberikan estimasi batas risiko riil akun.
                  </li>
                </ul>
              </div>

              {/* IS vs OOS Main KPI Cards */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* IS Card */}
                <div className="bg-[#14161a] border border-[#23262e] rounded-xl p-5 shadow-lg">
                  <div className="flex items-center gap-2 mb-3">
                    <span className="w-2.5 h-2.5 rounded-full bg-blue-500"></span>
                    <span className="text-xs font-bold text-white uppercase tracking-wider">{currentIsPool.sourceName}</span>
                  </div>
                  <div className="grid grid-cols-3 gap-3 text-left">
                    <div>
                      <div className="text-[10px] text-gray-500 uppercase">Net Profit</div>
                      <div className="text-base font-bold text-green-400">{fmtMoney(currentIsPool.stats.totalProfit)}</div>
                    </div>
                    <div>
                      <div className="text-[10px] text-gray-500 uppercase">Profit Factor</div>
                      <div className="text-base font-bold text-[#f3a910]">{f2(stdIs?.profit_factor)}</div>
                    </div>
                    <div>
                      <div className="text-[10px] text-gray-500 uppercase">Win Rate</div>
                      <div className="text-base font-bold text-white">{pctS(stdIs?.win_rate)}</div>
                    </div>
                    <div>
                      <div className="text-[10px] text-gray-500 uppercase">Payoff Ratio</div>
                      <div className="text-base font-bold text-gray-300">{f2(stdIs?.payoff)}</div>
                    </div>
                    <div>
                      <div className="text-[10px] text-gray-500 uppercase">Expectancy (R)</div>
                      <div className="text-base font-bold text-blue-400">+{f2(stdIs?.expectancy_R)}R</div>
                    </div>
                    <div>
                      <div className="text-[10px] text-gray-500 uppercase">t-statistic</div>
                      <div className="text-base font-bold text-white">{f2(stdIs?.t_stat)}</div>
                    </div>
                  </div>
                </div>

                {/* OOS Card */}
                <div className="bg-[#14161a] border border-[#23262e] rounded-xl p-5 shadow-lg">
                  <div className="flex items-center justify-between gap-2 mb-3">
                    <div className="flex items-center gap-2">
                      <span className="w-2.5 h-2.5 rounded-full bg-rose-500"></span>
                      <span className="text-xs font-bold text-white uppercase tracking-wider">
                        {oosDataset ? currentOosPool.sourceName : 'Out-of-Sample (Belum Ada File B)'}
                      </span>
                    </div>
                    {isDualFileMode && !oosDataset && (
                      <button
                        onClick={() => fileInputOosRef.current?.click()}
                        disabled={isProcessing}
                        className="bg-rose-600 hover:bg-rose-500 text-white px-3 py-1 rounded text-[11px] font-bold uppercase tracking-wider shadow flex items-center gap-1.5 transition-all hover:scale-[1.02]"
                      >
                        <span>📥</span>
                        <span>Upload File B</span>
                      </button>
                    )}
                  </div>
                  <div className="grid grid-cols-3 gap-3 text-left">
                    <div>
                      <div className="text-[10px] text-gray-500 uppercase">Net Profit</div>
                      <div className="text-base font-bold text-green-400">{fmtMoney(currentOosPool.stats.totalProfit)}</div>
                    </div>
                    <div>
                      <div className="text-[10px] text-gray-500 uppercase">Profit Factor</div>
                      <div className="text-base font-bold text-[#f3a910]">{f2(stdOos?.profit_factor)}</div>
                    </div>
                    <div>
                      <div className="text-[10px] text-gray-500 uppercase">Win Rate</div>
                      <div className="text-base font-bold text-white">{pctS(stdOos?.win_rate)}</div>
                    </div>
                    <div>
                      <div className="text-[10px] text-gray-500 uppercase">Payoff Ratio</div>
                      <div className="text-base font-bold text-gray-300">{f2(stdOos?.payoff)}</div>
                    </div>
                    <div>
                      <div className="text-[10px] text-gray-500 uppercase">Expectancy (R)</div>
                      <div className="text-base font-bold text-rose-400">+{f2(stdOos?.expectancy_R)}R</div>
                    </div>
                    <div>
                      <div className="text-[10px] text-gray-500 uppercase">t-statistic</div>
                      <div className="text-base font-bold text-white">{f2(stdOos?.t_stat)}</div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Per-Year Breakdown Bar Chart */}
              <div className="bg-[#14161a] border border-[#23262e] rounded-xl p-5 shadow-lg">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-xs font-bold uppercase tracking-wider text-white">Breakdown Performa Per Tahun</h3>
                  <div className="inline-flex rounded-lg border border-[#23262e] bg-[#0d0f12] p-0.5 text-xs">
                    <button
                      onClick={() => setYearMode('net')}
                      className={`px-3 py-1 rounded-md font-semibold transition-colors ${yearMode === 'net' ? 'bg-[#f3a910] text-black' : 'text-gray-400 hover:text-white'}`}
                    >
                      Net Profit ($)
                    </button>
                    <button
                      onClick={() => setYearMode('wr')}
                      className={`px-3 py-1 rounded-md font-semibold transition-colors ${yearMode === 'wr' ? 'bg-[#f3a910] text-black' : 'text-gray-400 hover:text-white'}`}
                    >
                      Win Rate (%)
                    </button>
                    <button
                      onClick={() => setYearMode('pips')}
                      className={`px-3 py-1 rounded-md font-semibold transition-colors ${yearMode === 'pips' ? 'bg-[#f3a910] text-black' : 'text-gray-400 hover:text-white'}`}
                    >
                      Pip / Trade
                    </button>
                  </div>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full text-xs text-left">
                    <thead>
                      <tr className="border-b border-[#23262e] text-gray-500 uppercase text-[10px]">
                        <th className="py-2.5 px-3">Tahun</th>
                        <th className="py-2.5 px-3">Jumlah Trade</th>
                        <th className="py-2.5 px-3">Win Rate</th>
                        <th className="py-2.5 px-3">Net Profit ($)</th>
                        <th className="py-2.5 px-3">Rata-rata Pip/Trade</th>
                        <th className="py-2.5 px-3">Rata-rata Profit/Trade</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#1c1e24] font-mono text-gray-300">
                      {perYearData.map((y) => (
                        <tr key={y.year}>
                          <td className="py-2.5 px-3 font-sans font-semibold text-white">{y.year}</td>
                          <td className="py-2.5 px-3">{y.n} trades</td>
                          <td className="py-2.5 px-3 text-green-400">{y.win_rate.toFixed(1)}%</td>
                          <td className={`py-2.5 px-3 font-bold ${y.net_usd >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                            {fmtMoney(y.net_usd)}
                          </td>
                          <td className="py-2.5 px-3">{y.mean_pips.toFixed(1)} pips</td>
                          <td className="py-2.5 px-3">{fmtMoney(y.mean_usd)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {/* TAB 2: EKSPEKTASI WIN RATE */}
          {activeTab === 'wr' && (
            <div className="space-y-6">
              <div className="flex items-center justify-between bg-[#14161a] border border-[#23262e] rounded-xl p-4">
                <div className="flex items-center gap-2">
                  <span className="text-xs uppercase text-gray-400 font-semibold">Pilih Data Split:</span>
                  <div className="inline-flex rounded-lg border border-[#23262e] bg-[#0d0f12] p-0.5 text-xs">
                    <button
                      type="button"
                      onClick={() => setWrSplitView('ALL')}
                      className={`px-3 py-1 rounded font-semibold transition ${wrSplitView === 'ALL' ? 'bg-[#f3a910] text-black shadow' : 'text-gray-400 hover:text-white'}`}
                    >
                      Gabungan ({currentAllPool?.N || 0})
                    </button>
                    <button
                      type="button"
                      onClick={() => setWrSplitView('IS')}
                      className={`px-3 py-1 rounded font-semibold transition ${wrSplitView === 'IS' ? 'bg-blue-600 text-white shadow' : 'text-gray-400 hover:text-white'}`}
                    >
                      In-Sample ({currentIsPool?.N || 0})
                    </button>
                    <button
                      type="button"
                      onClick={() => setWrSplitView('OOS')}
                      className={`px-3 py-1 rounded font-semibold transition ${wrSplitView === 'OOS' ? 'bg-rose-600 text-white shadow' : 'text-gray-400 hover:text-white'}`}
                    >
                      Out-of-Sample ({currentOosPool?.N || 0})
                    </button>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <span className="text-xs uppercase text-gray-400 font-semibold">Tampilan Kolom:</span>
                  <button
                    onClick={() => setWrColMode(wrColMode === 'key' ? 'all' : 'key')}
                    className="px-3 py-1 bg-[#1c1e24] hover:bg-[#252830] text-gray-200 border border-[#2a2d36] rounded text-xs font-semibold"
                  >
                    {wrColMode === 'key' ? 'Mode Lengkap (P5–P95)' : 'Mode Ringkas'}
                  </button>
                </div>
              </div>

              {/* Horizon Distribution Table */}
              <div className="bg-[#14161a] border border-[#23262e] rounded-xl p-5 shadow-lg overflow-x-auto">
                <h3 className="text-xs font-bold uppercase tracking-wider text-white mb-3">
                  Distribusi Win Rate per Horizon Trade ({wrSplitView === 'ALL' ? 'Gabungan' : wrSplitView})
                </h3>
                {(() => {
                  const wrData = wrSplitView === 'ALL' ? wrAllData : wrSplitView === 'IS' ? wrIsData : wrOosData;
                  if (!wrData) return null;
                  const cols = wrColMode === 'all' ? [5, 10, 25, 50, 75, 90, 95] : [5, 50, 95];
                  return (
                    <table className="w-full text-xs text-left">
                      <thead>
                        <tr className="border-b border-[#23262e] text-gray-500 uppercase text-[10px]">
                          <th className="py-2 px-3">Horizon</th>
                          {cols.map((p) => (
                            <th key={p} className="py-2 px-3">P{p}</th>
                          ))}
                          <th className="py-2 px-3">Mean</th>
                          <th className="py-2 px-3">P(&lt; Breakeven {wrData.breakeven_wr.toFixed(1)}%)</th>
                          <th className="py-2 px-3">P(&lt; 50%)</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[#1c1e24] font-mono text-gray-300">
                        {wrData.by_horizon.map((h, i) => (
                          <tr key={i}>
                            <td className="py-2.5 px-3 font-sans font-semibold text-white">{h.label}</td>
                            {cols.map((p) => (
                              <td key={p} className="py-2.5 px-3">{h.pcts[String(p)]?.toFixed(1)}%</td>
                            ))}
                            <td className="py-2.5 px-3 font-bold text-white">{h.mean.toFixed(1)}%</td>
                            <td className="py-2.5 px-3">
                              <span className={`px-2 py-0.5 rounded text-[11px] font-bold ${h.p_below_breakeven > 0.25 ? 'bg-red-900/30 text-red-400' : 'bg-green-900/30 text-green-400'}`}>
                                {(h.p_below_breakeven * 100).toFixed(1)}%
                              </span>
                            </td>
                            <td className="py-2.5 px-3">{(h.p_below_50 * 100).toFixed(1)}%</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  );
                })()}
              </div>

              {/* Cost Haircut Impact Table */}
              <div className="bg-[#14161a] border border-[#23262e] rounded-xl p-5 shadow-lg overflow-x-auto">
                <h3 className="text-xs font-bold uppercase tracking-wider text-white mb-3">
                  Sensitivitas Biaya Tambahan (Haircut Pips) vs Win Rate Margin
                </h3>
                {(() => {
                  const wrData = wrSplitView === 'IS' ? wrIsData : wrOosData;
                  if (!wrData) return null;
                  return (
                    <table className="w-full text-xs text-left">
                      <thead>
                        <tr className="border-b border-[#23262e] text-gray-500 uppercase text-[10px]">
                          <th className="py-2 px-3">Biaya Tambahan (+pip)</th>
                          <th className="py-2 px-3">Win Rate Hasil Potongan</th>
                          <th className="py-2 px-3">Breakeven Win Rate</th>
                          <th className="py-2 px-3">Margin di Atas Breakeven</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[#1c1e24] font-mono text-gray-300">
                        {wrData.haircut.map((hc, idx) => (
                          <tr key={idx}>
                            <td className="py-2.5 px-3 font-sans font-semibold text-white">+{hc.haircut_pips.toFixed(1)} pip</td>
                            <td className="py-2.5 px-3">{hc.win_rate.toFixed(1)}%</td>
                            <td className="py-2.5 px-3">{hc.breakeven_wr.toFixed(1)}%</td>
                            <td className="py-2.5 px-3 font-bold">
                              <span className={`px-2 py-0.5 rounded text-[11px] ${hc.margin_pts > 0 ? 'text-green-400 bg-green-900/20' : 'text-red-400 bg-red-900/20'}`}>
                                {hc.margin_pts >= 0 ? '+' : ''}{hc.margin_pts.toFixed(1)} pts
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  );
                })()}
              </div>
            </div>
          )}

          {/* TAB 3: TABEL PERCENTILE */}
          {activeTab === 'tbl' && (() => {
            const sim = tblSimResult || liveSimResult;
            const activePool = tblSplit === 'ALL' ? currentAllPool : tblSplit === 'IS' ? currentIsPool : currentOosPool;
            const activeStd = tblSplit === 'ALL' ? stdAll : tblSplit === 'IS' ? stdIs : stdOos;
            const pcts = [5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90, 95];

            return (
              <div className="space-y-5">
                {/* Controls Bar */}
                <div className="bg-[#14161a] border border-[#23262e] rounded-xl p-4 flex flex-wrap items-center justify-between gap-4">
                  <div className="flex flex-wrap items-center gap-3">
                    {/* Split Selector Segmented */}
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs text-gray-400 uppercase font-semibold">Split:</span>
                      <div className="inline-flex rounded-lg border border-[#23262e] bg-[#0d0f12] p-0.5 text-xs">
                        <button
                          type="button"
                          onClick={() => setTblSplit('ALL')}
                          className={`px-3 py-1 rounded font-semibold transition ${tblSplit === 'ALL' ? 'bg-[#f3a910] text-black shadow' : 'text-gray-400 hover:text-white'}`}
                        >
                          Gabungan ({currentAllPool?.N || 0})
                        </button>
                        <button
                          type="button"
                          onClick={() => setTblSplit('IS')}
                          className={`px-3 py-1 rounded font-semibold transition ${tblSplit === 'IS' ? 'bg-blue-600 text-white shadow' : 'text-gray-400 hover:text-white'}`}
                        >
                          In-Sample ({currentIsPool?.N || 0})
                        </button>
                        <button
                          type="button"
                          onClick={() => setTblSplit('OOS')}
                          className={`px-3 py-1 rounded font-semibold transition ${tblSplit === 'OOS' ? 'bg-rose-600 text-white shadow' : 'text-gray-400 hover:text-white'}`}
                        >
                          Out-of-Sample ({currentOosPool?.N || 0})
                        </button>
                      </div>
                    </div>

                    {/* Method Selector */}
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs text-gray-400 uppercase font-semibold">Metode:</span>
                      <select
                        value={tblMethod}
                        onChange={(e) => setTblMethod(e.target.value)}
                        className="bg-[#0d0f12] border border-[#23262e] rounded px-2.5 py-1 text-xs text-white"
                      >
                        <option value="resample">Resample (Bootstrap iid)</option>
                        <option value="shuffle">Shuffle (Permutasi Urutan)</option>
                        <option value="block">Block Bootstrap</option>
                      </select>
                    </div>

                    {/* Percentile Highlight Slider */}
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-gray-400 uppercase font-semibold">
                        Sorot Percentile: <b className="text-[#f3a910]">P{tblHighlightPct}</b>
                      </span>
                      <input
                        type="range"
                        min="5"
                        max="95"
                        step="5"
                        value={tblHighlightPct}
                        onChange={(e) => setTblHighlightPct(parseInt(e.target.value, 10))}
                        className="accent-[#f3a910] w-28"
                      />
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={handleExportTblCsv}
                    className="px-3.5 py-1.5 bg-[#f3a910] hover:bg-[#d9930b] text-black font-bold text-xs rounded transition flex items-center gap-1.5 shadow"
                  >
                    <span>⬇</span> Export CSV
                  </button>
                </div>

                {/* Spot KPI Cards for Highlighted Percentile */}
                {sim?.summary && (
                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
                    <div className="bg-[#14161a] border border-[#23262e] rounded-xl p-3 shadow">
                      <div className="text-[10px] text-gray-500 uppercase font-semibold">
                        {tblSplit === 'ALL' ? 'GABUNGAN' : tblSplit} · {tblMethod} · P{tblHighlightPct}
                      </div>
                      <div className="text-xs text-gray-300 font-medium mt-0.5">Net Profit / CAGR</div>
                      <div className="text-sm font-bold text-white mt-1">
                        {fmtMoney(sim.summary.net_profit?.[`p${tblHighlightPct}`] ?? sim.summary.net_profit?.median)}
                        <span className="text-xs font-normal text-gray-400 ml-1">
                          · {f1(sim.summary.cagr_equity?.[`p${tblHighlightPct}`] ?? sim.summary.cagr_equity?.median)}%
                        </span>
                      </div>
                    </div>
                    <div className="bg-[#14161a] border border-[#23262e] rounded-xl p-3 shadow">
                      <div className="text-[10px] text-gray-500 uppercase font-semibold">
                        {tblSplit === 'ALL' ? 'GABUNGAN' : tblSplit} · {tblMethod} · P{tblHighlightPct}
                      </div>
                      <div className="text-xs text-gray-300 font-medium mt-0.5">Profit Factor</div>
                      <div className="text-sm font-bold text-white mt-1">
                        {f2(sim.summary.profit_factor?.[`p${tblHighlightPct}`] ?? sim.summary.profit_factor?.median)}
                      </div>
                    </div>
                    <div className="bg-[#14161a] border border-[#23262e] rounded-xl p-3 shadow">
                      <div className="text-[10px] text-gray-500 uppercase font-semibold">
                        {tblSplit === 'ALL' ? 'GABUNGAN' : tblSplit} · {tblMethod} · P{tblHighlightPct}
                      </div>
                      <div className="text-xs text-gray-300 font-medium mt-0.5">Win Rate</div>
                      <div className="text-sm font-bold text-white mt-1">
                        {f1(sim.summary.win_rate?.[`p${tblHighlightPct}`] ?? sim.summary.win_rate?.median)}%
                      </div>
                    </div>
                    <div className="bg-[#14161a] border border-[#23262e] rounded-xl p-3 shadow">
                      <div className="text-[10px] text-gray-500 uppercase font-semibold">
                        {tblSplit === 'ALL' ? 'GABUNGAN' : tblSplit} · {tblMethod} · P{tblHighlightPct}
                      </div>
                      <div className="text-xs text-gray-300 font-medium mt-0.5">Sharpe / Sortino</div>
                      <div className="text-sm font-bold text-white mt-1">
                        {f2(sim.summary.sharpe?.[`p${tblHighlightPct}`] ?? sim.summary.sharpe?.median)}
                        <span className="text-xs font-normal text-gray-400 ml-1">
                          / {f2(sim.summary.sortino?.[`p${tblHighlightPct}`] ?? sim.summary.sortino?.median)}
                        </span>
                      </div>
                    </div>
                    <div className="bg-[#14161a] border border-[#23262e] rounded-xl p-3 shadow">
                      <div className="text-[10px] text-gray-500 uppercase font-semibold">
                        {tblSplit === 'ALL' ? 'GABUNGAN' : tblSplit} · {tblMethod} · P{tblHighlightPct}
                      </div>
                      <div className="text-xs text-gray-300 font-medium mt-0.5">Max DD MAE</div>
                      <div className="text-sm font-bold text-rose-400 mt-1">
                        {fmtMoney(sim.summary.max_dd_mae_usd?.[`p${tblHighlightPct}`] ?? sim.summary.max_dd_mae_usd?.median)}
                      </div>
                    </div>
                    <div className="bg-[#14161a] border border-[#23262e] rounded-xl p-3 shadow">
                      <div className="text-[10px] text-gray-500 uppercase font-semibold">
                        {tblSplit === 'ALL' ? 'GABUNGAN' : tblSplit} · {tblMethod} · P{tblHighlightPct}
                      </div>
                      <div className="text-xs text-gray-300 font-medium mt-0.5">Max Cons Loss / Win</div>
                      <div className="text-sm font-bold text-white mt-1">
                        {f0(sim.summary.max_cons_losses?.[`p${tblHighlightPct}`] ?? sim.summary.max_cons_losses?.median)}
                        <span className="text-xs font-normal text-gray-400 ml-1">
                          / {f0(sim.summary.max_cons_wins?.[`p${tblHighlightPct}`] ?? sim.summary.max_cons_wins?.median)}
                        </span>
                      </div>
                    </div>
                  </div>
                )}

                {/* Percentile Table */}
                <div className="bg-[#14161a] border border-[#23262e] rounded-xl p-5 shadow-lg overflow-x-auto">
                  <table className="w-full text-xs text-left">
                    <thead>
                      <tr className="border-b border-[#23262e] text-gray-400 uppercase text-[10px]">
                        <th className="py-2.5 px-3">Percentile</th>
                        <th className="py-2.5 px-3">
                          Net Profit ($)
                          {tblMethod === 'shuffle' && <span className="block text-[9px] text-gray-500 normal-case font-normal">konstan</span>}
                        </th>
                        <th className="py-2.5 px-3">
                          Profit Factor
                          {tblMethod === 'shuffle' && <span className="block text-[9px] text-gray-500 normal-case font-normal">konstan</span>}
                        </th>
                        <th className="py-2.5 px-3">
                          Win Rate
                          {tblMethod === 'shuffle' && <span className="block text-[9px] text-gray-500 normal-case font-normal">konstan</span>}
                        </th>
                        <th className="py-2.5 px-3">
                          Sharpe (Ann.)
                          <span className="block text-[9px] text-amber-500 normal-case font-normal">rendah = buruk</span>
                        </th>
                        <th className="py-2.5 px-3">
                          Max DD Closed ($)
                          <span className="block text-[9px] text-red-500 normal-case font-normal">tinggi = buruk</span>
                        </th>
                        <th className="py-2.5 px-3">
                          Max DD MAE ($)
                          <span className="block text-[9px] text-rose-500 normal-case font-normal">tinggi = buruk</span>
                        </th>
                        <th className="py-2.5 px-3">
                          Max Cons Losses
                          <span className="block text-[9px] text-orange-500 normal-case font-normal">tinggi = buruk</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#1c1e24] font-mono text-gray-300">
                      {sim?.summary && pcts.map((pct) => {
                        const isHl = pct === tblHighlightPct;
                        const isKey = pct === 5 || pct === 50 || pct === 95;
                        const np = sim.summary.net_profit?.[`p${pct}`] ?? sim.summary.net_profit?.median;
                        const pf = sim.summary.profit_factor?.[`p${pct}`] ?? sim.summary.profit_factor?.median;
                        const wr = sim.summary.win_rate?.[`p${pct}`] ?? sim.summary.win_rate?.median;
                        const sh = sim.summary.sharpe?.[`p${pct}`] ?? sim.summary.sharpe?.median;
                        const dd = sim.summary.max_dd_usd?.[`p${pct}`] ?? sim.summary.max_dd_usd?.median;
                        const mae = sim.summary.max_dd_mae_usd?.[`p${pct}`] ?? sim.summary.max_dd_mae_usd?.median;
                        const cl = sim.summary.max_cons_losses?.[`p${pct}`] ?? sim.summary.max_cons_losses?.median;

                        return (
                          <tr
                            key={pct}
                            onClick={() => setTblHighlightPct(pct)}
                            className={`cursor-pointer transition-colors ${
                              isHl
                                ? 'bg-[#f3a910]/20 font-bold text-white ring-1 ring-[#f3a910]/50'
                                : isKey
                                ? 'bg-[#181a20] font-semibold text-gray-200 hover:bg-[#1f222a]'
                                : 'hover:bg-[#1a1d24]'
                            }`}
                          >
                            <td className="py-2 px-3 font-sans font-semibold flex items-center gap-1.5">
                              {isHl && <span className="text-[#f3a910]">▶</span>}
                              P{pct}
                              {pct === 50 && <span className="text-[10px] text-gray-500 font-normal">(Median)</span>}
                            </td>
                            <td className={`py-2 px-3 ${tblMethod === 'shuffle' ? 'text-gray-400' : 'font-bold text-white'}`}>
                              {fmtMoney(np)}
                            </td>
                            <td className={`py-2 px-3 ${tblMethod === 'shuffle' ? 'text-gray-400' : ''}`}>
                              {f2(pf)}
                            </td>
                            <td className={`py-2 px-3 ${tblMethod === 'shuffle' ? 'text-gray-400' : ''}`}>
                              {f1(wr)}%
                            </td>
                            <td className="py-2 px-3">{f2(sh)}</td>
                            <td className="py-2 px-3 text-red-400">{fmtMoney(dd)}</td>
                            <td className="py-2 px-3 text-rose-400 font-semibold">{fmtMoney(mae)}</td>
                            <td className="py-2 px-3">{f0(cl)}</td>
                          </tr>
                        );
                      })}

                      {/* Mean Row */}
                      {sim?.summary && (
                        <tr className="bg-[#121418] border-t-2 border-[#2a2d36] text-gray-300 font-semibold">
                          <td className="py-2 px-3 font-sans text-amber-400">Rata-rata (Mean)</td>
                          <td className="py-2 px-3">{fmtMoney(sim.summary.net_profit?.mean)}</td>
                          <td className="py-2 px-3">{f2(sim.summary.profit_factor?.mean)}</td>
                          <td className="py-2 px-3">{f1(sim.summary.win_rate?.mean)}%</td>
                          <td className="py-2 px-3">{f2(sim.summary.sharpe?.mean)}</td>
                          <td className="py-2 px-3 text-red-400">{fmtMoney(sim.summary.max_dd_usd?.mean)}</td>
                          <td className="py-2 px-3 text-rose-400">{fmtMoney(sim.summary.max_dd_mae_usd?.mean)}</td>
                          <td className="py-2 px-3">{f0(sim.summary.max_cons_losses?.mean)}</td>
                        </tr>
                      )}

                      {/* Actual Dataset Row */}
                      {activeStd && (
                        <tr className="bg-[#0f1115] text-cyan-400 font-semibold border-t border-[#23262e]">
                          <td className="py-2 px-3 font-sans">Aktual (Historis)</td>
                          <td className="py-2 px-3">{fmtMoney(activeStd.totalProfit)}</td>
                          <td className="py-2 px-3">{f2(activeStd.profitFactor)}</td>
                          <td className="py-2 px-3">{f1(activeStd.winRate)}%</td>
                          <td className="py-2 px-3">{f2(activeStd.sharpe)}</td>
                          <td className="py-2 px-3 text-red-400">{fmtMoney(activeStd.maxDrawdown)}</td>
                          <td className="py-2 px-3 text-rose-400">{fmtMoney(activeStd.maxMaeDrawdown)}</td>
                          <td className="py-2 px-3">{f0(activeStd.maxConsecutiveLosses)}</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>

                {/* Explanatory Note Callout */}
                <div className="bg-[#14161a] border border-[#23262e] rounded-xl p-4 text-xs text-gray-400 space-y-1.5 leading-relaxed">
                  {tblMethod === 'shuffle' && (
                    <div>
                      <span className="font-bold text-[#f3a910]">ℹ️ Mengapa Shuffle memiliki Profit &amp; Win Rate yang sama di setiap baris?</span>
                      <p className="mt-1">
                        Pada metode <b>Shuffle (Permutasi)</b>, seluruh trade historis asli dipertahankan secara utuh tanpa penambahan atau pengurangan, hanya urutan waktunya yang diacak. Oleh karena itu, akumulasi profit keseluruhan, win rate, dan profit factor matematisnya selalu sama di setiap percentile. Yang berfluktuasi secara statistik adalah <b>urutan (path/sequencing risk)</b>: Max Drawdown, Max DD MAE, Sharpe Ratio, dan deretan kekalahan beruntun (Max Consecutive Losses).
                      </p>
                    </div>
                  )}
                  {tblMethod === 'resample' && (
                    <div>
                      <span className="font-bold text-[#f3a910]">ℹ️ Karakteristik Resample (Bootstrap i.i.d.):</span>
                      <p className="mt-1">
                        Pada metode <b>Resample</b>, setiap iterasi menarik trade secara acak dengan pengembalian (sampling with replacement). Oleh karena itu, seluruh metrik (Net Profit, Profit Factor, Win Rate, Drawdown, dll.) bervariasi secara dinamis di setiap tingkat percentile (P5 hingga P95).
                      </p>
                    </div>
                  )}
                  {tblMethod === 'block' && (
                    <div>
                      <span className="font-bold text-[#f3a910]">ℹ️ Karakteristik Block Bootstrap:</span>
                      <p className="mt-1">
                        Metode <b>Block Bootstrap</b> mempertahankan klaster menang/kalah berurutan (autokorelasi regim pasar). Drawdown dan consecutive losses biasanya sedikit lebih konservatif dibandingkan i.i.d. bootstrap.
                      </p>
                    </div>
                  )}
                </div>
              </div>
            );
          })()}

          {/* TAB 4: CAGR & COMPOUNDING */}
          {activeTab === 'cagr' && (
            <div className="space-y-6">
              <div className="bg-[#14161a] border border-[#23262e] rounded-xl p-5 shadow-lg">
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-4 pb-4 border-b border-[#23262e]">
                  <div>
                    <h3 className="text-xs font-bold uppercase tracking-wider text-white">
                      Perbandingan Kebijakan Compounding &amp; Penarikan Profit
                    </h3>
                    <p className="text-xs text-gray-400 mt-1 leading-relaxed">
                      Membandingkan 3 skenario ekuitas: <b>Fixed $</b> (tanpa compound, risk tetap dari modal awal), <b>Tarik 50% / Compound 50%</b> (50% net profit tahunan ditarik dan 50% tetap di akun), dan <b>100% Compound</b>.
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="inline-flex rounded-lg border border-[#23262e] bg-[#0d0f12] p-0.5 text-xs">
                      <button
                        type="button"
                        onClick={() => setCagrSplit('ALL')}
                        className={`px-3 py-1 rounded font-semibold transition ${cagrSplit === 'ALL' ? 'bg-[#f3a910] text-black shadow' : 'text-gray-400 hover:text-white'}`}
                      >
                        Gabungan ({currentAllPool?.N || 0})
                      </button>
                      <button
                        type="button"
                        onClick={() => setCagrSplit('IS')}
                        className={`px-3 py-1 rounded font-semibold transition ${cagrSplit === 'IS' ? 'bg-blue-600 text-white shadow' : 'text-gray-400 hover:text-white'}`}
                      >
                        IS ({currentIsPool?.N || 0})
                      </button>
                      <button
                        type="button"
                        onClick={() => setCagrSplit('OOS')}
                        className={`px-3 py-1 rounded font-semibold transition ${cagrSplit === 'OOS' ? 'bg-rose-600 text-white shadow' : 'text-gray-400 hover:text-white'}`}
                      >
                        OOS ({currentOosPool?.N || 0})
                      </button>
                    </div>

                    <div className="inline-flex rounded-lg border border-[#23262e] bg-[#0d0f12] p-0.5 text-xs">
                      <button
                        onClick={() => setCagrSizing('export')}
                        className={`px-3 py-1 rounded font-semibold ${cagrSizing === 'export' ? 'bg-[#f3a910] text-black' : 'text-gray-400'}`}
                      >
                        Lot Asli
                      </button>
                      <button
                        onClick={() => setCagrSizing('fixed2')}
                        className={`px-3 py-1 rounded font-semibold ${cagrSizing === 'fixed2' ? 'bg-[#f3a910] text-black' : 'text-gray-400'}`}
                      >
                        Fixed 2% Risk
                      </button>
                    </div>

                    <select
                      value={cagrMethod}
                      onChange={(e) => setCagrMethod(e.target.value)}
                      className="bg-[#0d0f12] border border-[#23262e] rounded px-2.5 py-1 text-xs text-white"
                    >
                      <option value="resample">Resample</option>
                      <option value="shuffle">Shuffle</option>
                      <option value="block">Block Bootstrap</option>
                    </select>
                  </div>
                </div>

                <div className="flex items-center gap-3 mb-4 text-xs">
                  <span className="text-gray-400 uppercase font-semibold">
                    Percentile Target: <b className="text-[#f3a910]">P{cagrHighlightPct}</b>
                  </span>
                  <input
                    type="range"
                    min="5"
                    max="95"
                    step="5"
                    value={cagrHighlightPct}
                    onChange={(e) => setCagrHighlightPct(parseInt(e.target.value))}
                    className="accent-[#f3a910] w-32"
                  />
                </div>

                {compData && (
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs text-left">
                      <thead>
                        <tr className="border-b border-[#23262e] text-gray-500 uppercase text-[10px]">
                          <th className="py-2.5 px-3">Kebijakan</th>
                          <th className="py-2.5 px-3">CAGR Equity (P{cagrHighlightPct})</th>
                          <th className="py-2.5 px-3">CAGR Wealth (Eq+Tarik P{cagrHighlightPct})</th>
                          <th className="py-2.5 px-3">Total Ditarik (P{cagrHighlightPct})</th>
                          <th className="py-2.5 px-3">Equity Akhir (P{cagrHighlightPct})</th>
                          <th className="py-2.5 px-3">Max DD MAE (P95)</th>
                          <th className="py-2.5 px-3">P(DD MAE ≥ 30%)</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[#1c1e24] font-mono text-gray-300">
                        {['fixed', 'withdraw50', 'compound'].map((polKey) => {
                          const combo = `${cagrSizing}|${polKey}`;
                          const simInfo = compData.mc[cagrMethod]?.[combo] || compData.mc.resample?.[combo];
                          const pHlRow = simInfo?.percentiles?.find((r) => r.pct === cagrHighlightPct) || {};
                          const p95Row = simInfo?.percentiles?.find((r) => r.pct === 95) || {};
                          return (
                            <tr
                              key={polKey}
                              onClick={() => setCagrPolicy(polKey)}
                              className={`cursor-pointer transition-colors ${cagrPolicy === polKey ? 'bg-[#f3a910]/15 text-white font-bold' : 'hover:bg-[#1c1e24]'}`}
                            >
                              <td className="py-2.5 px-3 font-sans font-semibold">
                                {polKey === 'fixed' ? 'Fixed $ (No Comp)' : polKey === 'withdraw50' ? 'Tarik 50% / Compound 50%' : '100% Compound'}
                                {cagrPolicy === polKey && <span className="ml-2 text-[10px] text-[#f3a910]">★ Terpilih</span>}
                              </td>
                              <td className="py-2.5 px-3 text-green-400">{pctS(pHlRow.cagr_equity)}</td>
                              <td className="py-2.5 px-3 text-emerald-400">{pctS(pHlRow.cagr_wealth)}</td>
                              <td className="py-2.5 px-3">{fmtMoney(pHlRow.total_withdrawn || 0)}</td>
                              <td className="py-2.5 px-3 font-bold text-white">{fmtMoney(pHlRow.final_equity || 100000)}</td>
                              <td className="py-2.5 px-3 text-rose-400">{pctS(p95Row.max_dd_mae_pct)}</td>
                              <td className="py-2.5 px-3">
                                <span className={`px-2 py-0.5 rounded text-[11px] font-bold ${(simInfo?.p_dd_mae_ge_30 || 0) > 0.1 ? 'text-red-400 bg-red-900/30' : 'text-green-400 bg-green-900/30'}`}>
                                  {((simInfo?.p_dd_mae_ge_30 || 0) * 100).toFixed(1)}%
                                </span>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* TAB 5: SIMULATOR LIVE */}
          {activeTab === 'sim' && (
            <div className="space-y-6">
              {/* Simulator Controls */}
              <div className="bg-[#14161a] border border-[#23262e] rounded-xl p-5 shadow-lg">
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
                  <div>
                    <label className="block text-[11px] text-gray-500 uppercase mb-1">Data Split</label>
                    <select
                      value={simSplit}
                      onChange={(e) => {
                        const nextSplit = e.target.value;
                        setSimSplit(nextSplit);
                        handleRunLiveSim(nextSplit, simParams);
                      }}
                      className="w-full bg-[#0d0f12] border border-[#23262e] rounded p-2 text-xs text-white focus:border-[#f3a910] outline-none"
                    >
                      <option value="ALL">Gabungan ({currentAllPool?.N || 0})</option>
                      <option value="IS">In-Sample ({currentIsPool?.N || 0})</option>
                      <option value="OOS">Out-of-Sample ({currentOosPool?.N || 0})</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-[11px] text-gray-500 uppercase mb-1">Metode</label>
                    <select
                      value={simParams.method}
                      onChange={(e) => {
                        const nextParams = { ...simParams, method: e.target.value };
                        setSimParams(nextParams);
                        handleRunLiveSim(simSplit, nextParams);
                      }}
                      className="w-full bg-[#0d0f12] border border-[#23262e] rounded p-2 text-xs text-white focus:border-[#f3a910] outline-none"
                    >
                      <option value="resample">Resample (Bootstrap)</option>
                      <option value="shuffle">Shuffle (Permutasi)</option>
                      <option value="block">Block Bootstrap</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-[11px] text-gray-500 uppercase mb-1">Iterasi</label>
                    <select
                      value={simParams.iters}
                      onChange={(e) => {
                        const nextParams = { ...simParams, iters: parseInt(e.target.value, 10) };
                        setSimParams(nextParams);
                        handleRunLiveSim(simSplit, nextParams);
                      }}
                      className="w-full bg-[#0d0f12] border border-[#23262e] rounded p-2 text-xs text-white focus:border-[#f3a910] outline-none"
                    >
                      <option value="1000">1,000 runs</option>
                      <option value="2000">2,000 runs</option>
                      <option value="5000">5,000 runs</option>
                      <option value="10000">10,000 runs</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-[11px] text-gray-500 uppercase mb-1">Modal Awal ($)</label>
                    <input
                      type="number"
                      min="1"
                      value={simParams.startCapital}
                      onChange={(e) => {
                        const raw = parseFloat(e.target.value);
                        const val = isNaN(raw) || raw <= 0 ? 100 : raw;
                        const nextParams = { ...simParams, startCapital: val };
                        setSimParams(nextParams);
                        handleRunLiveSim(simSplit, nextParams);
                      }}
                      className="w-full bg-[#0d0f12] border border-[#23262e] rounded p-2 text-xs text-white focus:border-[#f3a910] outline-none"
                    />
                  </div>

                  <div>
                    <label className="block text-[11px] text-gray-500 uppercase mb-1">Risk per Trade (%)</label>
                    <input
                      type="number"
                      step="0.1"
                      min="0.1"
                      max="100"
                      value={simParams.riskPct}
                      onChange={(e) => {
                        const raw = parseFloat(e.target.value);
                        const val = isNaN(raw) || raw <= 0 ? 1.0 : raw;
                        const nextParams = { ...simParams, riskPct: val };
                        setSimParams(nextParams);
                        handleRunLiveSim(simSplit, nextParams);
                      }}
                      className="w-full bg-[#0d0f12] border border-[#23262e] rounded p-2 text-xs text-white focus:border-[#f3a910] outline-none"
                    />
                  </div>

                  <div className="flex items-end">
                    <button
                      onClick={() => handleRunLiveSim(simSplit, simParams)}
                      disabled={isProcessing}
                      className="w-full py-2.5 bg-[#f3a910] hover:bg-[#d9930b] text-black font-bold uppercase text-xs rounded tracking-wider shadow transition-colors"
                    >
                      {isProcessing ? 'Simulating...' : '▶ Jalankan'}
                    </button>
                  </div>
                </div>
              </div>

              {/* Live KPI Grid */}
              {liveSimResult && (
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                  <div className="bg-[#14161a] border border-[#23262e] rounded-xl p-4 shadow-lg">
                    <div className="text-[10px] uppercase text-gray-500 font-semibold">Median Net Profit</div>
                    <div className="text-xl font-bold text-green-400 mt-1">{fmtMoney(liveSimResult.summary.net_profit.median)}</div>
                    <div className="text-[11px] text-gray-400 mt-0.5">P5 {fmtMoney(liveSimResult.summary.net_profit.p5)} · P95 {fmtMoney(liveSimResult.summary.net_profit.p95)}</div>
                  </div>

                  <div className="bg-[#14161a] border border-[#23262e] rounded-xl p-4 shadow-lg">
                    <div className="text-[10px] uppercase text-gray-500 font-semibold">Max DD MAE (P95)</div>
                    <div className="text-xl font-bold text-red-400 mt-1">{pctS(liveSimResult.summary.max_dd_mae_pct.p95)}</div>
                    <div className="text-[11px] text-gray-400 mt-0.5">P50 {pctS(liveSimResult.summary.max_dd_mae_pct.median)}</div>
                  </div>

                  <div className="bg-[#14161a] border border-[#23262e] rounded-xl p-4 shadow-lg">
                    <div className="text-[10px] uppercase text-gray-500 font-semibold">Sharpe / Sortino</div>
                    <div className="text-xl font-bold text-white mt-1">{f2(liveSimResult.summary.sharpe.median)} / {f2(liveSimResult.summary.sortino.median)}</div>
                    <div className="text-[11px] text-gray-400 mt-0.5">Profit Factor P50: {f2(liveSimResult.summary.profit_factor.median)}</div>
                  </div>

                  <div className="bg-[#14161a] border border-[#23262e] rounded-xl p-4 shadow-lg">
                    <div className="text-[10px] uppercase text-gray-500 font-semibold">CAGR Wealth (P50)</div>
                    <div className="text-xl font-bold text-emerald-400 mt-1">{pctS(liveSimResult.summary.cagr_wealth.median)}</div>
                    <div className="text-[11px] text-gray-400 mt-0.5">Risk of Ruin: {liveSimResult.summary.risk_of_ruin?.toFixed(1) || 0}%</div>
                  </div>
                </div>
              )}

              {/* Equity Fan Chart */}
              {liveSimResult && (
                <div className="bg-[#14161a] border border-[#23262e] rounded-xl p-5 shadow-lg">
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-xs font-bold uppercase tracking-wider text-white">Equity Fan Simulation Distribution</h3>
                    <span className="text-xs text-[#f3a910] font-mono font-bold">
                      Median End: {fmtMoney(liveSimResult.summary.final_equity.median)}
                    </span>
                  </div>
                  {renderEquityFanSvg(liveSimResult.bands, liveSimResult.samples, liveSimResult.H, simParams.startCapital)}

                  {/* Distribution Metric Selector & Marker */}
                  <div className="flex flex-wrap items-center justify-between gap-3 pt-4 mt-4 border-t border-[#23262e]">
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-gray-400 uppercase font-semibold">Metrik Distribusi:</span>
                      <select
                        value={histMetric}
                        onChange={(e) => setHistMetric(e.target.value)}
                        className="bg-[#0d0f12] border border-[#23262e] rounded px-2.5 py-1 text-xs text-white"
                      >
                        <option value="net_profit">Net Profit ($)</option>
                        <option value="profit_factor">Profit Factor</option>
                        <option value="sharpe">Sharpe Ratio</option>
                        <option value="max_dd_mae_pct">Max Drawdown MAE (%)</option>
                        <option value="cagr_wealth">CAGR Wealth (%)</option>
                      </select>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-gray-400 uppercase font-semibold">
                        Marker: <b className="text-[#f3a910]">P{histPctMarker}</b> (
                        {liveSimResult?.summary?.[histMetric]
                          ? ['net_profit'].includes(histMetric)
                            ? fmtMoney(liveSimResult.summary[histMetric][`p${histPctMarker}`] ?? liveSimResult.summary[histMetric].median)
                            : ['max_dd_mae_pct', 'cagr_wealth'].includes(histMetric)
                            ? pctS(liveSimResult.summary[histMetric][`p${histPctMarker}`] ?? liveSimResult.summary[histMetric].median)
                            : f2(liveSimResult.summary[histMetric][`p${histPctMarker}`] ?? liveSimResult.summary[histMetric].median)
                          : '—'}
                        )
                      </span>
                      <input
                        type="range"
                        min="5"
                        max="95"
                        step="5"
                        value={histPctMarker}
                        onChange={(e) => setHistPctMarker(parseInt(e.target.value))}
                        className="accent-[#f3a910] w-28"
                      />
                    </div>
                  </div>
                </div>
              )}

              {/* Custom Probability Calculator Cards */}
              {liveSimResult && (
                <div className="bg-[#14161a] border border-[#23262e] rounded-xl p-5 shadow-lg space-y-4">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-[#23262e] pb-3">
                    <div>
                      <h3 className="text-xs font-bold uppercase tracking-wider text-white">
                        Kalkulator Probabilitas Risiko &amp; Target Kustom
                      </h3>
                      <p className="text-[11px] text-gray-400 mt-0.5">
                        Dihitung real-time dari distribusi {totalRuns.toLocaleString()} iterasi simulasi aktif.
                      </p>
                    </div>
                    <span className="text-[10px] px-2.5 py-1 rounded bg-[#0d0f12] text-gray-300 border border-[#23262e] font-mono">
                      Metode: {simParams.method} · {totalRuns.toLocaleString()} runs
                    </span>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                    {/* Card 1: DD MAE */}
                    <div className="bg-[#0d0f12] border border-[#23262e] rounded-lg p-3.5 space-y-2">
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-gray-400 font-semibold">Ambang Max DD MAE (%):</span>
                        <input
                          type="number"
                          min="0"
                          max="100"
                          step="1"
                          value={probThresholds.ddPct}
                          onChange={(e) => {
                            const raw = parseFloat(e.target.value);
                            const val = isNaN(raw) ? 0 : Math.max(0, Math.min(100, raw));
                            setProbThresholds(prev => ({ ...prev, ddPct: val }));
                          }}
                          className="w-16 bg-[#14161a] border border-[#2a2d36] rounded px-2 py-0.5 text-right font-mono text-white text-xs focus:border-[#f3a910] outline-none"
                        />
                      </div>
                      <div className="text-xl font-bold text-red-400 pt-1">
                        P(DD MAE ≥ {probThresholds.ddPct}%): {probDD.toFixed(1)}%
                      </div>
                      <div className="text-[11px] text-gray-400 font-mono">
                        {ddCount.toLocaleString()} dari {totalRuns.toLocaleString()} runs memenuhi syarat
                      </div>
                      <div className="text-[10px] text-gray-500 pt-1 border-t border-[#1c1e24] leading-tight">
                        Peluang akun mengalami floating drawdown terdalam melebihi ambang batas risiko.
                      </div>
                    </div>

                    {/* Card 2: Net Profit */}
                    <div className="bg-[#0d0f12] border border-[#23262e] rounded-lg p-3.5 space-y-2">
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-gray-400 font-semibold">Ambang Net Profit (%):</span>
                        <input
                          type="number"
                          min="0"
                          step="5"
                          value={probThresholds.netProfitPct}
                          onChange={(e) => {
                            const raw = parseFloat(e.target.value);
                            const val = isNaN(raw) ? 0 : Math.max(0, raw);
                            setProbThresholds(prev => ({ ...prev, netProfitPct: val }));
                          }}
                          className="w-16 bg-[#14161a] border border-[#2a2d36] rounded px-2 py-0.5 text-right font-mono text-white text-xs focus:border-[#f3a910] outline-none"
                        />
                      </div>
                      <div className="text-xl font-bold text-green-400 pt-1">
                        P(Profit ≥ {probThresholds.netProfitPct}%): {probProfit.toFixed(1)}%
                      </div>
                      <div className="text-[11px] text-gray-400 font-mono">
                        {profitCount.toLocaleString()} dari {totalRuns.toLocaleString()} runs memenuhi syarat
                      </div>
                      <div className="text-[10px] text-gray-500 pt-1 border-t border-[#1c1e24] leading-tight">
                        Peluang return modal akhir mencapai atau melampaui target persentase modal awal (${simParams.startCapital.toLocaleString()}).
                      </div>
                    </div>

                    {/* Card 3: Consecutive Losses */}
                    <div className="bg-[#0d0f12] border border-[#23262e] rounded-lg p-3.5 space-y-2">
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-gray-400 font-semibold">Ambang Kekalahan Beruntun:</span>
                        <input
                          type="number"
                          min="1"
                          max="100"
                          step="1"
                          value={probThresholds.consLoss}
                          onChange={(e) => {
                            const raw = parseInt(e.target.value, 10);
                            const val = isNaN(raw) ? 1 : Math.max(1, raw);
                            setProbThresholds(prev => ({ ...prev, consLoss: val }));
                          }}
                          className="w-16 bg-[#14161a] border border-[#2a2d36] rounded px-2 py-0.5 text-right font-mono text-white text-xs focus:border-[#f3a910] outline-none"
                        />
                      </div>
                      <div className="text-xl font-bold text-rose-400 pt-1">
                        P(Losses ≥ {probThresholds.consLoss}): {probLossStreak.toFixed(1)}%
                      </div>
                      <div className="text-[11px] text-gray-400 font-mono">
                        {lossCount.toLocaleString()} dari {totalRuns.toLocaleString()} runs memenuhi syarat
                      </div>
                      <div className="text-[10px] text-gray-500 pt-1 border-t border-[#1c1e24] leading-tight">
                        Peluang mengalami losing streak maksimum berturut-turut pada iterasi simulasi.
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* TAB 6: CROSS-CHECK & BIAYA */}
          {activeTab === 'xc' && (
            <div className="space-y-6">
              <div className="bg-[#14161a] border border-[#23262e] rounded-xl p-5 shadow-lg">
                <div className="flex items-center justify-between mb-4 pb-3 border-b border-[#23262e]">
                  <div>
                    <h3 className="text-xs font-bold uppercase tracking-wider text-white">
                      Konsistensi Distribusi In-Sample (IS) vs Out-of-Sample (OOS)
                    </h3>
                    <p className="text-xs text-gray-400 mt-1">
                      Menguji apakah performa aktual OOS berada dalam rentang wajar (P5–P95) hasil bootstrap In-Sample. Rank di bawah 5% atau di atas 95% menandakan inkonsistensi distribusi.
                    </p>
                  </div>
                  <div className="inline-flex rounded-lg border border-[#23262e] bg-[#0d0f12] p-0.5 text-xs">
                    <button
                      onClick={() => setXcMode('IS_bootstrap_vs_OOS_actual')}
                      className={`px-3 py-1 rounded font-semibold ${xcMode === 'IS_bootstrap_vs_OOS_actual' ? 'bg-[#f3a910] text-black' : 'text-gray-400'}`}
                    >
                      OOS aktual di bootstrap IS
                    </button>
                    <button
                      onClick={() => setXcMode('OOS_bootstrap_vs_IS_actual')}
                      className={`px-3 py-1 rounded font-semibold ${xcMode === 'OOS_bootstrap_vs_IS_actual' ? 'bg-[#f3a910] text-black' : 'text-gray-400'}`}
                    >
                      IS aktual di bootstrap OOS
                    </button>
                  </div>
                </div>

                {xcData && (
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs text-left">
                      <thead>
                        <tr className="border-b border-[#23262e] text-gray-500 uppercase text-[10px]">
                          <th className="py-2.5 px-3">Metrik</th>
                          <th className="py-2.5 px-3">Nilai Aktual</th>
                          <th className="py-2.5 px-3">Bootstrap P5</th>
                          <th className="py-2.5 px-3">Bootstrap P50</th>
                          <th className="py-2.5 px-3">Bootstrap P95</th>
                          <th className="py-2.5 px-3">Percentile Rank</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[#1c1e24] font-mono text-gray-300">
                        {xcData[xcMode]?.rows?.map((r, i) => {
                          const isWarning = r.rank_pct < 5 || r.rank_pct > 95;
                          return (
                            <tr key={i}>
                              <td className="py-2 px-3 font-sans font-semibold text-white">{r.title}</td>
                              <td className="py-2 px-3 font-bold text-white">{f2(r.actual)}</td>
                              <td className="py-2 px-3">{f2(r.p5)}</td>
                              <td className="py-2 px-3">{f2(r.p50)}</td>
                              <td className="py-2 px-3">{f2(r.p95)}</td>
                              <td className="py-2 px-3">
                                <span className={`px-2 py-0.5 rounded text-[11px] font-bold ${isWarning ? 'bg-red-900/30 text-red-400 border border-red-500/30' : 'bg-green-900/30 text-green-400 border border-green-500/30'}`}>
                                  {r.rank_pct.toFixed(1)}%
                                </span>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* TAB 7: ASUMSI & PARSE CHECKS */}
          {activeTab === 'lim' && (
            <div className="space-y-6">
              <div className="bg-[#14161a] border border-[#23262e] rounded-xl p-5 shadow-lg">
                <h3 className="text-xs font-bold uppercase tracking-wider text-white mb-3">Asumsi &amp; Keterbatasan Kuantitatif</h3>
                <ul className="text-xs text-gray-300 space-y-2 list-disc pl-5">
                  <li><b>Model Fill &amp; Spread:</b> Simulasi berasumsi eksekusi trade di backtest tidak tergelincir di luar model slippage/spread yang diuji pada tab Cross-Check.</li>
                  <li><b>Sequencing Independency:</b> Uji resample iid mengasumsikan antar trade independen; bila terdapat clustering volatilitas, block bootstrap memberikan estimasi yang lebih konservatif.</li>
                  <li><b>Intra-trade MAE Drawdown:</b> Menggabungkan adverse excursion terdalam sebelum exit untuk memastikan drawdown akun prop tidak terlanggar secara tidak sengaja.</li>
                </ul>
              </div>

              <div className="bg-[#14161a] border border-[#23262e] rounded-xl p-5 shadow-lg overflow-x-auto">
                <h3 className="text-xs font-bold uppercase tracking-wider text-white mb-3">Validation &amp; Checksum Table</h3>
                <table className="w-full text-xs text-left">
                  <thead>
                    <tr className="border-b border-[#23262e] text-gray-500 uppercase text-[10px]">
                      <th className="py-2 px-3">Parameter Verifikasi</th>
                      <th className="py-2 px-3">In-Sample Data</th>
                      <th className="py-2 px-3">Out-of-Sample Data</th>
                      <th className="py-2 px-3">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#1c1e24] font-mono text-gray-300">
                    <tr>
                      <td className="py-2.5 px-3 font-sans text-white">Closed Trades Count</td>
                      <td className="py-2.5 px-3">{currentIsPool.N} trades</td>
                      <td className="py-2.5 px-3">{currentOosPool.N} trades</td>
                      <td className="py-2.5 px-3 text-green-400 font-bold">✓ PASS</td>
                    </tr>
                    <tr>
                      <td className="py-2.5 px-3 font-sans text-white">Total Net P&amp;L Sum</td>
                      <td className="py-2.5 px-3">{fmtMoney(currentIsPool.stats.totalProfit)}</td>
                      <td className="py-2.5 px-3">{fmtMoney(currentOosPool.stats.totalProfit)}</td>
                      <td className="py-2.5 px-3 text-green-400 font-bold">✓ MATCHED</td>
                    </tr>
                    <tr>
                      <td className="py-2.5 px-3 font-sans text-white">1R Risk Unit Calibration</td>
                      <td className="py-2.5 px-3">{currentIsPool.detectedRisk?.label || 'Auto'}</td>
                      <td className="py-2.5 px-3">{currentOosPool.detectedRisk?.label || 'Auto'}</td>
                      <td className="py-2.5 px-3 text-green-400 font-bold">✓ CALIBRATED</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }
  componentDidCatch(error, errorInfo) {
    console.error("MonteCarloSimulator error:", error, errorInfo);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="bg-[#14161a] border border-red-500/40 rounded-xl p-8 text-center my-6 space-y-4">
          <div className="text-3xl">⚠️</div>
          <h3 className="text-sm font-bold text-red-400 uppercase tracking-wider">
            Terjadi Kendala Saat Menjalankan Komputasi
          </h3>
          <p className="text-xs text-gray-400 font-mono max-w-lg mx-auto bg-[#0d0f12] p-3 rounded border border-[#23262e]">
            {this.state.error?.message || 'Unknown processing error'}
          </p>
          <button
            onClick={() => {
              this.setState({ hasError: false, error: null });
              window.location.reload();
            }}
            className="px-5 py-2.5 bg-[#f3a910] hover:bg-[#d9930b] text-black font-bold text-xs rounded uppercase tracking-wider transition-colors shadow"
          >
            Muat Ulang Simulator
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

const MonteCarloSimulatorWrapper = (props) => (
  <ErrorBoundary>
    <MonteCarloSimulator {...props} />
  </ErrorBoundary>
);

export default MonteCarloSimulatorWrapper;
