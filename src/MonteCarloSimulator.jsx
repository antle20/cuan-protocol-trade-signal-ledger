import React, { useState, useRef } from 'react';
import { parseTradeFile, buildDatasetFromSupabase, buildTradeDataset, combineDatasets, splitDataset } from './tradeFileParser';
import { simulate } from './monteCarloCore';
import { generateHtmlReport } from './exportHtmlReport';

// Pre-packaged demo data for users wanting a quick preview
const SAMPLE_DEMO_TRADES = [
  2.1, -1.0, 1.8, -1.0, 3.2, -1.0, -1.0, 2.5, 1.2, -1.0,
  4.0, -1.0, 1.5, -1.0, -1.0, 2.0, 3.5, -1.0, 1.1, -1.0,
  -1.0, 2.8, 1.9, -1.0, 3.0, -1.0, 2.2, -1.0, -1.0, 1.7,
  2.4, -1.0, -1.0, 4.5, -1.0, 1.3, -1.0, 2.0, -1.0, 3.1
].map((r, i) => ({
  index: i + 1,
  date: new Date(2020 + Math.floor(i / 10), (i % 12), (i % 28) + 1),
  profit: r * 100,
  r,
  symbol: 'DEMO/USD',
}));

const MonteCarloSimulator = ({ supabaseTrades = [] }) => {
  // Datasets for In-Sample (IS), Out-of-Sample (OOS), and Combined (ALL)
  const [isDataset, setIsDataset] = useState(null);
  const [oosDataset, setOosDataset] = useState(null);
  const [activeView, setActiveView] = useState('ALL'); // 'ALL' | 'IS' | 'OOS' | 'COMPARE'

  // Starts as null for clean, professional onboarding UX
  const [currentDataset, setCurrentDataset] = useState(null);
  const [simResult, setSimResult] = useState(null);
  const [isSimResult, setIsSimResult] = useState(null);
  const [oosSimResult, setOosSimResult] = useState(null);

  const [isProcessing, setIsProcessing] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [splitOption, setSplitOption] = useState('70-30'); // '70-30' | '80-20' | '50-50' | '2022'
  const [isDragging, setIsDragging] = useState(false);

  const [params, setParams] = useState({
    startCapital: 10000,
    riskPct: 1.0,
    iters: 2000,
    method: 'resample',
    policy: 'compound',
    haircut: 0.0,
  });

  const fileInputUnifiedRef = useRef(null);
  const fileInputIsRef = useRef(null);
  const fileInputOosRef = useRef(null);

  // Run simulation on a dataset
  const runSim = (ds, customParams = params) => {
    if (!ds || ds.R.length === 0) return null;
    return simulate(ds, {
      iters: customParams.iters,
      start: customParams.startCapital,
      riskPct: customParams.riskPct,
      method: customParams.method,
      policy: customParams.policy,
      haircut: customParams.haircut,
    });
  };

  // Handle upload of Unified / Single file
  const handleProcessFile = async (file) => {
    if (!file) return;
    setErrorMsg('');
    setIsProcessing(true);
    try {
      const parsed = await parseTradeFile(file);

      if (parsed.sampleTag === 'IS') {
        setIsDataset(parsed);
        setCurrentDataset(parsed);
        const res = runSim(parsed);
        setIsSimResult(res);
        setSimResult(res);
        setActiveView('IS');
      } else if (parsed.sampleTag === 'OOS') {
        setOosDataset(parsed);
        setCurrentDataset(parsed);
        const res = runSim(parsed);
        setOosSimResult(res);
        setSimResult(res);
        setActiveView('OOS');
      } else {
        const has2022 = parsed.startDate.getFullYear() < 2022 && parsed.endDate.getFullYear() >= 2022;
        const { isDataset: isDs, oosDataset: oosDs } = splitDataset(
          parsed,
          has2022 ? 'date' : 'ratio',
          has2022 ? '2022-01-01' : 0.7
        );

        setIsDataset(isDs);
        setOosDataset(oosDs);
        setCurrentDataset(parsed);

        const resAll = runSim(parsed);
        setSimResult(resAll);
        if (isDs) setIsSimResult(runSim(isDs));
        if (oosDs) setOosSimResult(runSim(oosDs));
        setActiveView('ALL');
      }
    } catch (err) {
      console.error(err);
      setErrorMsg(err.message || 'Failed to parse file.');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleUnifiedUpload = async (e) => {
    const file = e.target.files?.[0];
    await handleProcessFile(file);
    if (e.target) e.target.value = '';
  };

  // Drag & drop handlers for the Hero Dropzone
  const handleDragOver = (e) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = async (e) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    await handleProcessFile(file);
  };

  // Handle upload of specific In-Sample file (File A)
  const handleIsUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setErrorMsg('');
    setIsProcessing(true);
    try {
      const parsed = await parseTradeFile(file);
      parsed.sourceName = `${file.name} (In-Sample)`;
      parsed.sampleTag = 'IS';
      setIsDataset(parsed);

      const resIs = runSim(parsed);
      setIsSimResult(resIs);

      if (oosDataset) {
        const combined = combineDatasets(parsed, oosDataset);
        setCurrentDataset(combined);
        setSimResult(runSim(combined));
        setActiveView('COMPARE');
      } else {
        setCurrentDataset(parsed);
        setSimResult(resIs);
        setActiveView('IS');
      }
    } catch (err) {
      setErrorMsg(err.message || 'Failed to parse In-Sample file.');
    } finally {
      setIsProcessing(false);
      if (e.target) e.target.value = '';
    }
  };

  // Handle upload of specific Out-of-Sample file (File B)
  const handleOosUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setErrorMsg('');
    setIsProcessing(true);
    try {
      const parsed = await parseTradeFile(file);
      parsed.sourceName = `${file.name} (Out-of-Sample)`;
      parsed.sampleTag = 'OOS';
      setOosDataset(parsed);

      const resOos = runSim(parsed);
      setOosSimResult(resOos);

      if (isDataset) {
        const combined = combineDatasets(isDataset, parsed);
        setCurrentDataset(combined);
        setSimResult(runSim(combined));
        setActiveView('COMPARE');
      } else {
        setCurrentDataset(parsed);
        setSimResult(resOos);
        setActiveView('OOS');
      }
    } catch (err) {
      setErrorMsg(err.message || 'Failed to parse Out-of-Sample file.');
    } finally {
      setIsProcessing(false);
      if (e.target) e.target.value = '';
    }
  };

  // Load from Supabase ledger
  const handleLoadFromSupabase = () => {
    setErrorMsg('');
    try {
      if (!supabaseTrades || supabaseTrades.length === 0) {
        throw new Error('No trades found in current active ledger.');
      }
      const parsed = buildDatasetFromSupabase(supabaseTrades);
      setCurrentDataset(parsed);
      setIsDataset(null);
      setOosDataset(null);
      setActiveView('ALL');

      const res = runSim(parsed);
      setSimResult(res);
    } catch (err) {
      setErrorMsg(err.message || 'Failed to load trades from Supabase.');
    }
  };

  // Load sample demo data on explicit user request
  const handleLoadDemo = () => {
    setErrorMsg('');
    const demo = buildTradeDataset(SAMPLE_DEMO_TRADES, 'Sample Gotobi Demo Data', 'ALL');
    const { isDataset: isDs, oosDataset: oosDs } = splitDataset(demo, 'ratio', 0.7);
    setIsDataset(isDs);
    setOosDataset(oosDs);
    setCurrentDataset(demo);
    const res = runSim(demo);
    setSimResult(res);
    if (isDs) setIsSimResult(runSim(isDs));
    if (oosDs) setOosSimResult(runSim(oosDs));
    setActiveView('ALL');
  };

  // Reset to clean empty state
  const handleReset = () => {
    setIsDataset(null);
    setOosDataset(null);
    setIsSimResult(null);
    setOosSimResult(null);
    setCurrentDataset(null);
    setSimResult(null);
    setActiveView('ALL');
    setErrorMsg('');
  };

  const handleSplitOptionChange = (newOption) => {
    setSplitOption(newOption);
    const baseDataset = isDataset && oosDataset ? combineDatasets(isDataset, oosDataset) : currentDataset;
    if (!baseDataset || baseDataset.trades.length < 4) return;

    let isDs = null;
    let oosDs = null;
    if (newOption === '2022') {
      const s = splitDataset(baseDataset, 'date', '2022-01-01');
      isDs = s.isDataset;
      oosDs = s.oosDataset;
    } else if (newOption === '50-50') {
      const s = splitDataset(baseDataset, 'ratio', 0.5);
      isDs = s.isDataset;
      oosDs = s.oosDataset;
    } else if (newOption === '80-20') {
      const s = splitDataset(baseDataset, 'ratio', 0.8);
      isDs = s.isDataset;
      oosDs = s.oosDataset;
    } else {
      const s = splitDataset(baseDataset, 'ratio', 0.7);
      isDs = s.isDataset;
      oosDs = s.oosDataset;
    }

    setIsDataset(isDs);
    setOosDataset(oosDs);
    if (isDs) setIsSimResult(runSim(isDs));
    if (oosDs) setOosSimResult(runSim(oosDs));
  };

  const handleSwitchView = (view) => {
    setActiveView(view);
    if (view === 'IS' && isDataset) {
      setCurrentDataset(isDataset);
      setSimResult(isSimResult || runSim(isDataset));
    } else if (view === 'OOS' && oosDataset) {
      setCurrentDataset(oosDataset);
      setSimResult(oosSimResult || runSim(oosDataset));
    } else if (view === 'ALL') {
      if (isDataset && oosDataset) {
        const combined = combineDatasets(isDataset, oosDataset);
        setCurrentDataset(combined);
        setSimResult(runSim(combined));
      }
    }
  };

  const handleRunSimulation = () => {
    if (!currentDataset || currentDataset.R.length === 0) {
      setErrorMsg('Please upload a file or load trades first.');
      return;
    }

    setIsProcessing(true);
    setErrorMsg('');
    setTimeout(() => {
      try {
        setSimResult(runSim(currentDataset));
        if (isDataset) setIsSimResult(runSim(isDataset));
        if (oosDataset) setOosSimResult(runSim(oosDataset));
      } catch (err) {
        setErrorMsg(err.message || 'Simulation error.');
      } finally {
        setIsProcessing(false);
      }
    }, 50);
  };

  const handleDownloadReport = () => {
    if (!simResult || !currentDataset) return;
    const htmlContent = generateHtmlReport(currentDataset, simResult, params);
    const blob = new Blob([htmlContent], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `monte-carlo-report-${currentDataset.sourceName.replace(/[^a-zA-Z0-9]/g, '_')}.html`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Overfitting & Degradation calculations
  const calculateRobustness = () => {
    if (!isDataset || !oosDataset || !isSimResult || !oosSimResult) return null;
    const isPf = parseFloat(isDataset.stats.profitFactor) || 1;
    const oosPf = parseFloat(oosDataset.stats.profitFactor) || 1;
    const isWr = parseFloat(isDataset.stats.winRate) || 1;
    const oosWr = parseFloat(oosDataset.stats.winRate) || 1;
    const isSharpe = isSimResult.summary.sharpe.median || 1;
    const oosSharpe = oosSimResult.summary.sharpe.median || 1;

    const pfRetention = Math.round((oosPf / isPf) * 100);
    const sharpeRetention = isSharpe > 0 ? Math.round((oosSharpe / isSharpe) * 100) : 0;
    const wrDiff = (oosWr - isWr).toFixed(1);

    let status = 'HEALTHY & ROBUST';
    let statusColor = 'text-green-400 border-green-500/40 bg-green-900/20';
    let description = 'Strategi mempertahankan efisiensi yang konsisten antara data In-Sample dan Out-of-Sample.';

    if (pfRetention < 60 || sharpeRetention < 50) {
      status = 'OVERFITTING WARNING';
      statusColor = 'text-red-400 border-red-500/40 bg-red-900/20';
      description = 'Performa Out-of-Sample turun drastis di bawah 60%. Indikasi parameter over-optimized (curve-fitted).';
    } else if (pfRetention < 80) {
      status = 'MODERATE DEGRADATION';
      statusColor = 'text-yellow-400 border-yellow-500/40 bg-yellow-900/20';
      description = 'Ada penurunan performa wajar di Out-of-Sample, namun strategi tetap menguntungkan.';
    }

    return { pfRetention, sharpeRetention, wrDiff, status, statusColor, description };
  };

  const robustness = calculateRobustness();

  // Render SVG Chart
  const renderChart = () => {
    if (!simResult || !simResult.bands) return null;
    const { bands, samples, H, start } = simResult;
    const width = 800;
    const height = 300;
    const padX = 60;
    const padY = 30;
    const chartW = width - padX * 2;
    const chartH = height - padY * 2;

    let minY = start;
    let maxY = start;
    for (let j = 0; j < H; j++) {
      if (isFinite(bands[5][j]) && bands[5][j] < minY) minY = bands[5][j];
      if (isFinite(bands[95][j]) && bands[95][j] > maxY) maxY = bands[95][j];
    }
    minY = Math.max(0, minY * 0.9);
    maxY = maxY * 1.1;
    const rangeY = Math.max(1, maxY - minY);

    const getX = (j) => (padX + (j / Math.max(1, H - 1)) * chartW).toFixed(1);
    const getY = (val) => {
      const clamped = Math.max(minY, Math.min(maxY, isFinite(val) ? val : minY));
      return (padY + chartH - ((clamped - minY) / rangeY) * chartH).toFixed(1);
    };

    let band95Path = `M ${getX(0)} ${getY(bands[95][0])}`;
    for (let j = 1; j < H; j++) band95Path += ` L ${getX(j)} ${getY(bands[95][j])}`;
    for (let j = H - 1; j >= 0; j--) band95Path += ` L ${getX(j)} ${getY(bands[5][j])}`;
    band95Path += ' Z';

    let band75Path = `M ${getX(0)} ${getY(bands[75][0])}`;
    for (let j = 1; j < H; j++) band75Path += ` L ${getX(j)} ${getY(bands[75][j])}`;
    for (let j = H - 1; j >= 0; j--) band75Path += ` L ${getX(j)} ${getY(bands[25][j])}`;
    band75Path += ' Z';

    let medianPath = `M ${getX(0)} ${getY(bands[50][0])}`;
    for (let j = 1; j < H; j++) medianPath += ` L ${getX(j)} ${getY(bands[50][j])}`;

    return (
      <div className="w-full overflow-x-auto">
        <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-auto bg-[#0d0f12] rounded border border-[#23262e]">
          {[0, 0.25, 0.5, 0.75, 1.0].map((t, idx) => {
            const val = minY + (1 - t) * rangeY;
            const y = padY + t * chartH;
            return (
              <g key={idx}>
                <line x1={padX} y1={y} x2={width - padX} y2={y} stroke="#1f232b" strokeDasharray="3 3" />
                <text x={padX - 8} y={y + 3} textAnchor="end" fill="#6b7280" fontSize="10" fontFamily="monospace">
                  ${Math.round(val).toLocaleString()}
                </text>
              </g>
            );
          })}

          <path d={band95Path} fill="#f3a910" fillOpacity="0.12" />
          <path d={band75Path} fill="#f3a910" fillOpacity="0.22" />

          {samples.slice(0, 15).map((sArr, idx) => {
            let path = `M ${getX(0)} ${getY(sArr[0])}`;
            for (let j = 1; j < H; j++) path += ` L ${getX(j)} ${getY(sArr[j])}`;
            return (
              <path
                key={idx}
                d={path}
                fill="none"
                stroke={activeView === 'IS' ? '#38bdf8' : activeView === 'OOS' ? '#f43f5e' : '#f3a910'}
                strokeWidth="1"
                strokeOpacity="0.25"
              />
            );
          })}

          <path d={medianPath} fill="none" stroke="#f3a910" strokeWidth="2.5" />

          <line
            x1={padX}
            y1={getY(start)}
            x2={width - padX}
            y2={getY(start)}
            stroke="#9ca3af"
            strokeDasharray="2 2"
            strokeOpacity="0.5"
          />

          <text x={padX} y={height - 10} fill="#6b7280" fontSize="10">
            {currentDataset.stats.startDateStr || 'Trade 1'}
          </text>
          <text x={width / 2} y={height - 10} textAnchor="middle" fill="#6b7280" fontSize="10">
            {H} Trades
          </text>
          <text x={width - padX} y={height - 10} textAnchor="end" fill="#6b7280" fontSize="10">
            {currentDataset.stats.endDateStr || `Trade ${H}`}
          </text>
        </svg>

        <div className="flex flex-wrap items-center justify-between text-[11px] text-gray-500 mt-2 px-1">
          <div className="flex items-center gap-4">
            <span className="flex items-center gap-1.5">
              <span className="w-3 h-3 rounded bg-[#f3a910] opacity-30 inline-block"></span> 5th–95th %tile Band
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-3 h-0.5 bg-[#f3a910] inline-block"></span> Median Equity
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-3 h-0.5 bg-[#38bdf8] opacity-60 inline-block"></span> Sample Paths
            </span>
          </div>
          <div>Simulated Horizon: {H} Trades · {simResult.S.toLocaleString()} Iterations</div>
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-6">
      {/* Hidden file inputs */}
      <input type="file" ref={fileInputUnifiedRef} onChange={handleUnifiedUpload} accept=".csv,.xlsx,.xls" className="hidden" />
      <input type="file" ref={fileInputIsRef} onChange={handleIsUpload} accept=".csv,.xlsx,.xls" className="hidden" />
      <input type="file" ref={fileInputOosRef} onChange={handleOosUpload} accept=".csv,.xlsx,.xls" className="hidden" />

      {/* ========================================================================= */}
      {/* STATE 1: EMPTY / HERO ONBOARDING DROPZONE (When no file uploaded yet)     */}
      {/* ========================================================================= */}
      {!currentDataset && (
        <div className="bg-[#14161a] border border-[#23262e] rounded-xl p-8 sm:p-12 shadow-2xl text-center">
          <div
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            className={`border-2 border-dashed rounded-xl p-8 sm:p-14 transition-all duration-200 flex flex-col items-center justify-center ${
              isDragging ? 'border-[#f3a910] bg-[#f3a910]/5 scale-[0.99]' : 'border-[#2a2d36] hover:border-[#3d4250] bg-[#0d0f12]/50'
            }`}
          >
            <div className="w-16 h-16 rounded-full bg-[#1c1e24] border border-[#2a2d36] flex items-center justify-center text-3xl mb-5 shadow-inner">
              📊
            </div>

            <h2 className="text-xl font-bold text-white tracking-wide">
              UPLOAD STRATEGY OR BACKTEST REPORT
            </h2>
            <p className="text-xs text-gray-400 mt-2 max-w-md leading-relaxed">
              Drag &amp; drop file hasil backtest MetaTrader 5 / MetaTrader 4 (<span className="text-gray-200 font-mono">.xlsx, .csv</span>) untuk menjalankan simulasi Monte Carlo &amp; analisis ketahanan strategi.
            </p>

            {errorMsg && (
              <div className="mt-4 p-3 rounded bg-red-900/20 border border-red-500/40 text-red-400 text-xs max-w-lg">
                {errorMsg}
              </div>
            )}

            {/* Quick Action Buttons */}
            <div className="flex flex-wrap items-center justify-center gap-3 mt-8">
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
                title="Upload file In-Sample (contoh: 2016-2021_A atau 2024)"
              >
                <span>📥</span>
                <span>Upload IS (File A)</span>
              </button>

              <button
                onClick={() => fileInputOosRef.current?.click()}
                disabled={isProcessing}
                className="bg-rose-900/20 hover:bg-rose-900/40 text-rose-300 border border-rose-500/40 px-4 py-3 rounded-lg text-xs font-semibold tracking-wide transition-all flex items-center gap-2"
                title="Upload file Out-of-Sample (contoh: 2022-2026_B atau 2025/2026)"
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

            {/* Demo Option Link */}
            <div className="mt-8 pt-6 border-t border-[#1c1e24] flex items-center gap-2 text-xs text-gray-500">
              <span>Belum punya file laporan trading?</span>
              <button
                onClick={handleLoadDemo}
                className="text-[#f3a910] hover:underline font-semibold flex items-center gap-1"
              >
                <span>🧪 Coba dengan Demo Data</span>
              </button>
            </div>
          </div>

          <div className="mt-6 flex flex-wrap items-center justify-center gap-6 text-[11px] text-gray-500 uppercase tracking-widest font-mono">
            <span>✓ MT5 Deals (.xlsx)</span>
            <span>✓ MT4 Statements</span>
            <span>✓ CSV / Excel Journal</span>
            <span>✓ Auto-Detect 1R (Pips / USD)</span>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* STATE 2: ACTIVE RESULTS VIEW (When files are uploaded or demo is loaded)  */}
      {/* ========================================================================= */}
      {currentDataset && simResult && (
        <>
          {/* Top Header & Re-upload Bar */}
          <div className="bg-[#14161a] border border-[#23262e] rounded-lg p-6 shadow-xl">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-5 border-b border-[#23262e]">
              <div>
                <h2 className="text-lg font-bold text-white tracking-wide flex items-center gap-2">
                  <span>MONTE CARLO SIMULATOR</span>
                  <span className="text-[10px] px-2 py-0.5 rounded uppercase font-semibold bg-[#f3a910]/20 text-[#f3a910] border border-[#f3a910]/30">
                    IN-SAMPLE / OUT-OF-SAMPLE ENGINE
                  </span>
                </h2>
                <p className="text-xs text-gray-400 mt-1">
                  Mendukung parsing otomatis MT5/MT4 Strategy Tester (.xlsx/.csv), evaluasi In-Sample vs Out-of-Sample, dan deteksi overfitting.
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  onClick={() => fileInputUnifiedRef.current?.click()}
                  disabled={isProcessing}
                  className="bg-[#1c1e24] hover:bg-[#252830] text-gray-200 border border-[#2a2d36] px-3 py-2 rounded text-xs font-semibold tracking-wide transition-colors flex items-center gap-2"
                  title="Upload file MT5 atau CSV tunggal baru"
                >
                  <span>📁</span>
                  <span>Ganti File</span>
                </button>

                <button
                  onClick={() => fileInputIsRef.current?.click()}
                  disabled={isProcessing}
                  className="bg-blue-900/20 hover:bg-blue-900/40 text-blue-300 border border-blue-500/30 px-3 py-2 rounded text-xs font-semibold tracking-wide transition-colors flex items-center gap-1.5"
                  title="Upload atau ganti file In-Sample (File A)"
                >
                  <span>📥</span>
                  <span>IS (File A)</span>
                </button>

                <button
                  onClick={() => fileInputOosRef.current?.click()}
                  disabled={isProcessing}
                  className="bg-rose-900/20 hover:bg-rose-900/40 text-rose-300 border border-rose-500/30 px-3 py-2 rounded text-xs font-semibold tracking-wide transition-colors flex items-center gap-1.5"
                  title="Upload atau ganti file Out-of-Sample (File B)"
                >
                  <span>📥</span>
                  <span>OOS (File B)</span>
                </button>

                <button
                  onClick={handleDownloadReport}
                  disabled={!simResult}
                  className="bg-[#f3a910] hover:bg-[#d9930b] text-black px-3 py-2 rounded text-xs font-bold tracking-wide transition-colors flex items-center gap-2"
                >
                  <span>📊</span>
                  <span>Export HTML</span>
                </button>

                <button
                  onClick={handleReset}
                  className="bg-[#1c1e24] hover:bg-red-900/30 text-gray-400 hover:text-red-300 border border-[#2a2d36] px-2.5 py-2 rounded text-xs font-semibold tracking-wide transition-colors"
                  title="Reset ke tampilan awal / bersihkan data"
                >
                  <span>🔄 Reset</span>
                </button>
              </div>
            </div>

            {errorMsg && (
              <div className="mt-4 p-3 rounded bg-red-900/20 border border-red-500/40 text-red-400 text-xs">
                {errorMsg}
              </div>
            )}

            {/* View Switcher: ALL / IS / OOS / COMPARE */}
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-400 font-semibold uppercase tracking-wider mr-1">View Split:</span>
                <button
                  onClick={() => handleSwitchView('ALL')}
                  className={`px-3 py-1 rounded text-xs font-semibold transition-colors ${
                    activeView === 'ALL'
                      ? 'bg-[#f3a910] text-black'
                      : 'bg-[#1c1e24] text-gray-400 hover:text-white border border-[#2a2d36]'
                  }`}
                >
                  All Trades ({currentDataset.trades.length})
                </button>

                {isDataset && (
                  <button
                    onClick={() => handleSwitchView('IS')}
                    className={`px-3 py-1 rounded text-xs font-semibold transition-colors flex items-center gap-1.5 ${
                      activeView === 'IS'
                        ? 'bg-blue-600 text-white'
                        : 'bg-blue-900/20 text-blue-400 hover:bg-blue-900/40 border border-blue-500/30'
                    }`}
                  >
                    <span>In-Sample (IS)</span>
                    <span className="text-[10px] bg-black/30 px-1 rounded">{isDataset.trades.length}</span>
                  </button>
                )}

                {oosDataset && (
                  <button
                    onClick={() => handleSwitchView('OOS')}
                    className={`px-3 py-1 rounded text-xs font-semibold transition-colors flex items-center gap-1.5 ${
                      activeView === 'OOS'
                        ? 'bg-rose-600 text-white'
                        : 'bg-rose-900/20 text-rose-400 hover:bg-rose-900/40 border border-rose-500/30'
                    }`}
                  >
                    <span>Out-of-Sample (OOS)</span>
                    <span className="text-[10px] bg-black/30 px-1 rounded">{oosDataset.trades.length}</span>
                  </button>
                )}

                {isDataset && oosDataset && (
                  <button
                    onClick={() => setActiveView('COMPARE')}
                    className={`px-3 py-1 rounded text-xs font-semibold transition-colors flex items-center gap-1.5 ${
                      activeView === 'COMPARE'
                        ? 'bg-[#f3a910] text-black font-bold'
                        : 'bg-[#1c1e24] text-yellow-400 hover:bg-[#252830] border border-yellow-500/40'
                    }`}
                  >
                    <span>⚖️ IS vs OOS Analysis</span>
                  </button>
                )}
              </div>

              {/* Controls: Auto-Split & 1R Unit info */}
              <div className="flex flex-wrap items-center gap-3">
                {!(isDataset && oosDataset) ? (
                  <div className="flex items-center gap-1.5">
                    <span className="text-[11px] text-gray-400 uppercase font-semibold">Auto-Split:</span>
                    <select
                      value={splitOption}
                      onChange={(e) => handleSplitOptionChange(e.target.value)}
                      className="bg-[#0d0f12] border border-[#23262e] rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-[#f3a910]"
                    >
                      <option value="70-30">70% IS / 30% OOS (Standar)</option>
                      <option value="80-20">80% IS / 20% OOS (Pareto)</option>
                      <option value="50-50">50% IS / 50% OOS (Setengah)</option>
                      <option value="2022">Cutoff 2022-01-01 (Gotobi)</option>
                    </select>
                  </div>
                ) : (
                  <div className="flex items-center gap-1.5 px-2 py-1 bg-green-900/20 border border-green-500/30 rounded text-[11px] text-green-400 font-semibold">
                    <span>✓ File A (IS) &amp; File B (OOS) Terpisah</span>
                  </div>
                )}

                <div className="flex items-center gap-1.5" title="Satuan risiko 1R terdeteksi otomatis dari parameter file MT5 atau median loss trade.">
                  <span className="text-xs text-gray-500 font-mono">1R Unit:</span>
                  <span className="text-xs text-white font-mono font-bold bg-[#0d0f12] px-2 py-0.5 rounded border border-[#23262e]">
                    {currentDataset.detectedRisk ? currentDataset.detectedRisk.label : '10 pips'}
                  </span>
                  <span className="text-[10px] text-green-400 font-mono bg-green-900/20 px-1.5 py-0.2 rounded border border-green-500/30">Auto</span>
                </div>
              </div>
            </div>

            {/* Current Active Dataset Summary Cards */}
            <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-3">
              <div className="bg-[#0d0f12] p-3 rounded border border-[#23262e]">
                <div className="text-[10px] uppercase tracking-wider text-gray-500">Source</div>
                <div className="text-xs font-semibold text-white truncate mt-0.5">{currentDataset.sourceName}</div>
              </div>
              <div className="bg-[#0d0f12] p-3 rounded border border-[#23262e]">
                <div className="text-[10px] uppercase tracking-wider text-gray-500">Period</div>
                <div className="text-[11px] font-semibold text-gray-300 mt-0.5 font-mono">
                  {currentDataset.stats.startDateStr} - {currentDataset.stats.endDateStr}
                </div>
              </div>
              <div className="bg-[#0d0f12] p-3 rounded border border-[#23262e]">
                <div className="text-[10px] uppercase tracking-wider text-gray-500">Win Rate</div>
                <div className="text-xs font-semibold text-green-400 mt-0.5">{currentDataset.stats.winRate}%</div>
              </div>
              <div className="bg-[#0d0f12] p-3 rounded border border-[#23262e]">
                <div className="text-[10px] uppercase tracking-wider text-gray-500">Profit Factor</div>
                <div className="text-xs font-semibold text-[#f3a910] mt-0.5">{currentDataset.stats.profitFactor}</div>
              </div>
              <div className="bg-[#0d0f12] p-3 rounded border border-[#23262e]">
                <div className="text-[10px] uppercase tracking-wider text-gray-500">Total R-Multiple</div>
                <div className="text-xs font-semibold text-white mt-0.5">+{currentDataset.stats.totalR} R</div>
              </div>
              <div className="bg-[#0d0f12] p-3 rounded border border-[#23262e]">
                <div className="text-[10px] uppercase tracking-wider text-gray-500">Net Profit (Raw)</div>
                <div className="text-xs font-semibold text-green-400 mt-0.5">${currentDataset.stats.totalProfit}</div>
              </div>
            </div>
          </div>

          {/* IS vs OOS Robustness Analysis Card */}
          {robustness && (activeView === 'COMPARE' || activeView === 'ALL') && (
            <div className="bg-[#14161a] border border-[#23262e] rounded-lg p-5 shadow-xl">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-4 border-b border-[#23262e]">
                <div>
                  <h3 className="text-xs font-bold text-white uppercase tracking-wider flex items-center gap-2">
                    <span>IN-SAMPLE (IS) vs OUT-OF-SAMPLE (OOS) DIAGNOSTIC</span>
                    <span className={`text-[10px] px-2 py-0.5 rounded font-bold uppercase border ${robustness.statusColor}`}>
                      {robustness.status}
                    </span>
                  </h3>
                  <p className="text-xs text-gray-400 mt-1">{robustness.description}</p>
                </div>
                <div className="text-xs text-gray-500">
                  IS: <span className="text-blue-400 font-mono">{isDataset.trades.length} trades</span> · OOS:{' '}
                  <span className="text-rose-400 font-mono">{oosDataset.trades.length} trades</span>
                </div>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mt-4">
                <div className="bg-[#0d0f12] p-3 rounded border border-[#23262e]">
                  <div className="text-[10px] uppercase text-gray-500">Profit Factor Retention</div>
                  <div className="text-xl font-bold text-white mt-1">{robustness.pfRetention}%</div>
                  <div className="text-[11px] text-gray-400 mt-0.5">
                    IS: {isDataset.stats.profitFactor} ➔ OOS: {oosDataset.stats.profitFactor}
                  </div>
                </div>

                <div className="bg-[#0d0f12] p-3 rounded border border-[#23262e]">
                  <div className="text-[10px] uppercase text-gray-500">Win Rate Shift</div>
                  <div className={`text-xl font-bold mt-1 ${parseFloat(robustness.wrDiff) >= 0 ? 'text-green-400' : 'text-yellow-400'}`}>
                    {parseFloat(robustness.wrDiff) >= 0 ? '+' : ''}{robustness.wrDiff}%
                  </div>
                  <div className="text-[11px] text-gray-400 mt-0.5">
                    IS: {isDataset.stats.winRate}% ➔ OOS: {oosDataset.stats.winRate}%
                  </div>
                </div>

                <div className="bg-[#0d0f12] p-3 rounded border border-[#23262e]">
                  <div className="text-[10px] uppercase text-gray-500">Sharpe Ratio Retention</div>
                  <div className="text-xl font-bold text-white mt-1">{robustness.sharpeRetention}%</div>
                  <div className="text-[11px] text-gray-400 mt-0.5">
                    IS: {isSimResult?.summary?.sharpe?.median?.toFixed(2) || '-'} ➔ OOS:{' '}
                    {oosSimResult?.summary?.sharpe?.median?.toFixed(2) || '-'}
                  </div>
                </div>

                <div className="bg-[#0d0f12] p-3 rounded border border-[#23262e]">
                  <div className="text-[10px] uppercase text-gray-500">Max DD (95th %tile)</div>
                  <div className="text-xl font-bold text-red-400 mt-1">
                    {oosSimResult?.summary?.max_dd_pct?.p95?.toFixed(1) || '-'}%
                  </div>
                  <div className="text-[11px] text-gray-400 mt-0.5">
                    IS: {isSimResult?.summary?.max_dd_pct?.p95?.toFixed(1) || '-'}%
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Simulator Control Parameters */}
          <div className="bg-[#14161a] border border-[#23262e] rounded-lg p-5 shadow-xl">
            <h3 className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-4">Simulation Parameters</h3>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
              <div>
                <label className="block text-[11px] text-gray-500 uppercase tracking-wide mb-1">Starting Capital ($)</label>
                <input
                  type="number"
                  value={params.startCapital}
                  onChange={(e) => setParams({ ...params, startCapital: parseFloat(e.target.value) || 1000 })}
                  className="w-full bg-[#0d0f12] border border-[#23262e] rounded p-2 text-xs text-white focus:outline-none focus:border-[#f3a910]"
                />
              </div>

              <div>
                <label className="block text-[11px] text-gray-500 uppercase tracking-wide mb-1">Risk per Trade (%)</label>
                <input
                  type="number"
                  step="0.1"
                  value={params.riskPct}
                  onChange={(e) => setParams({ ...params, riskPct: parseFloat(e.target.value) || 1.0 })}
                  className="w-full bg-[#0d0f12] border border-[#23262e] rounded p-2 text-xs text-white focus:outline-none focus:border-[#f3a910]"
                />
              </div>

              <div>
                <label className="block text-[11px] text-gray-500 uppercase tracking-wide mb-1">Iterations</label>
                <select
                  value={params.iters}
                  onChange={(e) => setParams({ ...params, iters: parseInt(e.target.value) })}
                  className="w-full bg-[#0d0f12] border border-[#23262e] rounded p-2 text-xs text-white focus:outline-none focus:border-[#f3a910]"
                >
                  <option value="1000">1,000 runs (Fast)</option>
                  <option value="2000">2,000 runs (Standard)</option>
                  <option value="5000">5,000 runs (High Res)</option>
                  <option value="10000">10,000 runs (Pro)</option>
                </select>
              </div>

              <div>
                <label className="block text-[11px] text-gray-500 uppercase tracking-wide mb-1">Method</label>
                <select
                  value={params.method}
                  onChange={(e) => setParams({ ...params, method: e.target.value })}
                  className="w-full bg-[#0d0f12] border border-[#23262e] rounded p-2 text-xs text-white focus:outline-none focus:border-[#f3a910]"
                >
                  <option value="resample">Resample (Bootstrap)</option>
                  <option value="shuffle">Shuffle (Permutation)</option>
                  <option value="block">Block Bootstrap</option>
                </select>
              </div>

              <div>
                <label className="block text-[11px] text-gray-500 uppercase tracking-wide mb-1">Sizing Policy</label>
                <select
                  value={params.policy}
                  onChange={(e) => setParams({ ...params, policy: e.target.value })}
                  className="w-full bg-[#0d0f12] border border-[#23262e] rounded p-2 text-xs text-white focus:outline-none focus:border-[#f3a910]"
                >
                  <option value="compound">Compound (Full)</option>
                  <option value="fixed">Fixed Risk (No Comp)</option>
                  <option value="withdraw">50% Profit Withdrawal</option>
                </select>
              </div>

              <div className="flex items-end">
                <button
                  onClick={handleRunSimulation}
                  disabled={isProcessing}
                  className="w-full py-2 bg-[#f3a910] hover:bg-[#d9930b] text-black font-bold uppercase text-xs rounded tracking-wider shadow transition-colors"
                >
                  {isProcessing ? 'Simulating...' : 'Re-Run'}
                </button>
              </div>
            </div>
          </div>

          {/* Main Results: Chart & Cards */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            {/* Chart Panel */}
            <div className="lg:col-span-8 bg-[#14161a] border border-[#23262e] rounded-lg p-5 shadow-xl">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-xs font-bold text-gray-300 uppercase tracking-wider">
                  Monte Carlo Equity Distribution ({activeView})
                </h3>
                <span className="text-[11px] text-gray-500 font-mono">
                  Median End: ${simResult.summary.final_equity.median.toFixed(0)}
                </span>
              </div>
              {renderChart()}
            </div>

            {/* Key Metrics Cards */}
            <div className="lg:col-span-4 flex flex-col gap-3">
              <div className="bg-[#14161a] border border-[#23262e] rounded-lg p-4 shadow-xl">
                <div className="text-[10px] uppercase tracking-wider text-gray-500 font-semibold">Median Net Return</div>
                <div className="text-2xl font-bold text-green-400 mt-1">
                  +{simResult.summary.net_profit_pct.median.toFixed(1)}%
                </div>
                <div className="text-xs text-gray-400 mt-0.5">
                  ${simResult.summary.net_profit.median.toFixed(0)} net profit
                </div>
              </div>

              <div className="bg-[#14161a] border border-[#23262e] rounded-lg p-4 shadow-xl">
                <div className="text-[10px] uppercase tracking-wider text-gray-500 font-semibold">
                  Max Drawdown (Median / 95th)
                </div>
                <div className="text-2xl font-bold text-red-400 mt-1">
                  {simResult.summary.max_dd_pct.median.toFixed(1)}%
                  <span className="text-xs text-gray-500 font-normal ml-2">
                    / {simResult.summary.max_dd_pct.p95.toFixed(1)}% (95th)
                  </span>
                </div>
                <div className="text-xs text-gray-500 mt-0.5">
                  Worst case DD: {simResult.summary.max_dd_pct.max.toFixed(1)}%
                </div>
              </div>

              <div className="bg-[#14161a] border border-[#23262e] rounded-lg p-4 shadow-xl">
                <div className="text-[10px] uppercase tracking-wider text-gray-500 font-semibold">
                  Risk of Ruin (Equity &lt; 10%)
                </div>
                <div className={`text-2xl font-bold mt-1 ${simResult.summary.risk_of_ruin > 0 ? 'text-red-400' : 'text-green-400'}`}>
                  {simResult.summary.risk_of_ruin.toFixed(1)}%
                </div>
                <div className="text-xs text-gray-500 mt-0.5">
                  Max Cons. Losses (Median): {simResult.summary.max_cons_losses.median.toFixed(0)} trades
                </div>
              </div>

              <div className="bg-[#14161a] border border-[#23262e] rounded-lg p-4 shadow-xl">
                <div className="text-[10px] uppercase tracking-wider text-gray-500 font-semibold">
                  Sharpe / Sortino Ratio (Ann.)
                </div>
                <div className="text-2xl font-bold text-white mt-1">
                  {simResult.summary.sharpe.median.toFixed(2)}
                  <span className="text-xs text-gray-500 font-normal ml-2">
                    / {simResult.summary.sortino.median.toFixed(2)}
                  </span>
                </div>
                <div className="text-xs text-gray-500 mt-0.5">
                  Profit Factor: {simResult.summary.profit_factor.median.toFixed(2)}
                </div>
              </div>
            </div>
          </div>

          {/* Percentiles Confidence Table */}
          <div className="bg-[#14161a] border border-[#23262e] rounded-lg p-5 shadow-xl overflow-x-auto">
            <h3 className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-3">
              Simulation Percentile Confidence Intervals ({activeView})
            </h3>
            <table className="w-full text-xs text-left">
              <thead>
                <tr className="border-b border-[#23262e] text-gray-500 text-[10px] uppercase">
                  <th className="py-2.5 px-3">Metric</th>
                  <th className="py-2.5 px-3">5th Percentile (Worst 5%)</th>
                  <th className="py-2.5 px-3">25th Percentile</th>
                  <th className="py-2.5 px-3 text-white">Median (50th)</th>
                  <th className="py-2.5 px-3">75th Percentile</th>
                  <th className="py-2.5 px-3 text-green-400">95th Percentile (Top 5%)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#1c1e24] text-gray-300 font-mono">
                <tr>
                  <td className="py-2.5 px-3 font-sans text-gray-400 font-semibold">Final Equity ($)</td>
                  <td className="py-2.5 px-3">${simResult.summary.final_equity.p5.toFixed(0)}</td>
                  <td className="py-2.5 px-3">${simResult.summary.final_equity.p25.toFixed(0)}</td>
                  <td className="py-2.5 px-3 font-bold text-white">${simResult.summary.final_equity.median.toFixed(0)}</td>
                  <td className="py-2.5 px-3">${simResult.summary.final_equity.p75.toFixed(0)}</td>
                  <td className="py-2.5 px-3 text-green-400">${simResult.summary.final_equity.p95.toFixed(0)}</td>
                </tr>
                <tr>
                  <td className="py-2.5 px-3 font-sans text-gray-400 font-semibold">Net Profit (%)</td>
                  <td className="py-2.5 px-3">{simResult.summary.net_profit_pct.p5.toFixed(1)}%</td>
                  <td className="py-2.5 px-3">{simResult.summary.net_profit_pct.p25.toFixed(1)}%</td>
                  <td className="py-2.5 px-3 font-bold text-white">{simResult.summary.net_profit_pct.median.toFixed(1)}%</td>
                  <td className="py-2.5 px-3">{simResult.summary.net_profit_pct.p75.toFixed(1)}%</td>
                  <td className="py-2.5 px-3 text-green-400">{simResult.summary.net_profit_pct.p95.toFixed(1)}%</td>
                </tr>
                <tr>
                  <td className="py-2.5 px-3 font-sans text-gray-400 font-semibold">Max Drawdown (%)</td>
                  <td className="py-2.5 px-3">{simResult.summary.max_dd_pct.p5.toFixed(1)}%</td>
                  <td className="py-2.5 px-3">{simResult.summary.max_dd_pct.p25.toFixed(1)}%</td>
                  <td className="py-2.5 px-3 font-bold text-white">{simResult.summary.max_dd_pct.median.toFixed(1)}%</td>
                  <td className="py-2.5 px-3">{simResult.summary.max_dd_pct.p75.toFixed(1)}%</td>
                  <td className="py-2.5 px-3 text-red-400">{simResult.summary.max_dd_pct.p95.toFixed(1)}%</td>
                </tr>
                <tr>
                  <td className="py-2.5 px-3 font-sans text-gray-400 font-semibold">Max Consecutive Losses</td>
                  <td className="py-2.5 px-3">{simResult.summary.max_cons_losses.p5.toFixed(0)}</td>
                  <td className="py-2.5 px-3">{simResult.summary.max_cons_losses.p25.toFixed(0)}</td>
                  <td className="py-2.5 px-3 font-bold text-white">{simResult.summary.max_cons_losses.median.toFixed(0)}</td>
                  <td className="py-2.5 px-3">{simResult.summary.max_cons_losses.p75.toFixed(0)}</td>
                  <td className="py-2.5 px-3">{simResult.summary.max_cons_losses.p95.toFixed(0)}</td>
                </tr>
                <tr>
                  <td className="py-2.5 px-3 font-sans text-gray-400 font-semibold">Annualized Sharpe</td>
                  <td className="py-2.5 px-3">{simResult.summary.sharpe.p5.toFixed(2)}</td>
                  <td className="py-2.5 px-3">{simResult.summary.sharpe.p25.toFixed(2)}</td>
                  <td className="py-2.5 px-3 font-bold text-white">{simResult.summary.sharpe.median.toFixed(2)}</td>
                  <td className="py-2.5 px-3">{simResult.summary.sharpe.p75.toFixed(2)}</td>
                  <td className="py-2.5 px-3 text-green-400">{simResult.summary.sharpe.p95.toFixed(2)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
};

export default MonteCarloSimulator;
