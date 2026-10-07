/**
 * Ticker Notebook API (Cloudflare Pages Function)
 *
 * Serves /api/* for the site on the same domain, so the page never sees your API keys.
 * Keys come from the Pages project's environment variables:
 *   FINNHUB_KEY     https://finnhub.io      (live quotes, search, company profile, metrics, news, market status)
 *   TWELVEDATA_KEY  https://twelvedata.com  (daily price history for the chart)
 *
 * Every answer is cached at the edge (and in memory), so many visitors looking at the same
 * stock share one upstream call. If a provider is rate-limited or down, the last good answer
 * is served with "stale": true instead of an error.
 *
 * Routes (all GET, all JSON):
 *   /api/status                     US market open/closed
 *   /api/quote?symbol=AAPL          latest price
 *   /api/history?symbol=AAPL        about one year of daily closes
 *   /api/search?q=apple             symbol search
 *   /api/profile?symbol=AAPL        name, exchange, industry, market cap
 *   /api/metrics?symbol=AAPL        52-week range, P/E, EPS, beta, dividend yield
 *   /api/news?symbol=AAPL           recent company news
 */

const FINNHUB = "https://finnhub.io/api/v1";
const TWELVE = "https://api.twelvedata.com";

// Seconds each kind of answer stays fresh at the edge.
const TTL = { quote: 10, status: 60, search: 86400, profile: 604800, metrics: 43200, news: 900, history: 21600 };
// Last good answers are kept this long to cover rate limits and outages.
const STALE_TTL = 86400 * 2;

const mem = new Map(); // in-memory cache for this isolate: key -> { exp, data }
const MEM_MAX = 500;

class ApiError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

export async function onRequestGet(context) {
  const { request, env, params } = context;
  const url = new URL(request.url);
  const route = [].concat(params.path || []).join("/");

  // Only this site's own pages may call the API from a browser.
  const site = request.headers.get("Sec-Fetch-Site");
  if (site && site !== "same-origin" && site !== "none") {
    return json({ error: { code: "forbidden", message: "This API only serves its own site." } }, 403);
  }

  try {
    switch (route) {
      case "status":
        return ok(await cached(context, "status", "US", TTL.status, () => fhStatus(env)), TTL.status);
      case "quote": {
        const s = symbolParam(url);
        return ok(await cached(context, "quote", s, TTL.quote, () => fhQuote(env, s)), 5);
      }
      case "history": {
        const s = symbolParam(url);
        return ok(await cached(context, "history", s, TTL.history, () => tdHistory(env, s)), 3600);
      }
      case "search": {
        const q = (url.searchParams.get("q") || "").trim();
        if (!/^[A-Za-z0-9 .&'\-]{1,40}$/.test(q)) throw new ApiError(400, "bad_request", "Search for a company name or ticker.");
        return ok(await cached(context, "search", q.toLowerCase(), TTL.search, () => fhSearch(env, q)), 3600);
      }
      case "profile": {
        const s = symbolParam(url);
        return ok(await cached(context, "profile", s, TTL.profile, () => fhProfile(env, s)), 86400);
      }
      case "metrics": {
        const s = symbolParam(url);
        return ok(await cached(context, "metrics", s, TTL.metrics, () => fhMetrics(env, s)), 3600);
      }
      case "news": {
        const s = symbolParam(url);
        return ok(await cached(context, "news", s, TTL.news, () => fhNews(env, s)), 300);
      }
      default:
        throw new ApiError(404, "not_found", "Unknown API route.");
    }
  } catch (e) {
    if (e instanceof ApiError) return json({ error: { code: e.code, message: e.message } }, e.status);
    return json({ error: { code: "server_error", message: "Something went wrong on the server." } }, 500);
  }
}

/* ---------------- caching ---------------- */

async function cached(context, kind, key, ttl, load) {
  const id = kind + ":" + key;
  const now = Date.now();
  const hit = mem.get(id);
  if (hit && hit.exp > now) return hit.data;

  const cache = typeof caches !== "undefined" ? caches.default : null;
  const freshUrl = "https://ticker-notebook.cache/fresh/" + encodeURIComponent(id);
  const staleUrl = "https://ticker-notebook.cache/stale/" + encodeURIComponent(id);
  if (cache) {
    try {
      const r = await cache.match(freshUrl);
      if (r) { const data = await r.json(); remember(id, data, ttl); return data; }
    } catch (e) { /* cache unavailable: fall through */ }
  }

  try {
    const data = await load();
    data.fetchedAt = now;
    remember(id, data, ttl);
    remember("stale:" + id, data, STALE_TTL);
    if (cache) {
      const put = Promise.all([
        cache.put(freshUrl, cacheable(data, ttl)),
        cache.put(staleUrl, cacheable(data, STALE_TTL)),
      ]).catch(() => {});
      if (context.waitUntil) context.waitUntil(put); else await put;
    }
    return data;
  } catch (err) {
    // Rate limited or upstream down: serve the last good answer if there is one.
    if (err instanceof ApiError && err.status >= 429) {
      const old = mem.get("stale:" + id);
      if (old && old.exp > now) return { ...old.data, stale: true };
      if (cache) {
        try { const r = await cache.match(staleUrl); if (r) return { ...(await r.json()), stale: true }; } catch (e) {}
      }
    }
    throw err;
  }
}

function remember(id, data, ttl) {
  if (mem.size > MEM_MAX) mem.delete(mem.keys().next().value);
  mem.set(id, { exp: Date.now() + ttl * 1000, data });
}

function cacheable(data, ttl) {
  return new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=" + ttl },
  });
}

/* ---------------- providers ---------------- */

function needKey(env, name, label) {
  const k = env && env[name];
  if (!k) throw new ApiError(503, "not_configured", "The site owner still needs to add the " + label + " API key (" + name + ").");
  return k;
}

async function getJson(u, provider) {
  let r;
  try { r = await fetch(u, { headers: { Accept: "application/json" } }); }
  catch (e) { throw new ApiError(502, "upstream_error", provider + " could not be reached."); }
  if (r.status === 429) throw new ApiError(429, "rate_limited", provider + " is busy. Prices will catch up in a minute.");
  if (r.status === 401 || r.status === 403) {
    const t = await r.text().catch(() => "");
    if (/access to this resource|premium|plan/i.test(t)) throw new ApiError(403, "not_in_plan", provider + " doesn't include this data on the free plan.");
    throw new ApiError(503, "bad_key", "The " + provider + " API key was rejected. Check it in the Cloudflare settings.");
  }
  if (r.status >= 500) throw new ApiError(502, "upstream_error", provider + " is having trouble right now.");
  if (!r.ok) throw new ApiError(502, "upstream_error", provider + " answered with an error (" + r.status + ").");
  try { return await r.json(); } catch (e) { throw new ApiError(502, "upstream_error", provider + " sent an unreadable answer."); }
}

function fh(env, path, qs) {
  const key = needKey(env, "FINNHUB_KEY", "Finnhub");
  const u = new URL(FINNHUB + path);
  Object.entries(qs || {}).forEach(([k, v]) => u.searchParams.set(k, v));
  u.searchParams.set("token", key);
  return getJson(u.toString(), "Finnhub");
}

const num = v => (typeof v === "number" && Number.isFinite(v) ? v : (typeof v === "string" && v.trim() !== "" && Number.isFinite(+v) ? +v : null));
const pick = (o, ...keys) => { for (const k of keys) { const v = num(o && o[k]); if (v !== null) return v; } return null; };

async function fhStatus(env) {
  const j = await fh(env, "/stock/market-status", { exchange: "US" });
  return { isOpen: !!(j && j.isOpen), session: (j && j.session) || null, holiday: (j && j.holiday) || null, time: num(j && j.t) ? j.t * 1000 : null };
}

async function fhQuote(env, symbol) {
  const j = await fh(env, "/quote", { symbol });
  const price = num(j && j.c);
  if (!price || !num(j.t)) throw new ApiError(404, "not_found", "No US stock found for " + symbol + ".");
  const pct = num(j.dp);
  return {
    symbol, price, change: num(j.d), changePct: pct === null ? null : pct / 100,
    open: num(j.o), high: num(j.h), low: num(j.l), prevClose: num(j.pc), time: j.t * 1000,
  };
}

async function fhSearch(env, q) {
  const j = await fh(env, "/search", { q });
  const list = Array.isArray(j && j.result) ? j.result : [];
  const out = [];
  for (const r of list) {
    const symbol = String(r.symbol || r.displaySymbol || "").toUpperCase();
    // US listings only: plain tickers or class shares like BRK.B
    if (!/^[A-Z]{1,5}(\.[A-Z])?$/.test(symbol)) continue;
    if (out.some(x => x.symbol === symbol)) continue;
    out.push({ symbol, name: String(r.description || "").slice(0, 120), type: String(r.type || "") });
    if (out.length >= 8) break;
  }
  return { query: q, results: out };
}

async function fhProfile(env, symbol) {
  const j = await fh(env, "/stock/profile2", { symbol });
  if (!j || !j.name) throw new ApiError(404, "not_found", "No company profile for " + symbol + ".");
  const mc = num(j.marketCapitalization);
  return {
    symbol, name: String(j.name), exchange: shortExchange(j.exchange), industry: j.finnhubIndustry || null,
    currency: /^[A-Z]{3}$/.test(j.currency || "") ? j.currency : "USD",
    marketCap: mc === null ? null : mc * 1e6, web: /^https?:\/\//.test(j.weburl || "") ? j.weburl : null, ipo: j.ipo || null,
  };
}

function shortExchange(x) {
  const s = String(x || "");
  if (/nasdaq/i.test(s)) return "NASDAQ";
  if (/new york stock exchange|nyse/i.test(s)) return "NYSE";
  return s.slice(0, 40) || null;
}

async function fhMetrics(env, symbol) {
  const j = await fh(env, "/stock/metric", { symbol, metric: "all" });
  const m = (j && j.metric) || {};
  const mc = pick(m, "marketCapitalization");
  return {
    symbol,
    hi52: pick(m, "52WeekHigh"), lo52: pick(m, "52WeekLow"),
    pe: pick(m, "peTTM", "peBasicExclExtraTTM", "peExclExtraTTM", "peNormalizedAnnual"),
    eps: pick(m, "epsTTM", "epsBasicExclExtraItemsTTM", "epsExclExtraItemsTTM", "epsNormalizedAnnual"),
    beta: pick(m, "beta"),
    divYield: pick(m, "dividendYieldIndicatedAnnual", "currentDividendYieldTTM"),
    marketCap: mc === null ? null : mc * 1e6,
  };
}

async function fhNews(env, symbol) {
  const to = new Date(), from = new Date(Date.now() - 10 * 86400e3);
  const day = d => d.toISOString().slice(0, 10);
  const j = await fh(env, "/company-news", { symbol, from: day(from), to: day(to) });
  const items = (Array.isArray(j) ? j : [])
    .filter(n => n && n.headline && /^https:\/\//.test(n.url || ""))
    .sort((a, b) => (num(b.datetime) || 0) - (num(a.datetime) || 0))
    .slice(0, 8)
    .map(n => ({ headline: String(n.headline).slice(0, 200), source: String(n.source || "").slice(0, 60), url: n.url, time: (num(n.datetime) || 0) * 1000, summary: String(n.summary || "").slice(0, 260) }));
  return { symbol, items };
}

async function tdHistory(env, symbol) {
  const key = needKey(env, "TWELVEDATA_KEY", "Twelve Data");
  const u = new URL(TWELVE + "/time_series");
  u.searchParams.set("symbol", symbol);
  u.searchParams.set("interval", "1day");
  u.searchParams.set("outputsize", "260");
  u.searchParams.set("apikey", key);
  const j = await getJson(u.toString(), "Twelve Data");
  if (j && j.status === "error") {
    const code = num(j.code);
    if (code === 429) throw new ApiError(429, "rate_limited", "Twelve Data is busy. The chart will fill in shortly.");
    if (code === 401 || code === 403) throw new ApiError(503, "bad_key", "The Twelve Data API key was rejected or doesn't cover this symbol.");
    throw new ApiError(404, "not_found", "No price history for " + symbol + ".");
  }
  const rows = (Array.isArray(j && j.values) ? j.values : [])
    .map(v => ({ d: String(v.datetime || "").slice(0, 10), c: num(v.close) }))
    .filter(v => /^\d{4}-\d{2}-\d{2}$/.test(v.d) && v.c !== null && v.c > 0)
    .sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
  if (!rows.length) throw new ApiError(404, "not_found", "No price history for " + symbol + ".");
  return { symbol, currency: (j.meta && j.meta.currency) || "USD", rows };
}

/* ---------------- helpers ---------------- */

function symbolParam(url) {
  const s = (url.searchParams.get("symbol") || "").trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9.\-]{0,9}$/.test(s)) throw new ApiError(400, "bad_request", "That doesn't look like a ticker symbol.");
  return s;
}

function ok(data, browserMaxAge) {
  return json(data, 200, { "Cache-Control": "public, max-age=" + browserMaxAge });
}

function json(data, status, extra) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: Object.assign({ "Content-Type": "application/json; charset=utf-8", "X-Content-Type-Options": "nosniff" }, extra || {}),
  });
}
