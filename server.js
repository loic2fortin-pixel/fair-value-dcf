'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 5187;
const SEC_UA = 'DCF-Valuation-Tool research-tool@localhost';
const YAHOO_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

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

// Only used for Yahoo's crumb handshake, which needs the raw Set-Cookie header - fetchJson
// and fetchText both discard headers and reject on non-2xx before the caller can inspect
// either, neither of which works here.
function httpGetRaw(url, headers, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers, timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('timeout', () => req.destroy(new Error(`Timeout fetching ${url}`)));
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// In-memory TTL cache
// ---------------------------------------------------------------------------

// Every upstream call in handleValuation was being refetched from scratch on every request,
// even for a ticker someone had just looked up seconds earlier - the single biggest lever on
// repeat-lookup latency is not re-fetching data that hasn't changed. This is a plain Map-based
// TTL cache (fine for a single-instance app, no Redis needed) that also de-dupes concurrent
// requests for the same key: a second request that arrives while the first is still in flight
// awaits that same promise instead of firing a duplicate upstream call.
const cacheStore = new Map(); // key -> { value, expires }
const cachePending = new Map(); // key -> Promise

function cachedFetch(key, ttlMs, fn) {
  const hit = cacheStore.get(key);
  if (hit && Date.now() < hit.expires) return Promise.resolve(hit.value);
  if (cachePending.has(key)) return cachePending.get(key);
  const promise = (async () => {
    try {
      const value = await fn();
      cacheStore.set(key, { value, expires: Date.now() + ttlMs });
      return value;
    } finally {
      cachePending.delete(key);
    }
  })();
  cachePending.set(key, promise);
  return promise;
}

// TTLs sized to how often each source actually changes, not to some universal default.
const TTL = {
  PRICE: 45 * 1000, // live quote - stays fresh enough for 30-60s
  FACTS: 24 * 60 * 60 * 1000, // SEC XBRL filings update quarterly at most
  BUSINESS: 7 * 24 * 60 * 60 * 1000, // Wikipedia summaries barely change week to week
  ANALYST: 4 * 60 * 60 * 1000, // Nasdaq consensus/estimates move a few times a day
  BETA: 6 * 60 * 60 * 1000, // derived from weekly price history, not intraday-sensitive
  RISK_FREE: 24 * 60 * 60 * 1000, // 10y Treasury - published once a day
  FX: 24 * 60 * 60 * 1000, // FRED FX series - published once a day
  YAHOO_SEARCH: 30 * 60 * 1000, // company name -> symbol mapping doesn't change intraday
  YAHOO_AUTH: 50 * 60 * 1000, // session cookie + crumb - refreshed early, and on demand on a 401
};

// ---------------------------------------------------------------------------
// SEC XBRL extraction
// ---------------------------------------------------------------------------

const ANNUAL_FORMS = new Set(['10-K', '10-K/A', '20-F', '20-F/A', '40-F', '40-F/A']);

// Four traps in SEC's companyfacts API, all handled here:
//
// 1. Companies switch XBRL tags mid-history (NVIDIA moved off
//    RevenueFromContractWithCustomerExcludingAssessedTax onto plain Revenues around FY2023),
//    so picking only the first tag that has *any* data strands you on a stale series. Fix:
//    merge every tag variant together instead of stopping at the first match.
//
// 2. An annual filing's XBRL includes quarterly comparatives alongside the annual total, all
//    stamped with the *filing's* fy/fp/form/filed metadata regardless of the fact's own
//    duration. Fix: drop duration facts spanning under 300 days; instant facts (no "start")
//    pass through.
//
// 3. Worse, a filing's multi-year comparative income statement tags two or three different
//    fiscal years' full-year figures with that SAME filing-level 'fy' label (e.g. one NVIDIA
//    10-K tags its own year, plus the prior two years' totals, all as fy:2026). Deduping by
//    that label silently collapses distinct years into one, keeping whichever happened to be
//    inserted first. Fix: key by the fact's own period-end date instead of SEC's fy label -
//    that uniquely identifies the real period no matter how the filing tags it.
//
// 4. Foreign private issuers (most large Canadian companies among them) file 20-F/40-F
//    instead of 10-K, report under the ifrs-full taxonomy instead of us-gaap, and often in a
//    non-USD currency. `sources` is a list of [taxonomy, tag] pairs so a caller can supply
//    both us-gaap and ifrs-full equivalents together; every currency-coded unit key SEC uses
//    (not just USD) is checked, and each returned point carries its own currency so the
//    caller can convert.
function annualPointsFor(facts, sources) {
  const byEnd = new Map();
  for (const [taxonomy, tag] of sources) {
    const node = facts[taxonomy] && facts[taxonomy][tag];
    if (!node || !node.units) continue;
    for (const unitKey of Object.keys(node.units)) {
      const isMonetary = /^[A-Z]{3}$/.test(unitKey);
      if (!isMonetary && unitKey !== 'shares' && unitKey !== 'USD/shares') continue;
      for (const entry of node.units[unitKey]) {
        if (entry.fp !== 'FY') continue;
        if (entry.val === undefined || entry.val === null || !entry.end) continue;
        if (!ANNUAL_FORMS.has(entry.form)) continue;
        if (entry.start) {
          const days = (new Date(entry.end) - new Date(entry.start)) / 86400000;
          if (days < 300) continue; // a quarterly/partial-period fact riding along on the annual filing
        }
        const existing = byEnd.get(entry.end);
        if (!existing || (entry.filed && entry.filed > existing.filed)) {
          byEnd.set(entry.end, { ...entry, currency: isMonetary ? unitKey : null });
        }
      }
    }
  }
  return Array.from(byEnd.values())
    .sort((a, b) => new Date(a.end) - new Date(b.end))
    .map((p) => ({ fy: parseInt(p.end.slice(0, 4), 10), val: p.val, end: p.end, currency: p.currency }));
}

// A company reports consistently in one currency; detect it from whichever core concept
// has data, so every other series pulled for the same company can be converted the same way.
function detectCurrency(facts) {
  const candidates = [
    ['us-gaap', 'NetIncomeLoss'], ['ifrs-full', 'ProfitLoss'],
    ['us-gaap', 'Revenues'], ['ifrs-full', 'Revenue'],
  ];
  for (const [taxonomy, tag] of candidates) {
    const node = facts[taxonomy] && facts[taxonomy][tag];
    if (!node || !node.units) continue;
    const codes = Object.keys(node.units).filter((k) => /^[A-Z]{3}$/.test(k));
    if (codes.includes('USD')) return 'USD';
    if (codes.length) return codes[0];
  }
  return 'USD';
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

// Monetary series come back tagged with the currency they were reported in (`p.currency`);
// share-count series carry `currency: null` and pass through untouched. Converting here
// rather than inside annualPointsFor keeps that function currency-agnostic and lets the
// caller decide the rate once per company instead of threading it through every tag list.
function toUsd(points, fxRate) {
  if (fxRate === 1) return points;
  return points.map((p) => (p.currency ? { ...p, val: p.val * fxRate } : p));
}

function extractFinancials(companyFacts, fxRate = 1) {
  const facts = companyFacts.facts || {};

  const ocf = toUsd(annualPointsFor(facts, [
    ['us-gaap', 'NetCashProvidedByUsedInOperatingActivities'],
    ['us-gaap', 'NetCashProvidedByUsedInOperatingActivitiesContinuingOperations'],
  ]), fxRate);
  const capex = toUsd(annualPointsFor(facts, [
    ['us-gaap', 'PaymentsToAcquirePropertyPlantAndEquipment'],
    ['us-gaap', 'PaymentsForCapitalImprovements'],
    ['us-gaap', 'PaymentsToAcquireProductiveAssets'],
  ]), fxRate);
  const netIncome = toUsd(annualPointsFor(facts, [
    ['us-gaap', 'NetIncomeLoss'],
    ['ifrs-full', 'ProfitLoss'],
  ]), fxRate);
  const revenue = toUsd(annualPointsFor(facts, [
    ['us-gaap', 'RevenueFromContractWithCustomerExcludingAssessedTax'],
    ['us-gaap', 'Revenues'],
    ['ifrs-full', 'Revenue'],
  ]), fxRate);
  const opIncome = toUsd(annualPointsFor(facts, [['us-gaap', 'OperatingIncomeLoss']]), fxRate);
  // Not every filer tags a single combined D&A figure - Microsoft, for one, splits it into
  // separate Depreciation and AmortizationOfIntangibleAssets concepts. Try the combined tag
  // first; if that's empty, sum the two separate series by period end date instead of
  // returning nothing (which was silently killing the EV/EBITDA comp and the exit-multiple
  // terminal-value cross-check for exactly the filers that split it out).
  let da = toUsd(annualPointsFor(facts, [
    ['us-gaap', 'DepreciationDepletionAndAmortization'],
    ['us-gaap', 'DepreciationAmortizationAndAccretionNet'],
    ['us-gaap', 'DepreciationAndAmortization'],
    ['ifrs-full', 'DepreciationAndAmortisationExpense'],
  ]), fxRate);
  if (!da.length) {
    const depreciationOnly = toUsd(annualPointsFor(facts, [['us-gaap', 'Depreciation']]), fxRate);
    const amortizationOnly = toUsd(annualPointsFor(facts, [
      ['us-gaap', 'AmortizationOfIntangibleAssets'],
      ['us-gaap', 'FiniteLivedIntangibleAssetsAmortizationExpense'],
    ]), fxRate);
    if (depreciationOnly.length) {
      const amortByEnd = new Map(amortizationOnly.map((p) => [p.end, p.val]));
      da = depreciationOnly.map((p) => ({ fy: p.fy, end: p.end, val: p.val + (amortByEnd.get(p.end) || 0) }));
    }
  }
  const cash = toUsd(annualPointsFor(facts, [
    ['us-gaap', 'CashAndCashEquivalentsAtCarryingValue'],
    ['us-gaap', 'CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents'],
    ['ifrs-full', 'CashAndCashEquivalents'],
  ]), fxRate);
  const longDebt = toUsd(annualPointsFor(facts, [['us-gaap', 'LongTermDebtNoncurrent'], ['us-gaap', 'LongTermDebt']]), fxRate);
  const shortDebt = toUsd(annualPointsFor(facts, [['us-gaap', 'LongTermDebtCurrent'], ['us-gaap', 'DebtCurrent']]), fxRate);
  const sharesA = annualPointsFor(facts, [['dei', 'EntityCommonStockSharesOutstanding']]);
  const sharesB = annualPointsFor(facts, [['us-gaap', 'CommonStockSharesOutstanding']]);
  const pretaxIncome = toUsd(annualPointsFor(facts, [
    ['us-gaap', 'IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest'],
    ['us-gaap', 'IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments'],
    ['ifrs-full', 'ProfitLossBeforeTax'],
  ]), fxRate);
  const taxExpense = toUsd(annualPointsFor(facts, [
    ['us-gaap', 'IncomeTaxExpenseBenefit'],
    ['ifrs-full', 'IncomeTaxExpenseContinuingOperations'],
  ]), fxRate);
  const interestExpense = toUsd(annualPointsFor(facts, [
    ['us-gaap', 'InterestExpense'], ['us-gaap', 'InterestExpenseDebt'], ['us-gaap', 'InterestAndDebtExpense'],
    ['ifrs-full', 'InterestExpense'],
  ]), fxRate);

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

// Log-linear regression across every available year, not just the first and last -
// a naive endpoint-to-endpoint CAGR is entirely at the mercy of whichever single year
// happens to sit at each end (a one-off tax payment or divestiture gain in just one year
// can swing it wildly). Fitting a trend line through all the points is far less sensitive
// to any one anomalous year.
function cagr(points, valueKey) {
  const usable = points.filter((p) => (valueKey ? p[valueKey] : p.val) > 0);
  if (usable.length < 2) return null;
  const xs = usable.map((p) => p.fy);
  const ys = usable.map((p) => Math.log(valueKey ? p[valueKey] : p.val));
  const n = xs.length;
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - meanX) * (ys[i] - meanY);
    den += (xs[i] - meanX) ** 2;
  }
  if (den === 0) return null;
  return Math.exp(num / den) - 1;
}

// ---------------------------------------------------------------------------
// Yahoo price
// ---------------------------------------------------------------------------

async function fetchPrice(ticker) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=5d`;
  const json = await fetchWithRetry(url, { 'User-Agent': YAHOO_UA }, 3);
  const meta = json && json.chart && json.chart.result && json.chart.result[0] && json.chart.result[0].meta;
  if (!meta || meta.regularMarketPrice === undefined) throw new Error('No price data returned');
  return {
    price: meta.regularMarketPrice,
    currency: meta.currency,
    exchange: meta.fullExchangeName || meta.exchangeName,
    previousClose: meta.chartPreviousClose,
    longName: meta.longName || meta.shortName || null,
  };
}

// ---------------------------------------------------------------------------
// CAPM: real regression beta + risk-free rate -> a WACC actually derived from
// market data, instead of a guessed slider default.
// ---------------------------------------------------------------------------

const EQUITY_RISK_PREMIUM = 0.05; // standard long-run assumption

async function fetchWeeklyReturns(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1wk&range=2y`;
  const json = await fetchWithRetry(url, { 'User-Agent': YAHOO_UA }, 3);
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

// Foreign private issuers (most large Canadian companies included) file with the SEC but
// report their financials in their home currency - Royal Bank of Canada's filings are in
// CAD, for instance. FRED publishes daily FX rates for free, no key required. `invert`
// reflects which side of the pair that series quotes (e.g. DEXCAUS is CAD per 1 USD, so
// converting a CAD amount to USD means dividing by it; DEXUSEU is USD per 1 EUR, so
// converting EUR to USD means multiplying).
const FX_SERIES = {
  CAD: { series: 'DEXCAUS', invert: true },
  EUR: { series: 'DEXUSEU', invert: false },
  GBP: { series: 'DEXUSUK', invert: false },
  JPY: { series: 'DEXJPUS', invert: true },
  CHF: { series: 'DEXSZUS', invert: true },
  AUD: { series: 'DEXUSAL', invert: false },
  CNY: { series: 'DEXCHUS', invert: true },
};

async function fetchFxRateToUsd(currency) {
  if (currency === 'USD') return 1;
  const spec = FX_SERIES[currency];
  if (!spec) return null; // unsupported currency - caller decides how to handle
  try {
    const csv = await fetchTextWithRetry('https://fred.stlouisfed.org/graph/fredgraph.csv?id=' + spec.series, {}, 2);
    const lines = csv.trim().split('\n');
    for (let i = lines.length - 1; i >= 1; i--) {
      const parts = lines[i].split(',');
      const num = parseFloat(parts[1]);
      if (Number.isFinite(num) && num > 0) return spec.invert ? 1 / num : num;
    }
  } catch (e) { /* fall through */ }
  return null;
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
  const [summary, ratings, forecast, growth] = await Promise.allSettled([
    fetchWithRetry(`https://api.nasdaq.com/api/quote/${encodeURIComponent(ticker)}/summary?assetclass=stocks`, NASDAQ_HEADERS, 2),
    fetchWithRetry(`https://api.nasdaq.com/api/analyst/${encodeURIComponent(ticker)}/ratings`, NASDAQ_HEADERS, 2),
    fetchWithRetry(`https://api.nasdaq.com/api/analyst/${encodeURIComponent(ticker)}/earnings-forecast`, NASDAQ_HEADERS, 2),
    fetchWithRetry(`https://api.nasdaq.com/api/company/${encodeURIComponent(ticker)}/earnings-growth`, NASDAQ_HEADERS, 2),
  ]);

  const out = {
    priceTarget: null, meanRating: null, analystCount: null,
    forwardEps: null, forwardEpsFiscalEnd: null, forwardEpsCount: null,
    sector: null, industry: null,
    longTermGrowth: null,
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

  if (growth.status === 'fulfilled') {
    const chart = growth.value && growth.value.data && growth.value.data.chart;
    const ltg = chart && chart.find((row) => row.x === 'Long Term 5 yr');
    if (ltg && typeof ltg.y === 'string') {
      const n = parseFloat(ltg.y);
      if (Number.isFinite(n)) out.longTermGrowth = n / 100;
    }
  }

  if (out.priceTarget === null && out.meanRating === null && out.forwardEps === null && out.longTermGrowth === null) return null;
  return out;
}

// ---------------------------------------------------------------------------
// Business description (Wikipedia's public summary API - free, no key)
// ---------------------------------------------------------------------------

const WIKI_HEADERS = { 'User-Agent': 'Fair-Value-DCF-Tool/1.0 (educational project)' };

// SEC filer names are things like "MICROSOFT CORP" or "ALPHABET INC" - searching that
// literally sends Wikipedia's relevance ranking off toward tangential pages (a "Microsoft
// Corp. v. European Commission" lawsuit once outranked the actual company page). The fix
// isn't to strip the corporate suffix, though - stripping "Inc" off "Alphabet Inc." turns
// the query into the bare word "Alphabet", which resolves to the Wikipedia article about
// writing systems instead of the company. So: try the name properly title-cased with its
// suffix intact first (closest match to the real page title), and only fall back to a
// stripped version if that attempt comes up empty. Either way, skip anything that reads
// like a court case.
function titleCase(name) {
  return name.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

function cleanCompanyName(name) {
  return name
    .replace(/[.,]/g, '')
    .replace(/\b(CORP(ORATION)?|INC|CO|COMPANY|LTD|LLC|PLC|LP|HOLDINGS?)\b\.?$/i, '')
    .trim();
}

function looksLikeLitigation(title) {
  return /\bv\.?\s|\bversus\b/i.test(title);
}

async function wikiSearchTitle(query) {
  const searchUrl = 'https://en.wikipedia.org/w/api.php?action=opensearch&limit=5&namespace=0&format=json&search=' + encodeURIComponent(query);
  const searchResult = await fetchWithRetry(searchUrl, WIKI_HEADERS, 2);
  const candidates = (searchResult && searchResult[1]) || [];
  return candidates.find((t) => !looksLikeLitigation(t)) || candidates[0] || null;
}

async function fetchBusinessSummary(companyName) {
  try {
    const primary = titleCase(companyName.replace(/[.,]/g, ''));
    let title = await wikiSearchTitle(primary);
    if (!title) {
      const cleaned = cleanCompanyName(companyName);
      if (cleaned) title = await wikiSearchTitle(cleaned);
    }
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
// TSX / non-SEC-filer fallback (Yahoo Finance fundamentals)
// ---------------------------------------------------------------------------

// The local search index and every extraction function above are built entirely from SEC
// EDGAR data, so a company that simply doesn't file with the SEC - Aritzia, Bombardier, and
// every other TSX/TSXV-only Canadian listing - has no data there at all, full stop, no matter
// what taxonomy or currency logic gets added. Yahoo Finance carries most of these under a
// ".TO"/".V"/"-B.TO"-style symbol, so unmatched tickers fall back to it here instead of a
// bare 404.
//
// Yahoo's fundamentals endpoint (quoteSummary) requires a session cookie + "crumb" token -
// undocumented, but stable in practice, and the same handshake yfinance and similar tools
// use. Its detailed multi-year financial-statement modules (incomeStatementHistory,
// balanceSheetHistory, cashflowStatementHistory) no longer return real line items for ANY
// ticker, US or foreign - Yahoo appears to have locked those down entirely. The `financialData`
// module still returns a real trailing-twelve-month snapshot (revenue, OCF, FCF, debt, cash,
// EBITDA), so that's what this uses instead of a multi-year history. Every caller downstream
// (cagr, median, the history chart) already degrades gracefully to "not enough history" with
// fewer than 2 data points, so a single-point snapshot doesn't break anything - it just means
// less trend data than the SEC path provides.

async function fetchYahooCrumb() {
  const cookieRes = await httpGetRaw('https://fc.yahoo.com', { 'User-Agent': YAHOO_UA });
  const setCookie = cookieRes.headers['set-cookie'];
  if (!setCookie || !setCookie.length) throw new Error('Could not obtain a Yahoo session cookie');
  const cookie = setCookie.map((c) => c.split(';')[0]).join('; ');
  const crumbRes = await httpGetRaw('https://query2.finance.yahoo.com/v1/test/getcrumb', { 'User-Agent': YAHOO_UA, Cookie: cookie });
  const crumb = (crumbRes.body || '').trim();
  if (!crumb || crumb.startsWith('{')) throw new Error('Could not obtain a Yahoo crumb');
  return { cookie, crumb };
}

async function fetchYahooQuoteSummary(symbol, modules) {
  async function attempt() {
    const { cookie, crumb } = await cachedFetch('yahooAuth', TTL.YAHOO_AUTH, fetchYahooCrumb);
    const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=${modules.join(',')}&crumb=${encodeURIComponent(crumb)}`;
    return fetchJson(url, { 'User-Agent': YAHOO_UA, Cookie: cookie });
  }
  let json;
  try {
    json = await attempt();
  } catch (e) {
    if (/HTTP 401/.test(e.message)) {
      cacheStore.delete('yahooAuth'); // stale cookie/crumb - refresh once and retry
      json = await attempt();
    } else if (/HTTP 404/.test(e.message)) {
      throw new Error(`No Yahoo Finance data for symbol ${symbol}`);
    } else {
      throw e;
    }
  }
  const result = json.quoteSummary && json.quoteSummary.result && json.quoteSummary.result[0];
  if (!result) throw new Error(`No Yahoo Finance data for symbol ${symbol}`);
  return result;
}

async function fetchYahooSearch(q) {
  const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=8&newsCount=0`;
  const json = await fetchWithRetry(url, { 'User-Agent': YAHOO_UA }, 2);
  const quotes = (json && json.quotes) || [];
  return quotes
    .filter((r) => r.quoteType === 'EQUITY' && r.symbol)
    .map((r) => ({
      ticker: r.symbol,
      name: r.longname || r.shortname || r.symbol,
      exchange: r.exchDisp || r.exchange || '',
      source: 'yahoo',
    }));
}

const YAHOO_RATING_LABELS = {
  strong_buy: 'Strong Buy', buy: 'Buy', hold: 'Hold', underperform: 'Underperform', sell: 'Sell',
};

function buildAnalystFromYahoo(financialData, keyStats, summaryProfile) {
  return {
    priceTarget: financialData.targetMeanPrice ? financialData.targetMeanPrice.raw : null,
    meanRating: financialData.recommendationKey ? (YAHOO_RATING_LABELS[financialData.recommendationKey] || financialData.recommendationKey) : null,
    analystCount: financialData.numberOfAnalystOpinions ? financialData.numberOfAnalystOpinions.raw : null,
    forwardEps: keyStats.forwardEps ? keyStats.forwardEps.raw : null,
    forwardEpsFiscalEnd: null,
    forwardEpsCount: null,
    sector: (summaryProfile && summaryProfile.sector) || null,
    industry: (summaryProfile && summaryProfile.industry) || null,
    // Yahoo doesn't expose a forward-looking 5yr consensus the way Nasdaq does - trailing
    // revenue growth is the closest available proxy, and the frontend already treats this
    // field as just one input among several rather than gospel.
    longTermGrowth: financialData.revenueGrowth ? financialData.revenueGrowth.raw : null,
  };
}

// Shaped to match extractFinancials()'s output so handleValuation and the frontend can treat
// both paths identically. Only one trailing-twelve-month data point is available (see note
// above), and Yahoo's "freeCashflow" is levered (OCF minus CapEx, no after-tax interest
// add-back) rather than the unlevered FCFF the SEC path computes - the closest honest
// approximation available here, not an equivalent figure.
function extractFinancialsFromYahoo(financialData, keyStats, fxRate) {
  const num = (field) => (financialData[field] && typeof financialData[field].raw === 'number' ? financialData[field].raw * fxRate : null);
  const revenue = num('totalRevenue');
  const ocf = num('operatingCashflow');
  const freeCashflow = num('freeCashflow');
  const ebitda = num('ebitda');
  const cash = num('totalCash');
  const totalDebt = num('totalDebt') || 0;
  const shares = keyStats.sharesOutstanding && typeof keyStats.sharesOutstanding.raw === 'number' ? keyStats.sharesOutstanding.raw : null;
  const year = new Date().getFullYear();

  return {
    fcfHistory: freeCashflow != null ? [{ fy: year, fcf: freeCashflow }] : [],
    latestFcf: freeCashflow,
    latestNetIncome: null,
    latestRevenue: revenue,
    // No separate operating-income/D&A breakdown is available - EBITDA itself (with D&A held
    // at 0) reproduces the real EBITDA figure for the exit-multiple cross-check without
    // fabricating a split that isn't there.
    latestOpIncome: ebitda,
    latestDA: ebitda != null ? 0 : null,
    latestCash: cash,
    latestLongDebt: totalDebt,
    latestShortDebt: 0,
    latestShares: shares,
    revenueHistory: revenue != null ? [{ fy: year, val: revenue, end: null, currency: null }] : [],
    taxRate: 0.21, // no pretax/tax breakdown available - statutory-rate fallback, same as the SEC path uses when filings lack it
    costOfDebtRaw: null,
    totalDebt,
    ocfForDisplay: ocf,
  };
}

async function fetchYahooValuation(symbol) {
  const result = await cachedFetch(`yahoofin:${symbol}`, TTL.FACTS, () => fetchYahooQuoteSummary(symbol, [
    'financialData', 'defaultKeyStatistics', 'summaryProfile',
  ]));
  const { financialData, defaultKeyStatistics: keyStats, summaryProfile } = result;
  if (!financialData) throw new Error(`No financial data available for ${symbol} on Yahoo Finance`);

  const reportingCurrency = financialData.financialCurrency || 'USD';
  const fxRate = await cachedFetch(`fx:${reportingCurrency}`, TTL.FX, () => fetchFxRateToUsd(reportingCurrency));
  if (reportingCurrency !== 'USD' && fxRate == null) {
    throw new Error(`${symbol} reports in ${reportingCurrency}, which this tool doesn't yet have an FX rate for.`);
  }

  const fin = extractFinancialsFromYahoo(financialData, keyStats || {}, fxRate || 1);
  fin.reportingCurrency = reportingCurrency;
  fin.fxRateToUsd = fxRate || 1;

  const analyst = buildAnalystFromYahoo(financialData, keyStats || {}, summaryProfile);
  const business = summaryProfile && summaryProfile.longBusinessSummary
    ? { extract: summaryProfile.longBusinessSummary, title: null, source: 'yahoo' }
    : null;

  return { fin, analyst, business };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

async function handleSearch(req, res, query) {
  const q = (query.q || '').trim();
  const localResults = searchCompanies(q);
  if (!q) return sendJson(res, 200, { results: localResults });

  // The local index only covers SEC filers - merge in non-duplicate Yahoo hits for anything
  // it turns up (TSX/TSXV listings among them), tagged with their exchange so the dropdown
  // can show where the data would come from. Best-effort: a slow or failing Yahoo search
  // just falls back to SEC-only results rather than failing the whole search.
  let yahooResults = [];
  try {
    yahooResults = await cachedFetch(`yahoosearch:${q.toLowerCase()}`, TTL.YAHOO_SEARCH, () => fetchYahooSearch(q));
  } catch (e) { /* best-effort */ }

  const localTickers = new Set(localResults.map((r) => r.ticker));
  const results = localResults.concat(yahooResults.filter((r) => !localTickers.has(r.ticker))).slice(0, 10);
  sendJson(res, 200, { results });
}

async function handleValuation(req, res, query) {
  const tickerQ = (query.ticker || '').trim().toUpperCase();
  if (!tickerQ) return sendJson(res, 400, { error: 'Missing ticker' });

  const match = searchIndex.find((r) => r.ticker === tickerQ);
  if (!match) return handleYahooValuation(res, tickerQ);

  // SEC's companyfacts payload is often the single slowest call here (large-cap XBRL history
  // can run several hundred KB), and it doesn't depend on price/analyst/beta/business data or
  // vice versa - fetching it up front and only THEN starting the rest (as this used to do)
  // paid its full latency before any of the others even started. Firing all of them together
  // drops total wait to the slowest single call instead of the sum of all of them.
  const [factsResult, priceResult, analystResult, betaResult, riskFreeResult, businessResult] = await Promise.allSettled([
    cachedFetch(`facts:${match.cik}`, TTL.FACTS, () => fetchWithRetry(
      `https://data.sec.gov/api/xbrl/companyfacts/CIK${match.cik}.json`,
      { 'User-Agent': SEC_UA },
      3
    )),
    cachedFetch(`price:${tickerQ}`, TTL.PRICE, () => fetchPrice(tickerQ)),
    cachedFetch(`analyst:${tickerQ}`, TTL.ANALYST, () => fetchAnalystSentiment(tickerQ)),
    cachedFetch(`beta:${tickerQ}`, TTL.BETA, () => fetchBeta(tickerQ)),
    cachedFetch('riskFreeRate', TTL.RISK_FREE, fetchRiskFreeRate),
    cachedFetch(`wiki:${match.name}`, TTL.BUSINESS, () => fetchBusinessSummary(match.name)),
  ]);

  if (factsResult.status === 'rejected') {
    return sendJson(res, 502, { error: `Could not fetch SEC financial data for ${tickerQ}: ${factsResult.reason.message}` });
  }
  const companyFacts = factsResult.value;
  const priceInfo = priceResult.status === 'fulfilled' ? priceResult.value : null;
  const analyst = analystResult.status === 'fulfilled' ? analystResult.value : null;
  const beta = betaResult.status === 'fulfilled' ? betaResult.value : null;
  const riskFreeRate = riskFreeResult.status === 'fulfilled' ? riskFreeResult.value : 0.042;
  const business = businessResult.status === 'fulfilled' ? businessResult.value : null;

  const reportingCurrency = detectCurrency(companyFacts.facts || {});
  const fxRate = await cachedFetch(`fx:${reportingCurrency}`, TTL.FX, () => fetchFxRateToUsd(reportingCurrency));
  if (reportingCurrency !== 'USD' && fxRate == null) {
    return sendJson(res, 502, { error: `${tickerQ} reports in ${reportingCurrency}, which this tool doesn't yet have an FX rate for.` });
  }

  const fin = extractFinancials(companyFacts, fxRate || 1);
  fin.reportingCurrency = reportingCurrency;
  fin.fxRateToUsd = fxRate || 1;
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

// A ticker not found in the SEC filer list either isn't a real symbol, or is a TSX/TSXV-only
// company (Aritzia, Bombardier, etc.) that never files with the SEC at all - no amount of
// taxonomy/currency handling on the SEC side reaches those. Try Yahoo Finance's own
// fundamentals before giving up; see the section above for what it can and can't provide.
async function handleYahooValuation(res, symbol) {
  const [valuationResult, priceResult, betaResult, riskFreeResult] = await Promise.allSettled([
    fetchYahooValuation(symbol),
    cachedFetch(`price:${symbol}`, TTL.PRICE, () => fetchPrice(symbol)),
    cachedFetch(`beta:${symbol}`, TTL.BETA, () => fetchBeta(symbol)),
    cachedFetch('riskFreeRate', TTL.RISK_FREE, fetchRiskFreeRate),
  ]);

  if (valuationResult.status === 'rejected') {
    return sendJson(res, 404, {
      error: `Ticker "${symbol}" not found in the SEC filer list, and no Yahoo Finance fundamentals were found for it either (${valuationResult.reason.message}). If this is a Canadian listing, try its Yahoo-style symbol (e.g. "ATZ.TO").`,
    });
  }
  const { fin, analyst, business } = valuationResult.value;
  const priceInfo = priceResult.status === 'fulfilled' ? priceResult.value : null;
  const beta = betaResult.status === 'fulfilled' ? betaResult.value : null;
  const riskFreeRate = riskFreeResult.status === 'fulfilled' ? riskFreeResult.value : 0.042;

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
    company: { ticker: symbol, name: (priceInfo && priceInfo.longName) || symbol, cik: null },
    price: priceInfo,
    analyst,
    business,
    financials: fin,
    estimatedGrowth: { fcfCagr: fcfGrowth, revenueCagr: revGrowth },
    waccEstimate,
    netDebt,
    asOf: new Date().toISOString(),
    dataSource: 'yahoo',
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
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

function serveStatic(req, res, urlPath) {
  let filePath = urlPath === '/' ? '/index.html' : urlPath;
  filePath = path.join(__dirname, 'public', path.normalize(filePath).replace(/^([.]{2}[/\\])+/, ''));
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(filePath);
    const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
    // The HTML shell only changes on deploy - a short public max-age lets browsers avoid a
    // full refetch on every navigation while must-revalidate keeps a deploy from being masked
    // by a stale cached copy for longer than max-age. Fonts are content-hashed by filename in
    // effect (the font itself never changes without a filename change), so cache them hard.
    if (ext === '.html') headers['Cache-Control'] = 'public, max-age=300, must-revalidate';
    else if (ext === '.woff2') headers['Cache-Control'] = 'public, max-age=31536000, immutable';
    res.writeHead(200, headers);
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
