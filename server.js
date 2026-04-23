const cron = require('node-cron');
const fetch = require('node-fetch');
const fs = require('fs');

const DATA_FILE = './data.json';
const APIFY_TOKEN = process.env.APIFY_TOKEN;
const APIFY_AS24_ACTOR = 'ivanvs/autoscout-scraper';
const APIFY_MDE_ACTOR  = 'ivanvs/mobile-de-scraper';
const APIFY_SV_ACTOR   = 'dadhalfdev/standvirtual-scraper';

function loadData() {
  if (!fs.existsSync(DATA_FILE)) return { analyses: [] };
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch { return { analyses: [] }; }
}
function saveData(data) { fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2)); }

async function scrapeUrl(actorId, url, maxItems = 100) {
  const endpoint = `https://api.apify.com/v2/acts/${encodeURIComponent(actorId)}/run-sync-get-dataset-items`;
  const params = new URLSearchParams({ token: APIFY_TOKEN, maxItems, format: 'json' });
  const input = actorId.includes('mobile-de')
    ? { urls: [url], maxRecords: maxItems }
    : actorId.includes('standvirtual')
    ? { startUrls: [{ url }], maxItems }
    : { urls: [{ url }], maxRecords: maxItems };
  const resp = await fetch(`${endpoint}?${params}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
  });
  if (!resp.ok) throw new Error(`Apify ${resp.status}: ${await resp.text()}`);
  return resp.json();
}

async function notify(channel, title, message, priority = 'default') {
  if (!channel) return;
  try {
    await fetch(`https://ntfy.sh/${channel}`, {
      method: 'POST',
      headers: { 'Title': title, 'Priority': priority, 'Tags': 'car,autoimport' },
      body: message,
    });
  } catch (e) { console.error('Notify error:', e.message); }
}

function getId(row) { return row.url || row.id || null; }

function calcMarketStats(rows) {
  const prices = rows
    .map(r => parseFloat(String(r.price || r.preco || r['price/amount'] || 0).replace(/[^0-9.]/g, '')))
    .filter(p => p > 0);
  if (!prices.length) return null;
  prices.sort((a, b) => a - b);
  return {
    count: prices.length,
    min: prices[0],
    max: prices[prices.length - 1],
    avg: Math.round(prices.reduce((s, p) => s + p, 0) / prices.length),
  };
}

function marketChanged(prev, curr) {
  if (!prev || !curr) return !!curr;
  if (Math.abs(prev.count - curr.count) >= 2) return true;
  if (prev.avg && curr.avg && Math.abs(prev.avg - curr.avg) / prev.avg > 0.02) return true;
  return false;
}

async function syncAnalysis(analysis) {
  const { name, searchUrls, ntfyChannel } = analysis;
  if (!searchUrls?.length) return;
  console.log(`[${new Date().toISOString()}] Syncing: ${name}`);

  const originUrls = searchUrls.filter(s => s.source !== 'sv');
  const svUrls     = searchUrls.filter(s => s.source === 'sv');

  // ── Origin sources (AS24 + MDE) — detect new listings ─────────────────
  const freshOrigin = [];
  for (const { url, source } of originUrls) {
    try {
      const actor = source === 'mde' ? APIFY_MDE_ACTOR : APIFY_AS24_ACTOR;
      const rows = await scrapeUrl(actor, url);
      freshOrigin.push(...rows.map(r => ({ ...r, _src: source })));
      console.log(`  ${source.toUpperCase()}: ${rows.length} listings`);
    } catch (e) { console.error(`  ${source} error:`, e.message); }
  }

  const knownOriginIds = new Set(analysis.knownOriginIds || []);
  const newListings = freshOrigin.filter(r => { const id = getId(r); return id && !knownOriginIds.has(id); });

  if (newListings.length > 0) {
    console.log(`  → ${newListings.length} new listings`);
    for (const r of newListings.slice(0, 5)) {
      const make  = r.manufacturer || r.make || '';
      const model = r.model || '';
      const price = r['price/amount'] || r.rawPrice || r.price || '';
      const km    = r['properties/milage'] || r.milage || '';
      await notify(ntfyChannel, `🚗 Novo anúncio: ${name}`,
        `${make} ${model} — ${price ? price+'€' : 'preço n/d'} — ${km}\n${r.url||''}`, 'high');
    }
    freshOrigin.forEach(r => { const id = getId(r); if(id) knownOriginIds.add(id); });
    analysis.knownOriginIds = [...knownOriginIds].slice(-2000);
  } else {
    console.log(`  → No new origin listings`);
  }

  // SV tracking disabled — no notifications for PT market changes

  analysis.lastSync = new Date().toISOString();
}

async function syncAll() {
  const data = loadData();
  if (!data.analyses.length) { console.log('No analyses to sync.'); return; }
  for (const a of data.analyses) {
    if (!a.syncEnabled) continue;
    try { await syncAnalysis(a); }
    catch (e) { console.error(`Error syncing ${a.name}:`, e.message); }
  }
  saveData(data);
}

// ── HTTP API ─────────────────────────────────────────────────────────────
const http = require('http');
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  const u = new URL(req.url, 'http://localhost');

  if (req.method === 'GET' && u.pathname === '/health') {
    const data = loadData();
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true, analyses: data.analyses.length, time: new Date().toISOString() }));
    return;
  }

  if (req.method === 'GET' && u.pathname === '/analyses') {
    const data = loadData();
    res.writeHead(200);
    res.end(JSON.stringify(data.analyses.map(a => ({
      id: a.id, name: a.name, syncEnabled: a.syncEnabled,
      minScore: a.minScore, ntfyChannel: a.ntfyChannel,
      lastSync: a.lastSync, searchUrls: a.searchUrls,
      svMarketStats: a.svMarketStats,
    }))));
    return;
  }

  if (req.method === 'POST' && u.pathname === '/analyses') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        const data = loadData();
        const idx = data.analyses.findIndex(a => a.id === payload.id);
        if (idx >= 0) {
          data.analyses[idx] = { ...data.analyses[idx], ...payload };
        } else {
          data.analyses.push({ knownOriginIds: [], knownSvIds: [], svMarketStats: null, lastSync: null, ...payload });
        }
        saveData(data);
        res.writeHead(200); res.end(JSON.stringify({ ok: true }));
      } catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); }
    });
    return;
  }

  if (req.method === 'DELETE' && u.pathname.startsWith('/analyses/')) {
    const id = u.pathname.split('/').pop();
    const data = loadData();
    data.analyses = data.analyses.filter(a => String(a.id) !== id);
    saveData(data);
    res.writeHead(200); res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === 'POST' && u.pathname === '/sync') {
    res.writeHead(200); res.end(JSON.stringify({ ok: true, message: 'Sync started' }));
    syncAll().catch(console.error);
    return;
  }

  res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' }));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`AutoImport server running on port ${PORT}`));
cron.schedule('0 9-19 * * *', () => { console.log('⏰ Hourly sync'); syncAll().catch(console.error); });
console.log('✅ Cron job scheduled: every hour');
syncAll().catch(console.error);
