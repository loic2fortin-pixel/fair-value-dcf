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

function annualPointsFor(facts, taxonomy, tags) {
  for (const tag of tags) {
    const node = facts[taxonomy] && facts[taxonomy][tag];
    const units = node && node.units && (node.units.USD || node.units.shares || node.units['USD/shares']);
    if (!units) continue;
    const byFy = new Map();
    for (const entry of units) {
      if (entry.fp !== 'FY') continue;
      if (!entry.fy || entry.val === undefined || entry.val === null) continue;
      // an FY can appear in multiple filings (10-K, 10-K/A); keep the most recently filed
      const existing = byFy.get(entry.fy);
      if (!existing || (entry.filed && entry.filed > existing.filed)) {
        byFy.set(entry.fy, entry);
      }
    }
    const points = Array.from(byFy.values())
      .filter((e) => e.form === '10-K' || e.form === '10-K/A')
      .sort((a, b) => a.fy - b.fy);
    if (points.length) return points.map((p) => ({ fy: p.fy, val: p.val, end: p.end }));
  }
  return [];
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
  const currentAssets = annualPointsFor(facts, 'us-gaap', ['AssetsCurrent']);
  const currentLiabilities = annualPointsFor(facts, 'us-gaap', ['LiabilitiesCurrent']);
  const interestExpense = annualPointsFor(facts, 'us-gaap', [
    'InterestExpense', 'InterestExpenseDebt', 'InterestAndDebtExpense',
  ]);

  const taxRate = effectiveTaxRate(pretaxIncome, taxExpense);

  // Net working capital = (current assets excl. cash) - (current liabilities excl. short-term debt),
  // matched year over year to get the change (deltaNWC) that unlevered FCF subtracts.
  const caByFy = seriesByFy(currentAssets);
  const clByFy = seriesByFy(currentLiabilities);
  const cashByFy = seriesByFy(cash);
  const shortDebtByFy = seriesByFy(shortDebt);
  const nwcByFy = new Map();
  for (const [fy, ca] of caByFy) {
    if (!clByFy.has(fy)) continue;
    const nwc = (ca - (cashByFy.get(fy) || 0)) - (clByFy.get(fy) - (shortDebtByFy.get(fy) || 0));
    nwcByFy.set(fy, nwc);
  }

  // Unlevered free cash flow to the firm (FCFF): the standard DCF input.
  // FCFF = EBIT x (1 - tax) + D&A - CapEx - deltaNWC
  const opByFy = seriesByFy(opIncome);
  const daByFy = seriesByFy(da);
  const capexByFy = seriesByFy(capex);
  const fcffHistory = [];
  for (const [fy, ebit] of opByFy) {
    if (!daByFy.has(fy) || !capexByFy.has(fy)) continue;
    const nwcNow = nwcByFy.get(fy);
    const nwcPrev = nwcByFy.get(fy - 1);
    const deltaNwc = (nwcNow != null && nwcPrev != null) ? (nwcNow - nwcPrev) : 0;
    const nopat = ebit * (1 - taxRate);
    const fcff = nopat + daByFy.get(fy) - Math.abs(capexByFy.get(fy)) - deltaNwc;
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
function computeWacc({ beta, riskFreeRate, costOfDebtRaw, taxRate, marketCap, totalDebt }) {
  const effectiveBeta = beta != null ? Math.min(3, Math.max(0.2, beta)) : 1;
  const costOfEquity = riskFreeRate + effectiveBeta * EQUITY_RISK_PREMIUM;
  const E = marketCap || 0, D = totalDebt || 0;
  const total = E + D || 1;
  const weightEquity = E / total, weightDebt = D / total;
  const costOfDebt = costOfDebtRaw != null ? Math.min(0.15, Math.max(riskFreeRate, costOfDebtRaw)) : riskFreeRate + 0.015;
  const wacc = weightEquity * costOfEquity + weightDebt * costOfDebt * (1 - taxRate);
  return {
    wacc: Math.min(0.22, Math.max(0.03, wacc)),
    beta: effectiveBeta,
    betaSource: beta != null ? 'regression' : 'default (insufficient price history)',
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
  };

  if (summary.status === 'fulfilled') {
    const sd = summary.value && summary.value.data && summary.value.data.summaryData;
    out.priceTarget = sd && parseMoneyString(sd.OneYrTarget && sd.OneYrTarget.value);
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

  const [priceResult, analystResult, betaResult, riskFreeResult] = await Promise.allSettled([
    fetchPrice(tickerQ),
    fetchAnalystSentiment(tickerQ),
    fetchBeta(tickerQ),
    fetchRiskFreeRate(),
  ]);
  const priceInfo = priceResult.status === 'fulfilled' ? priceResult.value : null;
  const analyst = analystResult.status === 'fulfilled' ? analystResult.value : null;
  const beta = betaResult.status === 'fulfilled' ? betaResult.value : null;
  const riskFreeRate = riskFreeResult.status === 'fulfilled' ? riskFreeResult.value : 0.042;

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
