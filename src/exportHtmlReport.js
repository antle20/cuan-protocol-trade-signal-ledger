// exportHtmlReport.js — Generates a standalone, offline interactive HTML Monte Carlo report

export function generateHtmlReport(dataset, simResult, options) {
  const { summary, bands, samples, H, S, start } = simResult;
  const { sourceName, stats } = dataset;

  // Chart coordinate calculations
  const width = 900;
  const height = 360;
  const padX = 70;
  const padY = 40;
  const chartW = width - padX * 2;
  const chartH = height - padY * 2;

  let minY = start;
  let maxY = start;
  for (let j = 0; j < H; j++) {
    if (bands[5][j] < minY) minY = bands[5][j];
    if (bands[95][j] > maxY) maxY = bands[95][j];
  }
  minY = Math.max(0, minY * 0.9);
  maxY = maxY * 1.1;
  const rangeY = Math.max(1, maxY - minY);

  const getX = (j) => padX + (j / Math.max(1, H - 1)) * chartW;
  const getY = (val) => padY + chartH - ((val - minY) / rangeY) * chartH;

  // 5th–95th percentile band area
  let band95Path = `M ${getX(0).toFixed(1)} ${getY(bands[95][0]).toFixed(1)}`;
  for (let j = 1; j < H; j++) band95Path += ` L ${getX(j).toFixed(1)} ${getY(bands[95][j]).toFixed(1)}`;
  for (let j = H - 1; j >= 0; j--) band95Path += ` L ${getX(j).toFixed(1)} ${getY(bands[5][j]).toFixed(1)}`;
  band95Path += ' Z';

  // 25th–75th percentile band area
  let band75Path = `M ${getX(0).toFixed(1)} ${getY(bands[75][0]).toFixed(1)}`;
  for (let j = 1; j < H; j++) band75Path += ` L ${getX(j).toFixed(1)} ${getY(bands[75][j]).toFixed(1)}`;
  for (let j = H - 1; j >= 0; j--) band75Path += ` L ${getX(j).toFixed(1)} ${getY(bands[25][j]).toFixed(1)}`;
  band75Path += ' Z';

  // Median path
  let medianPath = `M ${getX(0).toFixed(1)} ${getY(bands[50][0]).toFixed(1)}`;
  for (let j = 1; j < H; j++) medianPath += ` L ${getX(j).toFixed(1)} ${getY(bands[50][j]).toFixed(1)}`;

  // Sample paths (up to 15)
  const samplePathsSvg = samples
    .slice(0, 15)
    .map((sArr) => {
      let p = `M ${getX(0).toFixed(1)} ${getY(sArr[0]).toFixed(1)}`;
      for (let j = 1; j < H; j++) p += ` L ${getX(j).toFixed(1)} ${getY(sArr[j]).toFixed(1)}`;
      return `<path d="${p}" fill="none" stroke="#38bdf8" stroke-width="1" stroke-opacity="0.3"/>`;
    })
    .join('\n');

  // Y-axis grid & labels
  const gridLines = [0, 0.25, 0.5, 0.75, 1.0]
    .map((t) => {
      const val = minY + (1 - t) * rangeY;
      const y = padY + t * chartH;
      return `
        <line x1="${padX}" y1="${y.toFixed(1)}" x2="${(width - padX).toFixed(1)}" y2="${y.toFixed(1)}" stroke="#23262e" stroke-dasharray="3 3"/>
        <text x="${padX - 10}" y="${(y + 4).toFixed(1)}" text-anchor="end" fill="#6b7280" font-size="11" font-family="monospace">$${Math.round(val).toLocaleString()}</text>
      `;
    })
    .join('\n');

  const startY = getY(start).toFixed(1);

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Monte Carlo Simulation Report · ${sourceName}</title>
<style>
  :root {
    --bg: #0d0f12; --panel: #14161a; --border: #23262e; --accent: #f3a910;
    --text: #e5e7eb; --muted: #9ca3af; --good: #10b981; --bad: #ef4444;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  body { background: var(--bg); color: var(--text); padding: 28px 20px; }
  .wrap { max-width: 1200px; margin: 0 auto; }
  header { margin-bottom: 24px; border-bottom: 1px solid var(--border); padding-bottom: 16px; display: flex; justify-content: space-between; align-items: flex-end; flex-wrap: wrap; gap: 12px; }
  h1 { font-size: 22px; font-weight: 700; color: #fff; letter-spacing: 0.03em; }
  .badge { display: inline-block; padding: 4px 10px; border-radius: 4px; font-size: 11px; font-weight: 700; text-transform: uppercase; background: #1c1e24; border: 1px solid var(--border); color: var(--accent); }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 14px; margin-bottom: 24px; }
  .card { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 18px; box-shadow: 0 4px 20px rgba(0,0,0,0.3); }
  .card .label { font-size: 11px; text-transform: uppercase; color: var(--muted); font-weight: 600; letter-spacing: 0.05em; margin-bottom: 4px; }
  .card .val { font-size: 24px; font-weight: 700; color: #fff; }
  .card .sub { font-size: 12px; color: var(--muted); margin-top: 4px; }
  .good { color: var(--good) !important; }
  .bad { color: var(--bad) !important; }
  .chart-box { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 20px; margin-bottom: 24px; box-shadow: 0 4px 20px rgba(0,0,0,0.3); }
  .legend { display: flex; gap: 16px; flex-wrap: wrap; font-size: 11px; color: var(--muted); margin-top: 12px; }
  .legend span { display: inline-flex; align-items: center; gap: 6px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; margin-top: 12px; }
  th, td { padding: 10px 14px; text-align: left; border-bottom: 1px solid var(--border); }
  th { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; }
  tr:hover td { background: #181b20; }
  svg { width: 100%; height: auto; display: block; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div>
      <h1>MONTE CARLO SIMULATION REPORT</h1>
      <p style="font-size: 12px; color: var(--muted); margin-top: 4px;">
        Source: ${sourceName} · ${H} Trades (${stats.startDateStr || 'Start'} to ${stats.endDateStr || 'End'}) · ${S.toLocaleString()} Iterations
      </p>
    </div>
    <span class="badge">${options.policy} · ${options.method}</span>
  </header>

  <div class="grid">
    <div class="card">
      <div class="label">Starting Capital</div>
      <div class="val">$${start.toLocaleString()}</div>
      <div class="sub">Risk: ${options.riskPct}% per trade</div>
    </div>
    <div class="card">
      <div class="label">Median Net Profit</div>
      <div class="val ${summary.net_profit_pct.median >= 0 ? 'good' : 'bad'}">${summary.net_profit_pct.median >= 0 ? '+' : ''}${summary.net_profit_pct.median.toFixed(1)}%</div>
      <div class="sub">$${Math.round(summary.net_profit.median).toLocaleString()}</div>
    </div>
    <div class="card">
      <div class="label">Max DD (Median / 95th)</div>
      <div class="val bad">${summary.max_dd_pct.median.toFixed(1)}% / ${summary.max_dd_pct.p95.toFixed(1)}%</div>
      <div class="sub">Worst: ${summary.max_dd_pct.max.toFixed(1)}%</div>
    </div>
    <div class="card">
      <div class="label">Profit Factor (Median)</div>
      <div class="val">${summary.profit_factor.median.toFixed(2)}</div>
      <div class="sub">Raw Win Rate: ${stats.winRate}%</div>
    </div>
    <div class="card">
      <div class="label">Sharpe / Sortino</div>
      <div class="val">${summary.sharpe.median.toFixed(2)} / ${summary.sortino.median.toFixed(2)}</div>
      <div class="sub">Risk of Ruin: ${summary.risk_of_ruin.toFixed(1)}%</div>
    </div>
  </div>

  <div class="chart-box">
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px;">
      <h3 style="font-size: 13px; font-weight: 700; color: #fff; text-transform: uppercase; letter-spacing: 0.05em;">
        EQUITY PERCENTILE BANDS (5th, 25th, 50th, 75th, 95th)
      </h3>
      <span style="font-size: 12px; font-family: monospace; color: var(--accent); font-weight: bold;">
        Median End: $${Math.round(summary.final_equity.median).toLocaleString()}
      </span>
    </div>

    <svg viewBox="0 0 ${width} ${height}">
      <!-- Y-Axis Gridlines & Values -->
      ${gridLines}

      <!-- 5th to 95th Percentile Shaded Band -->
      <path d="${band95Path}" fill="#f3a910" fill-opacity="0.12" />

      <!-- 25th to 75th Percentile Shaded Band -->
      <path d="${band75Path}" fill="#f3a910" fill-opacity="0.22" />

      <!-- Individual Sample Simulation Paths -->
      ${samplePathsSvg}

      <!-- 50th Percentile (Median Equity Curve) -->
      <path d="${medianPath}" fill="none" stroke="#f3a910" stroke-width="2.5" />

      <!-- Initial Capital Baseline -->
      <line x1="${padX}" y1="${startY}" x2="${width - padX}" y2="${startY}" stroke="#9ca3af" stroke-dasharray="3 3" stroke-opacity="0.5" />

      <!-- X-Axis Labels -->
      <text x="${padX}" y="${height - 10}" fill="#6b7280" font-size="11">Trade 1 (${stats.startDateStr || ''})</text>
      <text x="${width / 2}" y="${height - 10}" text-anchor="middle" fill="#6b7280" font-size="11">${H} Trades Horizon</text>
      <text x="${width - padX}" y="${height - 10}" text-anchor="end" fill="#6b7280" font-size="11">Trade ${H} (${stats.endDateStr || ''})</text>
    </svg>

    <div class="legend">
      <span><i style="display:inline-block;width:12px;height:12px;background:#f3a910;opacity:0.25;border-radius:2px;"></i> 5th–95th %tile Band</span>
      <span><i style="display:inline-block;width:12px;height:12px;background:#f3a910;opacity:0.45;border-radius:2px;"></i> 25th–75th %tile Band</span>
      <span><i style="display:inline-block;width:14px;height:3px;background:#f3a910;border-radius:2px;"></i> Median Equity</span>
      <span><i style="display:inline-block;width:14px;height:2px;background:#38bdf8;opacity:0.5;border-radius:2px;"></i> Sample Paths</span>
      <span><i style="display:inline-block;width:14px;height:1px;background:#9ca3af;border-radius:1px;"></i> Starting Balance</span>
    </div>
  </div>

  <div class="card">
    <h3 style="font-size: 13px; font-weight: 700; color: #fff; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 12px;">
      PERCENTILE CONFIDENCE INTERVALS
    </h3>
    <table>
      <thead>
        <tr>
          <th>Metric</th>
          <th>5th %tile (Worst 5%)</th>
          <th>25th %tile</th>
          <th>Median (50th)</th>
          <th>75th %tile</th>
          <th>95th %tile (Top 5%)</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td style="font-weight: 600; color: #fff;">Final Equity ($)</td>
          <td>$${Math.round(summary.final_equity.p5).toLocaleString()}</td>
          <td>$${Math.round(summary.final_equity.p25).toLocaleString()}</td>
          <td style="font-weight: 700; color: #fff;">$${Math.round(summary.final_equity.median).toLocaleString()}</td>
          <td>$${Math.round(summary.final_equity.p75).toLocaleString()}</td>
          <td class="good">$${Math.round(summary.final_equity.p95).toLocaleString()}</td>
        </tr>
        <tr>
          <td style="font-weight: 600; color: #fff;">Net Return (%)</td>
          <td>${summary.net_profit_pct.p5.toFixed(1)}%</td>
          <td>${summary.net_profit_pct.p25.toFixed(1)}%</td>
          <td style="font-weight: 700; color: #fff;">${summary.net_profit_pct.median.toFixed(1)}%</td>
          <td>${summary.net_profit_pct.p75.toFixed(1)}%</td>
          <td class="good">${summary.net_profit_pct.p95.toFixed(1)}%</td>
        </tr>
        <tr>
          <td style="font-weight: 600; color: #fff;">Max Drawdown (%)</td>
          <td>${summary.max_dd_pct.p5.toFixed(1)}%</td>
          <td>${summary.max_dd_pct.p25.toFixed(1)}%</td>
          <td style="font-weight: 700; color: #fff;">${summary.max_dd_pct.median.toFixed(1)}%</td>
          <td>${summary.max_dd_pct.p75.toFixed(1)}%</td>
          <td class="bad">${summary.max_dd_pct.p95.toFixed(1)}%</td>
        </tr>
        <tr>
          <td style="font-weight: 600; color: #fff;">Max Consecutive Losses</td>
          <td>${summary.max_cons_losses.p5.toFixed(0)}</td>
          <td>${summary.max_cons_losses.p25.toFixed(0)}</td>
          <td style="font-weight: 700; color: #fff;">${summary.max_cons_losses.median.toFixed(0)}</td>
          <td>${summary.max_cons_losses.p75.toFixed(0)}</td>
          <td>${summary.max_cons_losses.p95.toFixed(0)}</td>
        </tr>
        <tr>
          <td style="font-weight: 600; color: #fff;">Annualized Sharpe</td>
          <td>${summary.sharpe.p5.toFixed(2)}</td>
          <td>${summary.sharpe.p25.toFixed(2)}</td>
          <td style="font-weight: 700; color: #fff;">${summary.sharpe.median.toFixed(2)}</td>
          <td>${summary.sharpe.p75.toFixed(2)}</td>
          <td class="good">${summary.sharpe.p95.toFixed(2)}</td>
        </tr>
      </tbody>
    </table>
  </div>
</div>
</body>
</html>`;

  return html;
}
