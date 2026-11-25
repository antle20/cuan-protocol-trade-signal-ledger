// tradeFileParser.js — Robust parser for MT4/MT5 Strategy Tester Reports, CSVs, Excel, and Supabase Ledger
import * as XLSX from 'xlsx';

/**
 * Parses an uploaded File (xlsx, xls, csv) into normalized trade data
 * @param {File} file
 * @param {Object} options - { slPips: null (auto-detect if null), splitRatio: 0.7, splitDate: null }
 */
export async function parseTradeFile(file, options = {}) {
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: 'array', cellDates: true });
  const sheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[sheetName];
  const rawRows = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: null });

  return extractTradesFromRows(rawRows, file.name, options);
}

/**
 * Normalizes rows into trade data, supporting MT5 Deals, MT4 Orders, and Generic Tables
 */
export function extractTradesFromRows(rows, filename = '', options = {}) {
  if (!rows || rows.length < 2) {
    throw new Error('File appears to be empty or has insufficient rows.');
  }

  let dealsRowIdx = -1;
  let genericHeaderIdx = -1;
  let detectedInputSl = null;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] || [];

    // Scan for EA input parameters (e.g. InpSLPips=11)
    if (detectedInputSl === null) {
      for (const cell of row) {
        if (typeof cell === 'string') {
          const match = cell.match(/(?:inpslpips|inpsl)\s*[:=]\s*([0-9.]+)/i);
          if (match && parseFloat(match[1]) > 0) {
            detectedInputSl = parseFloat(match[1]);
          }
        }
      }
    }

    const strRow = row.map((c) => String(c || '').trim().toLowerCase());

    if (strRow.includes('deals')) {
      dealsRowIdx = i;
      break;
    }

    if (
      genericHeaderIdx === -1 &&
      (strRow.includes('profit') || strRow.includes('p&l') || strRow.includes('pnl') || strRow.includes('r')) &&
      (strRow.includes('time') || strRow.includes('date'))
    ) {
      genericHeaderIdx = i;
    }
  }

  const headerRowIdx = dealsRowIdx !== -1 ? dealsRowIdx + 1 : genericHeaderIdx !== -1 ? genericHeaderIdx : 0;
  const header = (rows[headerRowIdx] || []).map((c) => String(c || '').trim());
  const headerLower = header.map((c) => c.toLowerCase());

  const col = {};
  headerLower.forEach((h, idx) => {
    col[h] = idx;
  });

  const isMT5 = col['direction'] !== undefined && col['profit'] !== undefined;
  const trades = [];
  const startRow = headerRowIdx + 1;

  if (isMT5) {
    // --- MT5 Deals Parser ---
    let pendingEntry = null;
    for (let i = startRow; i < rows.length; i++) {
      const r = rows[i];
      if (!r || r.length === 0) continue;
      const type = String(r[col['type']] || '').toLowerCase();
      const dir = String(r[col['direction']] || '').toLowerCase();
      if (type === 'balance') continue;

      if (dir === 'in') {
        pendingEntry = {
          time: r[col['time']],
          symbol: String(r[col['symbol']] || 'XAUUSD'),
          type,
          volume: parseFloat(r[col['volume']] || 0),
          price: parseFloat(r[col['price']] || 0),
        };
      } else if (dir === 'out') {
        const profit = parseFloat(r[col['profit']] || 0);
        const comm = parseFloat(r[col['commission']] || 0);
        const swap = parseFloat(r[col['swap']] || 0);
        const netPnl = profit + comm + swap;
        const exitPrice = parseFloat(r[col['price']] || 0);
        const entryPrice = pendingEntry ? pendingEntry.price : exitPrice;
        const symbol = String(r[col['symbol']] || (pendingEntry ? pendingEntry.symbol : 'XAUUSD')).toUpperCase();

        // Pip size per instrument
        let pipSize = 0.0001;
        if (symbol.includes('JPY')) pipSize = 0.01;
        else if (symbol.includes('XAU') || symbol.includes('GOLD')) pipSize = 0.1;
        else if (symbol.includes('BTC') || symbol.includes('ETH')) pipSize = 1.0;

        const isSell = pendingEntry ? pendingEntry.type === 'sell' : false;
        const pips = isSell ? (entryPrice - exitPrice) / pipSize : (exitPrice - entryPrice) / pipSize;

        let date = null;
        const rawTime = pendingEntry ? pendingEntry.time : r[col['time']];
        if (rawTime) {
          if (rawTime instanceof Date) {
            date = rawTime;
          } else {
            const cleanTime = String(rawTime).replace(/\./g, '-');
            const d = new Date(cleanTime);
            if (!isNaN(d.getTime())) date = d;
          }
        }

        trades.push({
          index: trades.length + 1,
          date: date || new Date(2024, 0, 1 + trades.length),
          entryPrice,
          exitPrice,
          volume: parseFloat(r[col['volume']] || 0),
          profit: Math.round(netPnl * 100) / 100,
          pips: Math.round(pips * 10) / 10,
          symbol,
          r: null,
          raw: r,
        });

        pendingEntry = null;
      }
    }
  } else {
    // --- Generic CSV / Excel Parser ---
    const colIdx = {
      profit: headerLower.findIndex((c) =>
        ['profit', 'net profit', 'p&l', 'pnl', 'gain', 'net'].includes(c)
      ),
      r: headerLower.findIndex((c) =>
        ['r', 'r-multiple', 'r_multiple', 'r-unit', 'rmultiple', 'r multiple'].includes(c)
      ),
      time: headerLower.findIndex((c) =>
        ['time', 'date', 'close time', 'closetime', 'exit time', 'timestamp', 'open time'].includes(c)
      ),
      symbol: headerLower.findIndex((c) => ['symbol', 'pair', 'ticker', 'item'].includes(c)),
    };

    if (colIdx.profit === -1 && colIdx.r === -1) {
      throw new Error(
        `Could not detect a 'Profit' or 'R' column in file: ${filename}. Available headers: ${header.join(', ')}`
      );
    }

    for (let i = startRow; i < rows.length; i++) {
      const r = rows[i];
      if (!r || r.length === 0) continue;

      const firstCell = String(r[0] || '').trim().toLowerCase();
      if (firstCell.startsWith('total') || firstCell.startsWith('balance') || firstCell.startsWith('summary')) {
        continue;
      }

      let profit = null;
      let rUnit = null;

      if (colIdx.profit !== -1 && r[colIdx.profit] !== null && r[colIdx.profit] !== undefined) {
        const val = parseFloat(String(r[colIdx.profit]).replace(/[^0-9.-]/g, ''));
        if (!isNaN(val)) profit = val;
      }

      if (colIdx.r !== -1 && r[colIdx.r] !== null && r[colIdx.r] !== undefined) {
        const val = parseFloat(String(r[colIdx.r]).replace(/[^0-9.-]/g, ''));
        if (!isNaN(val)) rUnit = val;
      }

      if (profit === null && rUnit === null) continue;

      let date = null;
      if (colIdx.time !== -1 && r[colIdx.time]) {
        const d = new Date(String(r[colIdx.time]).replace(/\./g, '-'));
        if (!isNaN(d.getTime())) date = d;
      }

      const symbol = colIdx.symbol !== -1 ? String(r[colIdx.symbol] || '') : 'Trade';

      trades.push({
        index: trades.length + 1,
        date: date || new Date(2024, 0, 1 + trades.length),
        profit: profit !== null ? profit : (rUnit || 0) * 100,
        r: rUnit,
        symbol,
        raw: r,
      });
    }
  }

  if (trades.length === 0) {
    throw new Error(`No trade records found in ${filename}.`);
  }

  // --- SMART 1R (Risk Unit) DETERMINATION ---
  // Step 1: Check losses distribution in USD
  const dollarLosses = trades.map((t) => t.profit).filter((p) => p < 0).map((p) => Math.abs(p));
  dollarLosses.sort((a, b) => a - b);
  const medianDollarLoss = dollarLosses.length > 0 ? dollarLosses[Math.floor(dollarLosses.length / 2)] : 100;

  // Step 2: Determine if this is a fixed-dollar risk EA (e.g. Fixed Risk $1,000 on Gold) or fixed-pips EA (e.g. Gotobi 11 pips)
  let riskMode = 'USD'; // 'PIPS' | 'USD'
  let finalRiskValue = medianDollarLoss;

  if (options.slPips) {
    riskMode = 'PIPS';
    finalRiskValue = options.slPips;
  } else if (detectedInputSl && detectedInputSl > 0) {
    riskMode = 'PIPS';
    finalRiskValue = detectedInputSl;
  } else {
    // If no explicit EA pips setting, check if losses are clustered around a specific dollar amount (e.g. $1,000)
    riskMode = 'USD';
    finalRiskValue = Math.round(medianDollarLoss);
  }

  // Calculate R
  if (riskMode === 'PIPS') {
    for (const t of trades) {
      t.r = Math.round(((t.pips || 0) / finalRiskValue) * 100) / 100;
    }
  } else {
    // USD risk normalization (1R = median loss, e.g. $1,000)
    for (const t of trades) {
      if (t.r === null || isNaN(t.r)) {
        t.r = Math.round((t.profit / finalRiskValue) * 100) / 100;
      }
    }
  }

  // Detect In-Sample / Out-of-Sample tag from filename if present (strict boundary match)
  let fileSampleTag = 'ALL';
  const lowerName = filename.toLowerCase();
  const isTagIS = /(?:^|[_\- .])(in[-_ ]?sample|is|file[-_ ]?a)(?:[_\- .]|$)/i.test(lowerName) || lowerName.endsWith('_a') || lowerName.includes('_a.');
  const isTagOOS = /(?:^|[_\- .])(out[-_ ]?of[-_ ]?sample|oos|file[-_ ]?b)(?:[_\- .]|$)/i.test(lowerName) || lowerName.endsWith('_b') || lowerName.includes('_b.');

  if (isTagIS && !isTagOOS) {
    fileSampleTag = 'IS';
  } else if (isTagOOS && !isTagIS) {
    fileSampleTag = 'OOS';
  }

  const ds = buildTradeDataset(trades, filename, fileSampleTag);
  ds.detectedRisk = {
    mode: riskMode,
    value: finalRiskValue,
    label: riskMode === 'PIPS' ? `${finalRiskValue} pips` : `$${finalRiskValue.toLocaleString()}`,
  };
  return ds;
}

/**
 * Builds dataset structure for Monte Carlo engine with IS/OOS capabilities
 */
export function buildTradeDataset(trades, sourceName = 'Uploaded Data', sampleTag = 'ALL') {
  const sortedTrades = [...trades].sort((a, b) => a.date - b.date);
  const R = sortedTrades.map((t) => t.r);
  const profits = sortedTrades.map((t) => t.profit);
  const dates = sortedTrades.map((t) => t.date);

  const wins = R.filter((r) => r > 0);
  const losses = R.filter((r) => r <= 0);
  const grossProfit = wins.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));

  const totalTrades = sortedTrades.length;
  const winRate = totalTrades > 0 ? (wins.length / totalTrades) * 100 : 0;
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 99 : 0;
  const avgR = totalTrades > 0 ? R.reduce((a, b) => a + b, 0) / totalTrades : 0;

  const startDate = sortedTrades.length > 0 ? sortedTrades[0].date : new Date();
  const endDate = sortedTrades.length > 0 ? sortedTrades[sortedTrades.length - 1].date : new Date();

  const totalMonths = Math.max(
    1,
    (endDate.getFullYear() - startDate.getFullYear()) * 12 + (endDate.getMonth() - startDate.getMonth()) + 1
  );

  const month_idx = [];
  const year_idx = [];
  const dateStrings = [];
  const pnl = [];
  const mae = [];
  const qty = [];
  const px_in = [];
  const px_out = [];
  const is_sl = [];
  const pips = [];
  const stop_usd = [];
  const uniqueYearsSet = new Set();
  const uniqueMonthsSet = new Set();

  // Reference 1R risk USD
  const dollarLosses = profits.filter((p) => p < 0).map((p) => Math.abs(p));
  dollarLosses.sort((a, b) => a - b);
  const medianLossUsd = dollarLosses.length > 0 ? dollarLosses[Math.floor(dollarLosses.length / 2)] : 1000;

  for (let i = 0; i < sortedTrades.length; i++) {
    const t = sortedTrades[i];
    const m = (t.date.getFullYear() - startDate.getFullYear()) * 12 + t.date.getMonth();
    const y = t.date.getFullYear() - startDate.getFullYear();
    month_idx.push(m);
    year_idx.push(y);

    const yVal = t.date.getFullYear();
    const mVal = `${yVal}-${String(t.date.getMonth() + 1).padStart(2, '0')}`;
    const dVal = `${mVal}-${String(t.date.getDate()).padStart(2, '0')}`;
    uniqueYearsSet.add(yVal);
    uniqueMonthsSet.add(mVal);
    dateStrings.push(dVal);

    pnl.push(t.profit);
    pips.push(t.pips !== undefined && t.pips !== null ? t.pips : t.r * 10);
    qty.push(t.volume || 1);
    px_in.push(t.entryPrice || 100);
    px_out.push(t.exitPrice || 100);

    const isLoss = t.profit < 0;
    is_sl.push(isLoss);
    stop_usd.push(medianLossUsd);

    // Adverse Excursion (MAE <= 0):
    // If trade lost money, MAE is at least the loss amount.
    // If trade won, MAE represents drawdown dip before win (approximated as 30% of 1R risk if not logged).
    if (t.mae !== undefined && t.mae !== null) {
      mae.push(t.mae <= 0 ? t.mae : -t.mae);
    } else {
      mae.push(isLoss ? Math.min(t.profit, -medianLossUsd) : -0.3 * medianLossUsd);
    }
  }

  const years = Array.from(uniqueYearsSet).sort((a, b) => a - b);
  const months = Array.from(uniqueMonthsSet).sort();

  return {
    sourceName,
    sampleTag,
    trades: sortedTrades,
    N: totalTrades,
    M: totalMonths,
    R,
    profits,
    dates,
    month_idx,
    year_idx,
    date: dateStrings,
    pnl,
    mae,
    qty,
    px_in,
    px_out,
    is_sl,
    pips,
    stop_usd,
    years,
    months,
    startDate,
    endDate,
    stats: {
      totalTrades,
      winsCount: wins.length,
      lossesCount: losses.length,
      winRate: winRate.toFixed(1),
      profitFactor: profitFactor.toFixed(2),
      avgR: avgR.toFixed(2),
      totalProfit: profits.reduce((a, b) => a + b, 0).toFixed(2),
      totalR: R.reduce((a, b) => a + b, 0).toFixed(1),
      startDateStr: startDate.toLocaleDateString('en-GB'),
      endDateStr: endDate.toLocaleDateString('en-GB'),
      spanMonths: totalMonths,
    },
  };
}

/**
 * Splits a single dataset into In-Sample (IS) and Out-of-Sample (OOS) by split date or percentage
 */
export function splitDataset(dataset, splitBy = 'date', splitVal = '2022-01-01') {
  const { trades, sourceName } = dataset;
  let isTrades = [];
  let oosTrades = [];

  if (splitBy === 'date') {
    const cutoff = new Date(splitVal);
    isTrades = trades.filter((t) => t.date < cutoff);
    oosTrades = trades.filter((t) => t.date >= cutoff);
  } else {
    const ratio = typeof splitVal === 'number' ? splitVal : 0.7;
    const splitIdx = Math.floor(trades.length * ratio);
    isTrades = trades.slice(0, splitIdx);
    oosTrades = trades.slice(splitIdx);
  }

  const isDataset = isTrades.length > 0 ? buildTradeDataset(isTrades, `${sourceName} (In-Sample)`, 'IS') : null;
  const oosDataset = oosTrades.length > 0 ? buildTradeDataset(oosTrades, `${sourceName} (Out-of-Sample)`, 'OOS') : null;

  return { isDataset, oosDataset };
}

/**
 * Combines two datasets (e.g. File A and File B) into a unified dataset
 */
export function combineDatasets(isDataset, oosDataset) {
  const combinedTrades = [...isDataset.trades, ...oosDataset.trades].sort((a, b) => a.date - b.date);
  return buildTradeDataset(combinedTrades, 'Combined (IS + OOS)', 'ALL');
}

/**
 * Builds dataset from Supabase ledger
 */
export function buildDatasetFromSupabase(records) {
  if (!records || records.length === 0) {
    throw new Error('No trades found in database.');
  }

  const validRecords = records.filter(
    (r) => r.status && ['TP', 'SL', 'TRIGGERED', 'CLOSE', 'ACTIVE'].includes(r.status)
  );

  const trades = validRecords.map((r, i) => {
    let rMultiple = 0;
    let profit = 0;

    if (r.status === 'TP') {
      if (r.take_profit_price && r.stop_loss_price && r.order_price) {
        const risk = Math.abs(r.order_price - r.stop_loss_price);
        const reward = Math.abs(r.take_profit_price - r.order_price);
        rMultiple = risk > 0 ? reward / risk : 2.0;
      } else {
        rMultiple = 2.0;
      }
      profit = rMultiple * 100;
    } else if (r.status === 'SL') {
      rMultiple = -1.0;
      profit = -100;
    } else if (r.status === 'CLOSE') {
      rMultiple = 0.5;
      profit = 50;
    } else {
      rMultiple = 0.0;
      profit = 0;
    }

    const date = r.created_at ? new Date(r.created_at) : new Date(2024, 0, 1 + i);

    return {
      index: i + 1,
      date,
      profit,
      r: rMultiple,
      symbol: r.pair_name || 'Trade',
      raw: r,
    };
  });

  return buildTradeDataset(trades, 'Supabase Ledger');
}
