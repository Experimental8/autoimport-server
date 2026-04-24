const cron  = require('node-cron');
const fetch = require('node-fetch');
const fs    = require('fs');
const http  = require('http');

const DATA_FILE  = './data.json';
const APIFY_TOKEN = process.env.APIFY_TOKEN;
const APIFY_AS24 = 'ivanvs/autoscout-scraper';
const APIFY_MDE  = 'ivanvs/mobile-de-scraper';

// ── Persistence ───────────────────────────────────────────────────────────
function loadData() {
  if (!fs.existsSync(DATA_FILE)) return { analyses: [], notifications: [] };
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch { return { analyses: [], notifications: [] }; }
}
function saveData(data) { fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2)); }

// ── Apify ─────────────────────────────────────────────────────────────────
async function scrapeUrl(actorId, url, maxItems = 100) {
  const endpoint = `https://api.apify.com/v2/acts/${encodeURIComponent(actorId)}/run-sync-get-dataset-items`;
  const params = new URLSearchParams({ token: APIFY_TOKEN, maxItems, format: 'json' });
  const input = { urls: [{ url }], maxRecords: maxItems };
  const resp = await fetch(`${endpoint}?${params}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
  });
  if (!resp.ok) throw new Error(`Apify ${resp.status}`);
  return resp.json();
}

// ── ntfy + history ────────────────────────────────────────────────────────
async function notify(channel, title, message, priority = 'default', analysisId = null) {
  if (!channel) return;
  try {
    await fetch(`https://ntfy.sh/${channel}`, {
      method: 'POST',
      headers: { 'Title': title, 'Priority': priority, 'Tags': 'car,autoimport' },
      body: message,
    });
  } catch (e) { console.error('ntfy error:', e.message); }

  // Save to history (7 days)
  const data = loadData();
  if (!data.notifications) data.notifications = [];
  data.notifications.push({
    id: Date.now(),
    analysisId,
    title,
    message,
    priority,
    ts: new Date().toISOString(),
    read: false,
  });
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  data.notifications = data.notifications.filter(n => new Date(n.ts).getTime() > cutoff);
  saveData(data);
}

// ── Helpers ───────────────────────────────────────────────────────────────
function getId(r) { return r.url || r.id || null; }

function getPrice(r) {
  const raw = r['price/amount'] || r.rawPrice || r.price || '';
  const n = parseFloat(String(raw).replace(/[^0-9.]/g, ''));
  return isNaN(n) ? null : n;
}

function getMake(r)  { return r.manufacturer || r.make || ''; }
function getModel(r) { return r.model || ''; }
function getKm(r)    { return r['properties/milage'] || r.milage || ''; }
function fmt(n)      { return n != null ? n.toLocaleString('pt-PT') : '—'; }

// ── Sync ──────────────────────────────────────────────────────────────────
async function syncAnalysis(analysis) {
  const { name, searchUrls, ntfyChannel, minScore = 0 } = analysis;
  if (!searchUrls?.length) return;
  console.log(`[${new Date().toISOString()}] Syncing: ${name}`);

  const freshOrigin = [];
  for (const { url, source } of searchUrls.filter(s => s.source !== 'sv')) {
    try {
      const actor = source === 'mde' ? APIFY_MDE : APIFY_AS24;
      const rows  = await scrapeUrl(actor, url);
      freshOrigin.push(...rows.map(r => ({ ...r, _src: source })));
      console.log(`  ${source.toUpperCase()}: ${rows.length}`);
    } catch (e) { console.error(`  ${source} error:`, e.message); }
  }

  // knownListings: { [id]: { price, score } }
  const knownListings = analysis.knownListings || {};
  const newListings   = [];
  const priceDrops    = [];

  for (const r of freshOrigin) {
    const id    = getId(r);
    if (!id) continue;
    const price = getPrice(r);
    const score = r.score || r.pontuation || null;

    if (!knownListings[id]) {
      // Brand new listing — only notify if score >= minScore
      if (minScore <= 0 || score == null || score >= minScore) {
        newListings.push(r);
      }
      knownListings[id] = { price, score, firstSeen: new Date().toISOString() };
    } else {
      // Known listing — notify only if:
      // was below minScore, price dropped, and now score >= minScore
      const prev = knownListings[id];
      const wasBelow = prev.score == null || (minScore > 0 && prev.score < minScore);
      const priceDrop = price != null && prev.price != null && price < prev.price;
      const nowAbove  = score != null && (minScore <= 0 || score >= minScore);

      if (wasBelow && priceDrop && nowAbove) {
        priceDrops.push({ r, prev, price, score });
      }
      knownListings[id] = { price, score, firstSeen: prev.firstSeen };
    }
  }

  // 🚗 Novo anúncio com score acima do mínimo
  if (newListings.length > 0) {
    console.log(`  → ${newListings.length} new listings above min score`);
    for (const r of newListings.slice(0, 5)) {
      const price = getPrice(r);
      const score = r.score || r.pontuation || '';
      const msg = `${getMake(r)} ${getModel(r)} — ${price ? fmt(price)+'€' : 'preço n/d'} — ${getKm(r)}${score ? ' · Score '+score : ''}\n${getId(r)}`;
      await notify(ntfyChannel, `🚗 Novo anúncio: ${name}`, msg, 'high', analysis.id);
    }
  } else {
    console.log(`  → No new listings above min score`);
  }

  // 📉 Baixou de preço e passou o score mínimo
  if (priceDrops.length > 0) {
    console.log(`  → ${priceDrops.length} price drops now above min score`);
    for (const { r, prev, price, score } of priceDrops.slice(0, 3)) {
      const msg = `${getMake(r)} ${getModel(r)}\n💶 ${fmt(prev.price)}€ → ${fmt(price)}€ (−${fmt(prev.price - price)}€)${score ? ' · Score '+score : ''}\n${getId(r)}`;
      await notify(ntfyChannel, `📉 Baixou de preço: ${name}`, msg, 'high', analysis.id);
    }
  }

  // Prune knownListings to IDs still present (max 2000)
  const freshIds = new Set(freshOrigin.map(getId).filter(Boolean));
  const pruned = {};
  for (const [id, val] of Object.entries(knownListings)) {
    if (freshIds.has(id)) pruned[id] = val;
  }
  // Keep up to 2000 entries
  const entries = Object.entries(pruned);
  analysis.knownListings = Object.fromEntries(entries.slice(-2000));
  analysis.lastSync = new Date().toISOString();
}

async function syncAll() {
  const data = loadData();
  if (!data.analyses.length) { console.log('No analyses to sync.'); return; }
  for (const a of data.analyses) {
    if (!a.syncEnabled) continue;
    try { await syncAnalysis(a); } catch (e) { console.error(`Error syncing ${a.name}:`, e.message); }
  }
  saveData(data);
}

// ── HTTP helpers ──────────────────────────────────────────────────────────
function readBody(req) {
  return new Promise((res, rej) => {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => { try { res(JSON.parse(body)); } catch(e) { rej(e); } });
  });
}
function ok(res, data)       { res.writeHead(200); res.end(JSON.stringify(data)); }
function err(res, msg, c=400){ res.writeHead(c);   res.end(JSON.stringify({ error: msg })); }

// ── HTTP Server ───────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  const u = new URL(req.url, 'http://localhost');

  if (req.method === 'GET' && u.pathname === '/health') {
    const data = loadData();
    return ok(res, { ok: true, analyses: data.analyses.length, time: new Date().toISOString() });
  }

  if (req.method === 'GET' && u.pathname === '/analyses') {
    return ok(res, loadData().analyses.map(a => ({
      id: a.id, name: a.name, syncEnabled: a.syncEnabled,
      minScore: a.minScore, ntfyChannel: a.ntfyChannel,
      lastSync: a.lastSync, searchUrls: a.searchUrls,
    })));
  }

  if (req.method === 'POST' && u.pathname === '/analyses') {
    try {
      const payload = await readBody(req);
      const data = loadData();
      const idx = data.analyses.findIndex(a => a.id === payload.id);
      if (idx >= 0) {
        data.analyses[idx] = { ...data.analyses[idx], ...payload };
      } else {
        data.analyses.push({ knownListings: {}, lastSync: null, ...payload });
      }
      saveData(data);
      return ok(res, { ok: true });
    } catch (e) { return err(res, e.message); }
  }

  if (req.method === 'DELETE' && u.pathname.startsWith('/analyses/')) {
    const id = u.pathname.split('/').pop();
    const data = loadData();
    data.analyses = data.analyses.filter(a => String(a.id) !== id);
    saveData(data);
    return ok(res, { ok: true });
  }

  // GET /listing-history?url=...
  if (req.method === 'GET' && u.pathname === '/listing-history') {
    const listingUrl = u.searchParams.get('url');
    if (!listingUrl) return err(res, 'url query param required');
    const data = loadData();
    for (const a of data.analyses || []) {
      const kl = a.knownListings || {};
      if (kl[listingUrl]) {
        return ok(res, {
          url: listingUrl,
          analysisId: a.id,
          analysisName: a.name,
          firstSeen: kl[listingUrl].firstSeen,
          currentPrice: kl[listingUrl].price,
          currentScore: kl[listingUrl].score,
          history: kl[listingUrl].priceHistory || [],
        });
      }
    }
    return ok(res, { url: listingUrl, history: [] });
  }

  // POST /brave-search { query, key, count }
  if (req.method === 'POST' && u.pathname === '/brave-search') {
    try {
      const body = await readBody(req);
      const { query, key, count = 3 } = body;
      if (!query) return err(res, 'query required');
      if (!key) return err(res, 'key required');
      const braveUrl = 'https://api.search.brave.com/res/v1/web/search?q=' + encodeURIComponent(query) + '&count=' + count;
      const resp = await fetch(braveUrl, {
        headers: { 'Accept': 'application/json', 'X-Subscription-Token': key }
      });
      if (!resp.ok) {
        return err(res, 'Brave API ' + resp.status, resp.status);
      }
      const data = await resp.json();
      return ok(res, data);
    } catch (e) {
      return err(res, e.message);
    }
  }

  if (req.method === 'GET' && u.pathname === '/notifications') {
    return ok(res, loadData().notifications || []);
  }

  if (req.method === 'POST' && u.pathname === '/notifications/read') {
    const data = loadData();
    (data.notifications || []).forEach(n => n.read = true);
    saveData(data);
    return ok(res, { ok: true });
  }

  if (req.method === 'POST' && u.pathname.startsWith('/notifications/read/')) {
    const id = parseInt(u.pathname.split('/').pop());
    const data = loadData();
    const n = (data.notifications || []).find(n => n.id === id);
    if (n) n.read = true;
    saveData(data);
    return ok(res, { ok: true });
  }

  if (req.method === 'POST' && u.pathname === '/sync') {
    ok(res, { ok: true, message: 'Sync started' });
    syncAll().catch(console.error);
    return;
  }

  err(res, 'Not found', 404);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`AutoImport server running on port ${PORT}`));
// Sync às 08h, 12h, 14h30 e 17h30 — todos os dias incluindo fim-de-semana
const syncTimes = ['0 8 * * *', '0 12 * * *', '30 14 * * *', '30 17 * * *'];
syncTimes.forEach(expr => {
  cron.schedule(expr, () => {
    console.log(`⏰ Sync scheduled: ${expr}`);
    syncAll().catch(console.error);
  });
});
console.log('✅ Cron: 08h, 12h, 14h30, 17h30 — todos os dias');
syncAll().catch(console.error);
