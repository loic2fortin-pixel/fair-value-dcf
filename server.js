'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 5187;
const SEC_UA = 'DCF-Valuation-Tool research-tool@localhost';

// ---------------------------------------------------------------------------
// Ticker / company search index (bundled locally, no live fetch required)
// ---------------------------------------------------------------------------

const TICKERS_PATH = path.join(__dirname, 'data', 'company_tickers.json');
let searchIndex = [];

function loadTickerIndex() {
  const raw = JSON.parse(fs.readFileSync(TICKERS_PATH, 'utf8'));
  searchIndex = Object.values(raw).map((row) => ({
    ticker: row.ticker,
    name: row.title,
    cik: String(row.cik_str).padStart(10, '0'),
  }));
  console.log(`Loaded ${searchIndex.length} tickers from SEC company_tickers.json`);
}

function searchCompanies(query, limit = 8) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const starts = [];
  const contains = [];
  for (const row of searchIndex) {
    const t = row.ticker.toLowerCase();
    const n = row.name.toLowerCase();
    if (t === q) {
      starts.unshift(row);
    } else if (t.startsWith(q) || n.startsWith(q)) {
      starts.push(row);
    } else if (n.includes(q)) {
      contains.push(row);
    }
    if (starts.length >= limit) break;
  }
  return starts.concat(contains).slice(0, limit);
}

// ---------------------------------------------------------------------------
// HTTPS helpers
// ---------------------------------------------------------------------------

function fetchJson(url, headers, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers, timeout: timeoutMs }, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`Bad JSON from ${url}: ${e.message}`)); }
      });
    });
    req.on('timeout', () => req.destroy(new Error(`Timeout fetching ${url}`)));
    req.on('error', reject);
  });
}

async function fetchWithRetry(url, headers, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try { return await fetchJson(url, headers); }
    catch (e) { lastErr = e; await new Promise((r) => setTimeout(r, 400 * (i + 1))); }
  }
  throw lastErr;
}

function fetchText(url, headers, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers, timeout: timeoutMs }, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve(data));
    });
    req.on('timeout', () => req.destroy(new Error(`Timeout fetching ${url}`)));
    req.on('error', reject);
  });
}

async function fetchTextWithRetry(url, headers, attempts = 2) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try { return await fetchText(url, headers); }
    catch (e) { lastErr = e; await new Promise((r) => setTimeout(r, 400 * (i + 1))); }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// SEC XBRL extraction
// ---------------------------------------------------------------------------

// Three traps in SEC's companyfacts API, all handled here:
//
// 1. Companies switch XBRL tags mid-history (NVIDIA moved off
//    RevenueFromContractWithCustomerExcludingAssessedTax onto plain Revenues around FY2023),
//    so picking only the first tag that has *any* data strands you on a stale series. Fix:
//    merge every tag variant together instead of stopping at the first match.
//
// 2. A 10-K's XBRL includes quarterly comparatives alongside the annual total, all stamped
//    with the *filing's* fy/fp/form/filed metadata regardless of the fact's own duration. Fix:
//    drop duration facts spanning under 300 days; instant facts (no "start") pass through.
//
// 3. Worse, a 10-K's multi-year comparative income statement tags two or three different
//    fiscal years' full-year figures with that SAME filing-level 'fy' label (e.g. one NVIDIA
//    10-K tags its own year, plus the prior two years' totals, all as fy:2026). Deduping by
//    that label silently collapses distinct years into one, keeping whichever happened to be
//    inserted first. Fix: key by the fact's own period-end date instead of SEC's fy label -
//    that uniquely identifies the real period no matter how the filing tags it.
function annualPointsFor(facts, taxonomy, tags) {
  const byEnd = new Map();
  for (const tag of tags) {
    const node = facts[taxonomy] && facts[taxonomy][tag];
    const units = node && node.units && (node.units.USD || node.units.shares || node.units['USD/shares']);
    if (!units) continue;
    for (const entry of units) {
      if (entry.fp !== 'FY') continue;
      if (entry.val === undefined || entry.val === null || !entry.end) continue;
      if (entry.form !== '10-K' && entry.form !== '10-K/A') continue;
      if (entry.start) {
        const days = (new Date(entry.end) - new Date(entry.start)) / 86400000;
        if (days < 300) continue; // a quarterly/partial-period fact riding along on the annual filing
      }
      const existing = byEnd.get(entry.end);
      if (!existing || (entry.filed && entry.filed > existing.filed)) {
        byEnd.set(entry.end, entry);
      }
    }
  }
  return Array.from(byEnd.values())
    .sort((a, b) => new Date(a.end) - new Date(b.end))
    .map((p) => ({ fy: parseInt(p.end.slice(0, 4), 10), val: p.val, end: p.end }));
}

function latestVal(points) {
  if (!points.length) return null;
  return points[points.length - 1].val;
}

function seriesByFy(points) {
  return new Map(points.map((p) => [p.fy, p.val]));
}

// Blended effective tax rate across available years, clipped to a normalized band.
// Real DCFs use a normalized rate rather than one noisy year's effective rate.
function effectiveTaxRate(pretaxPoints, taxPoints) {
  const ptByFy = seriesByFy(pretaxPoints);
  const txByFy = seriesByFy(taxPoints);
  const rates = [];
  for (const [fy, pretax] of ptByFy) {
    if (pretax > 0 && txByFy.has(fy)) {
      const r = txByFy.get(fy) / pretax;
      if (r > 0 && r < 0.5) rates.push(r);
    }
  }
  if (!rates.length) return 0.21; // US statutory federal rate as a fallback
  const avg = rates.reduce((a, b) => a + b, 0) / rates.length;
  return Math.min(0.3, Math.max(0.15, avg));
}

function extractFinancials(companyFacts) {
  const facts = companyFacts.facts || {};

  const ocf = annualPointsFor(facts, 'us-gaap', [
    'NetCashProvidedByUsedInOperatingActivities',
    'NetCashProvidedByUsedInOperatingActivitiesContinuingOperations',
  ]);
  const capex = annualPointsFor(facts, 'us-gaap', [
    'PaymentsToAcquirePropertyPlantAndEquipment',
    'PaymentsForCapitalImprovements',
    'PaymentsToAcquireProductiveAssets',
  ]);
  const netIncome = annualPointsFor(facts, 'us-gaap', ['NetIncomeLoss']);
  const revenue = annualPointsFor(facts, 'us-gaap', [
    'RevenueFromContractWithCustomerExcludingAssessedTax',
    'Revenues',
  ]);
  const opIncome = annualPointsFor(facts, 'us-gaap', ['OperatingIncomeLoss']);
  const da = annualPointsFor(facts, 'us-gaap', [
    'DepreciationDepletionAndAmortization',
    'DepreciationAmortizationAndAccretionNet',
    'DepreciationAndAmortization',
  ]);
  const cash = annualPointsFor(facts, 'us-gaap', [
    'CashAndCashEquivalentsAtCarryingValue',
    'CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents',
  ]);
  const longDebt = annualPointsFor(facts, 'us-gaap', ['LongTermDebtNoncurrent', 'LongTermDebt']);
  const shortDebt = annualPointsFor(facts, 'us-gaap', ['LongTermDebtCurrent', 'DebtCurrent']);
  const sharesA = annualPointsFor(facts, 'dei', ['EntityCommonStockSharesOutstanding']);
  const sharesB = annualPointsFor(facts, 'us-gaap', ['CommonStockSharesOutstanding']);
  const pretaxIncome = annualPointsFor(facts, 'us-gaap', [
    'IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest',
    'IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments',
  ]);
  const taxExpense = annualPointsFor(facts, 'us-gaap', ['IncomeTaxExpenseBenefit']);
  const interestExpense = annualPointsFor(facts, 'us-gaap', [
    'InterestExpense', 'InterestExpenseDebt', 'InterestAndDebtExpense',
  ]);

  const taxRate = effectiveTaxRate(pretaxIncome, taxExpense);

  // Unlevered free cash flow to the firm (FCFF): the standard DCF input.
  // Textbook has two equivalent routes to it - EBIT(1-t) + D&A - CapEx - deltaNWC, or
  // CFO + Interest(1-t) - CapEx (CFO already nets out D&A add-backs and working-capital
  // moves internally). The CFO route is used here because operating cash flow and CapEx
  // are tagged near-universally in SEC filings, while EBIT/D&A/current-asset tags vary
  // enough by filer (NVIDIA, Alphabet, etc.) that requiring all of them left some large
  // caps with no usable history at all. Interest expense defaults to 0 for a given year
  // if untagged, which is a reasonable read for low-debt companies and just collapses to
  // the familiar OCF - CapEx.
  const ocfByFy = seriesByFy(ocf);
  const capexByFy = seriesByFy(capex);
  const interestByFy = seriesByFy(interestExpense);
  const fcffHistory = [];
  for (const [fy, cfo] of ocfByFy) {
    if (!capexByFy.has(fy)) continue;
    const interestAddBack = (interestByFy.get(fy) || 0) * (1 - taxRate);
    const fcff = cfo + interestAddBack - Math.abs(capexByFy.get(fy));
    fcffHistory.push({ fy, fcf: fcff });
  }
  fcffHistory.sort((a, b) => a.fy - b.fy);

  const shares = sharesA.length ? sharesA : sharesB;
  const latestInterestExpense = latestVal(interestExpense);
  const latestLongDebtV = latestVal(longDebt);
  const latestShortDebtV = latestVal(shortDebt);
  const totalDebt = (latestLongDebtV || 0) + (latestShortDebtV || 0);

  return {
    fcfHistory: fcffHistory.slice(-6),
    latestFcf: fcffHistory.length ? fcffHistory[fcffHistory.length - 1].fcf : null,
    latestNetIncome: latestVal(netIncome),
    latestRevenue: latestVal(revenue),
    latestOpIncome: latestVal(opIncome),
    latestDA: latestVal(da),
    latestCash: latestVal(cash),
    latestLongDebt: latestLongDebtV,
    latestShortDebt: latestShortDebtV,
    latestShares: latestVal(shares),
    revenueHistory: revenue.slice(-6),
    taxRate,
    costOfDebtRaw: (latestInterestExpense && totalDebt > 0) ? latestInterestExpense / totalDebt : null,
    totalDebt,
  };
}

function cagr(points, valueKey) {
  const usable = points.filter((p) => (valueKey ? p[valueKey] : p.val) > 0);
  if (usable.length < 2) return null;
  const first = usable[0];
  const last = usable[usable.length - 1];
  const years = last.fy - first.fy;
  if (years <= 0) return null;
  const firstVal = valueKey ? first[valueKey] : first.val;
  const lastVal = valueKey ? last[valueKey] : last.val;
  if (firstVal <= 0 || lastVal <= 0) return null;
  return Math.pow(lastVal / firstVal, 1 / years) - 1;
}

// ---------------------------------------------------------------------------
// Yahoo price
// ---------------------------------------------------------------------------

async function fetchPrice(ticker) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=5d`;
  const json = await fetchWithRetry(url, { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }, 3);
  const meta = json && json.chart && json.chart.result && json.chart.result[0] && json.chart.result[0].meta;
  if (!meta || meta.regularMarketPrice === undefined) throw new Error('No price data returned');
  return {
    price: meta.regularMarketPrice,
    currency: meta.currency,
    exchange: meta.fullExchangeName || meta.exchangeName,
    previousClose: meta.chartPreviousClose,
  };
}

// ---------------------------------------------------------------------------
// CAPM: real regression beta + risk-free rate -> a WACC actually derived from
// market data, instead of a guessed slider default.
// ---------------------------------------------------------------------------

const EQUITY_RISK_PREMIUM = 0.05; // standard long-run assumption

async function fetchWeeklyReturns(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1wk&range=2y`;
  const json = await fetchWithRetry(url, { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }, 3);
  const result = json && json.chart && json.chart.result && json.chart.result[0];
  const closes = result && result.indicators && result.indicators.quote && result.indicators.quote[0] && result.indicators.quote[0].close;
  if (!closes) throw new Error('No weekly price history for ' + symbol);
  const prices = closes.filter((c) => typeof c === 'number');
  const returns = [];
  for (let i = 1; i < prices.length; i++) returns.push(prices[i] / prices[i - 1] - 1);
  return returns;
}

function computeBeta(stockReturns, marketReturns) {
  const n = Math.min(stockReturns.length, marketReturns.length);
  if (n < 20) return null; // not enough overlapping history for a meaningful regression
  const s = stockReturns.slice(-n), m = marketReturns.slice(-n);
  const meanS = s.reduce((a, b) => a + b, 0) / n;
  const meanM = m.reduce((a, b) => a + b, 0) / n;
  let cov = 0, varM = 0;
  for (let i = 0; i < n; i++) {
    cov += (s[i] - meanS) * (m[i] - meanM);
    varM += (m[i] - meanM) ** 2;
  }
  cov /= n; varM /= n;
  return varM > 0 ? cov / varM : null;
}

async function fetchBeta(ticker) {
  const [stock, market] = await Promise.all([
    fetchWeeklyReturns(ticker),
    fetchWeeklyReturns('^GSPC'),
  ]);
  return computeBeta(stock, market);
}

async function fetchRiskFreeRate() {
  try {
    const csv = await fetchTextWithRetry('https://fred.stlouisfed.org/graph/fredgraph.csv?id=DGS10', {}, 2);
    const lines = csv.trim().split('\n');
    for (let i = lines.length - 1; i >= 1; i--) {
      const parts = lines[i].split(',');
      const num = parseFloat(parts[1]);
      if (Number.isFinite(num)) return num / 100;
    }
  } catch (e) { /* fall through to default */ }
  return 0.042; // reasonable fallback if FRED is unreachable
}

// WACC = weight_equity x CostOfEquity + weight_debt x CostOfDebt x (1 - tax)
// CostOfEquity via CAPM = riskFree + beta x equityRiskPremium
//
// The raw 2-year regression beta is noisy, especially for volatile single names (a memory
// chipmaker can regress to a beta north of 2.5 depending on which two years you sample).
// Standard practitioner correction is the Blume adjustment - published by Bloomberg and
// Value Line for exactly this reason - which shrinks the raw beta a third of the way toward
// the market average of 1.0: adjusted = raw x 2/3 + 1.0 x 1/3. It reflects the empirical
// finding that betas mean-revert over time, not a thumb on the scale to move the answer.
function computeWacc({ beta, riskFreeRate, costOfDebtRaw, taxRate, marketCap, totalDebt }) {
  const rawBeta = beta != null ? Math.min(3, Math.max(0.2, beta)) : 1;
  const effectiveBeta = rawBeta * (2 / 3) + 1.0 * (1 / 3);
  const costOfEquity = riskFreeRate + effectiveBeta * EQUITY_RISK_PREMIUM;
  const E = marketCap || 0, D = totalDebt || 0;
  const total = E + D || 1;
  const weightEquity = E / total, weightDebt = D / total;
  const costOfDebt = costOfDebtRaw != null ? Math.min(0.15, Math.max(riskFreeRate, costOfDebtRaw)) : riskFreeRate + 0.015;
  const wacc = weightEquity * costOfEquity + weightDebt * costOfDebt * (1 - taxRate);
  return {
    wacc: Math.min(0.22, Math.max(0.03, wacc)),
    beta: effectiveBeta,
    rawBeta,
    betaSource: beta != null ? 'regression, Blume-adjusted' : 'default (insufficient price history)',
    costOfEquity, costOfDebt, weightEquity, weightDebt, riskFreeRate, equityRiskPremium: EQUITY_RISK_PREMIUM,
  };
}

// ---------------------------------------------------------------------------
// Analyst sentiment (Nasdaq public data API)
// ---------------------------------------------------------------------------

const NASDAQ_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Accept': 'application/json',
};

function parseMoneyString(s) {
  if (!s || typeof s !== 'string') return null;
  const n = parseFloat(s.replace(/[$,]/g, ''));
  return Number.isFinite(n) ? n : null;
}

async function fetchAnalystSentiment(ticker) {
  const [summary, ratings, forecast] = await Promise.allSettled([
    fetchWithRetry(`https://api.nasdaq.com/api/quote/${encodeURIComponent(ticker)}/summary?assetclass=stocks`, NASDAQ_HEADERS, 2),
    fetchWithRetry(`https://api.nasdaq.com/api/analyst/${encodeURIComponent(ticker)}/ratings`, NASDAQ_HEADERS, 2),
    fetchWithRetry(`https://api.nasdaq.com/api/analyst/${encodeURIComponent(ticker)}/earnings-forecast`, NASDAQ_HEADERS, 2),
  ]);

  const out = {
    priceTarget: null, meanRating: null, analystCount: null,
    forwardEps: null, forwardEpsFiscalEnd: null, forwardEpsCount: null,
    sector: null, industry: null,
  };

  if (summary.status === 'fulfilled') {
    const sd = summary.value && summary.value.data && summary.value.data.summaryData;
    out.priceTarget = sd && parseMoneyString(sd.OneYrTarget && sd.OneYrTarget.value);
    out.sector = sd && sd.Sector && sd.Sector.value || null;
    out.industry = sd && sd.Industry && sd.Industry.value || null;
  }

  if (ratings.status === 'fulfilled') {
    const rd = ratings.value && ratings.value.data;
    if (rd) {
      out.meanRating = rd.meanRatingType || null;
      const m = rd.ratingsSummary && rd.ratingsSummary.match(/(\d+)\s+analysts?/i);
      out.analystCount = m ? parseInt(m[1], 10) : null;
    }
  }

  if (forecast.status === 'fulfilled') {
    const rows = forecast.value && forecast.value.data && forecast.value.data.yearlyForecast && forecast.value.data.yearlyForecast.rows;
    const nextFy = rows && rows[0];
    if (nextFy && typeof nextFy.consensusEPSForecast === 'number') {
      out.forwardEps = nextFy.consensusEPSForecast;
      out.forwardEpsFiscalEnd = nextFy.fiscalEnd;
      out.forwardEpsCount = nextFy.noOfEstimates;
    }
  }

  if (out.priceTarget === null && out.meanRating === null && out.forwardEps === null) return null;
  return out;
}

// ---------------------------------------------------------------------------
// Business description (Wikipedia's public summary API - free, no key)
// ---------------------------------------------------------------------------

const WIKI_HEADERS = { 'User-Agent': 'Fair-Value-DCF-Tool/1.0 (educational project)' };

async function fetchBusinessSummary(companyName) {
  try {
    const searchUrl = 'https://en.wikipedia.org/w/api.php?action=opensearch&limit=1&namespace=0&format=json&search=' + encodeURIComponent(companyName);
    const searchResult = await fetchWithRetry(searchUrl, WIKI_HEADERS, 2);
    const title = searchResult && searchResult[1] && searchResult[1][0];
    if (!title) return null;
    const summaryUrl = 'https://en.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(title);
    const summary = await fetchWithRetry(summaryUrl, WIKI_HEADERS, 2);
    if (!summary || !summary.extract || summary.type === 'disambiguation') return null;
    return { extract: summary.extract, title: summary.title, wikiUrl: summary.content_urls && summary.content_urls.desktop && summary.content_urls.desktop.page };
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

async function handleSearch(req, res, query) {
  const results = searchCompanies(query.q || '');
  sendJson(res, 200, { results });
}

async function handleValuation(req, res, query) {
  const tickerQ = (query.ticker || '').trim().toUpperCase();
  if (!tickerQ) return sendJson(res, 400, { error: 'Missing ticker' });

  const match = searchIndex.find((r) => r.ticker === tickerQ);
  if (!match) return sendJson(res, 404, { error: `Ticker "${tickerQ}" not found in SEC filer list. Try the exact ticker symbol.` });

  let companyFacts;
  try {
    companyFacts = await fetchWithRetry(
      `https://data.sec.gov/api/xbrl/companyfacts/CIK${match.cik}.json`,
      { 'User-Agent': SEC_UA },
      3
    );
  } catch (e) {
    return sendJson(res, 502, { error: `Could not fetch SEC financial data for ${tickerQ}: ${e.message}` });
  }

  const [priceResult, analystResult, betaResult, riskFreeResult, businessResult] = await Promise.allSettled([
    fetchPrice(tickerQ),
    fetchAnalystSentiment(tickerQ),
    fetchBeta(tickerQ),
    fetchRiskFreeRate(),
    fetchBusinessSummary(match.name),
  ]);
  const priceInfo = priceResult.status === 'fulfilled' ? priceResult.value : null;
  const analyst = analystResult.status === 'fulfilled' ? analystResult.value : null;
  const beta = betaResult.status === 'fulfilled' ? betaResult.value : null;
  const riskFreeRate = riskFreeResult.status === 'fulfilled' ? riskFreeResult.value : 0.042;
  const business = businessResult.status === 'fulfilled' ? businessResult.value : null;

  const fin = extractFinancials(companyFacts);
  const fcfGrowth = cagr(fin.fcfHistory, 'fcf');
  const revGrowth = cagr(fin.revenueHistory);
  const netDebt = (fin.latestLongDebt || 0) + (fin.latestShortDebt || 0) - (fin.latestCash || 0);
  const marketCap = (priceInfo && fin.latestShares) ? priceInfo.price * fin.latestShares : null;

  const waccEstimate = computeWacc({
    beta, riskFreeRate,
    costOfDebtRaw: fin.costOfDebtRaw,
    taxRate: fin.taxRate,
    marketCap, totalDebt: fin.totalDebt,
  });

  sendJson(res, 200, {
    company: { ticker: match.ticker, name: match.name, cik: match.cik },
    price: priceInfo,
    analyst,
    business,
    financials: fin,
    estimatedGrowth: {
      fcfCagr: fcfGrowth,
      revenueCagr: revGrowth,
    },
    waccEstimate,
    netDebt,
    asOf: new Date().toISOString(),
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

// ---------------------------------------------------------------------------
// Static file serving
// ---------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

function serveStatic(req, res, urlPath) {
  let filePath = urlPath === '/' ? '/index.html' : urlPath;
  filePath = path.join(__dirname, 'public', path.normalize(filePath).replace(/^([.]{2}[/\\])+/, ''));
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

loadTickerIndex();

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const query = Object.fromEntries(url.searchParams.entries());

  if (url.pathname === '/api/search') return void handleSearch(req, res, query);
  if (url.pathname === '/api/valuation') return void handleValuation(req, res, query).catch((e) => sendJson(res, 500, { error: e.message }));
  return serveStatic(req, res, url.pathname);
});

server.listen(PORT, () => {
  console.log(`DCF Valuator running at http://localhost:${PORT}`);
});
