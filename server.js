const cron  = require('node-cron');
const fetch = require('node-fetch');
const fs    = require('fs');
const http  = require('http');

const DATA_FILE      = './data.json';
const APIFY_TOKEN    = process.env.APIFY_TOKEN;
const APIFY_AS24     = 'ivanvs/autoscout-scraper';
const APIFY_MDE      = 'ivanvs/mobile-de-scraper';
const APIFY_SV       = 'dadhalfdev/standvirtual-scraper';

// ── Persistence ───────────────────────────────────────────────────────────
function loadData() {
  if (!fs.existsSync(DATA_FILE)) return { analyses: [], favourites: [] };
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch { return { analyses: [], favourites: [] }; }
}
function saveData(data) { fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2)); }

// ── Apify ─────────────────────────────────────────────────────────────────
async function scrapeUrl(actorId, url, maxItems = 100) {
  const endpoint = `https://api.apify.com/v2/acts/${encodeURIComponent(actorId)}/run-sync-get-dataset-items`;
  const params = new URLSearchParams({ token: APIFY_TOKEN, maxItems, format: 'json' });
  const input = actorId.includes('mobile-de')   ? { urls: [url], maxRecords: maxItems }
              : actorId.includes('standvirtual') ? { startUrls: [{ url }], maxItems }
              : { urls: [{ url }], maxRecords: maxItems };
  const resp = await fetch(`${endpoint}?${params}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
  });
  if (!resp.ok) throw new Error(`Apify ${resp.status}`);
  return resp.json();
}

// ── ntfy ──────────────────────────────────────────────────────────────────
async function notify(channel, title, message, priority = 'default', analysisId = null) {
  if (!channel) return;
  try {
    await fetch(`https://ntfy.sh/${channel}`, {
      method: 'POST',
      headers: { 'Title': title, 'Priority': priority, 'Tags': 'car,autoimport' },
      body: message,
    });
  } catch (e) { console.error('ntfy error:', e.message); }

  // Save to history
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
  // Keep 7 days only
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  data.notifications = data.notifications.filter(n => new Date(n.ts).getTime() > cutoff);
  saveData(data);
}

// ── Sync ──────────────────────────────────────────────────────────────────
function getId(row) { return row.url || row.id || null; }

async function syncAnalysis(analysis) {
  const { name, searchUrls, ntfyChannel } = analysis;
  if (!searchUrls?.length) return;
  console.log(`[${new Date().toISOString()}] Syncing: ${name}`);

  const originUrls = searchUrls.filter(s => s.source !== 'sv');
  const freshOrigin = [];

  for (const { url, source } of originUrls) {
    try {
      const actor = source === 'mde' ? APIFY_MDE : APIFY_AS24;
      const rows  = await scrapeUrl(actor, url);
      freshOrigin.push(...rows.map(r => ({ ...r, _src: source })));
      console.log(`  ${source.toUpperCase()}: ${rows.length}`);
    } catch (e) { console.error(`  ${source} error:`, e.message); }
  }

  const knownIds   = new Set(analysis.knownOriginIds || []);
  const newListings = freshOrigin.filter(r => { const id = getId(r); return id && !knownIds.has(id); });

  if (newListings.length > 0) {
    console.log(`  → ${newListings.length} new listings`);
    for (const r of newListings.slice(0, 5)) {
      const make  = r.manufacturer || r.make || '';
      const model = r.model || '';
      const price = r['price/amount'] || r.rawPrice || r.price || '';
      const km    = r['properties/milage'] || r.milage || '';
      await notify(ntfyChannel, `🚗 Novo anúncio: ${name}`,
        `${make} ${model} — ${price ? price+'€' : 'preço n/d'} — ${km}\n${r.url||''}`, 'high', analysis.id);
    }
    freshOrigin.forEach(r => { const id = getId(r); if (id) knownIds.add(id); });
    analysis.knownOriginIds = [...knownIds].slice(-2000);
  } else {
    console.log(`  → No new listings`);
  }
  analysis.lastSync = new Date().toISOString();
}

async function syncAll() {
  const data = loadData();
  if (!data.analyses.length) { console.log('No analyses to sync.'); return; }
  for (const a of data.analyses) {
    if (!a.syncEnabled) continue;
    try { await syncAnalysis(a); } catch (e) { console.error(`Error:`, e.message); }
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
function ok(res, data)  { res.writeHead(200); res.end(JSON.stringify(data)); }
function err(res, msg, code = 400) { res.writeHead(code); res.end(JSON.stringify({ error: msg })); }

// ── HTTP Server ───────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  const u    = new URL(req.url, 'http://localhost');
  const path = u.pathname;

  // Health
  if (req.method === 'GET' && path === '/health') {
    const data = loadData();
    return ok(res, { ok: true, analyses: data.analyses.length, favourites: (data.favourites||[]).length, time: new Date().toISOString() });
  }

  // ── Analyses ──────────────────────────────────────────────────────────
  if (req.method === 'GET' && path === '/analyses') {
    return ok(res, loadData().analyses);
  }

  if (req.method === 'POST' && path === '/analyses') {
    try {
      const payload = await readBody(req);
      const data    = loadData();
      const idx     = data.analyses.findIndex(a => a.id === payload.id);
      if (idx >= 0) {
        data.analyses[idx] = { ...data.analyses[idx], ...payload };
      } else {
        data.analyses.push({ knownOriginIds: [], lastSync: null, ...payload });
      }
      saveData(data);
      return ok(res, { ok: true });
    } catch (e) { return err(res, e.message); }
  }

  if (req.method === 'DELETE' && path.startsWith('/analyses/')) {
    const id   = path.split('/').pop();
    const data = loadData();
    data.analyses = data.analyses.filter(a => String(a.id) !== id);
    saveData(data);
    return ok(res, { ok: true });
  }

  // ── Favourites ────────────────────────────────────────────────────────
  if (req.method === 'GET' && path === '/favourites') {
    return ok(res, loadData().favourites || []);
  }

  if (req.method === 'POST' && path === '/favourites') {
    try {
      const payload = await readBody(req);
      const data    = loadData();
      if (!data.favourites) data.favourites = [];
      const idx = data.favourites.findIndex(f => f.id === payload.id);
      if (idx >= 0) data.favourites[idx] = payload;
      else data.favourites.push(payload);
      saveData(data);
      return ok(res, { ok: true });
    } catch (e) { return err(res, e.message); }
  }

  if (req.method === 'DELETE' && path.startsWith('/favourites/')) {
    const id   = path.split('/').pop();
    const data = loadData();
    data.favourites = (data.favourites || []).filter(f => String(f.id) !== id);
    saveData(data);
    return ok(res, { ok: true });
  }

  // ── Manual sync ───────────────────────────────────────────────────────
  if (req.method === 'POST' && path === '/sync') {
    ok(res, { ok: true, message: 'Sync started' });
    syncAll().catch(console.error);
    return;
  }

  err(res, 'Not found', 404);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`AutoImport server running on port ${PORT}`));
cron.schedule('0 9-19 * * *', () => { console.log('⏰ Hourly sync'); syncAll().catch(console.error); });
console.log('✅ Cron job scheduled: 9h-19h daily');
syncAll().catch(console.error);
