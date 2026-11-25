// exportHtmlReport.js — Standalone Interactive Offline HTML Monte Carlo Report Generator
// Injects quantitative econometric data D into authentic ANUBIS HTML report template

import { buildFullAnubisData } from './monteCarloCore.js';
import reportTemplate from './reportTemplate.html?raw';

export function generateHtmlReport(dataset, simResult, options = {}, isDataset = null, oosDataset = null) {
  const fullDs = dataset;
  const isDs = isDataset || dataset;
  const oosDs = oosDataset || dataset;

  const anubisData = buildFullAnubisData(isDs, oosDs, fullDs);
  const jsonStringD = JSON.stringify(anubisData);

  const title = `Monte Carlo Interaktif · ${fullDs.sourceName}`;
  const subTitle = `Quantitative Ledger & Strategy Audit · ${fullDs.N} Trades (${fullDs.stats.startDateStr} to ${fullDs.stats.endDateStr}) · Initial Capital $${(options.startCapital || 100000).toLocaleString()}`;

  let html = reportTemplate;

  // Replace Title & Subtitle in HTML header
  html = html.replace(/<title>.*?<\/title>/i, `<title>${title}</title>`);
  html = html.replace(/<h1>.*?<\/h1>/i, `<h1>${title}</h1>`);
  html = html.replace(/<div class="sub">.*?<\/div>/i, `<div class="sub">${subTitle}</div>`);

  // Replace badges
  const badgesHtml = `<div class="badges">
      <span class="badge is">IN-SAMPLE (${isDs.N} trades)</span>
      <span class="badge oos">OUT-OF-SAMPLE (${oosDs.N} trades)</span>
      <span class="badge">10.000 path / metode · seed 20261114</span>
      <span class="badge warn">MAE-Adjusted Drawdown &amp; Cost Haircut Stress Test</span>
    </div>`;
  html = html.replace(/<div class="badges">[\s\S]*?<\/div>/i, badgesHtml);

  // Replace data placeholder
  html = html.replace('/*__ANUBIS_DATA_D__*/', `const D = ${jsonStringD};\n`);

  return html;
}
