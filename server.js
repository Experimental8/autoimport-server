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
// Codifica headers HTTP com UTF-8 (RFC 2047) para suportar emojis
function encodeNtfyHeader(val) {
  if (!val) return val;
  if (/^[\x00-\x7F]*$/.test(val)) return val;
  return `=?UTF-8?B?${Buffer.from(val, 'utf-8').toString('base64')}?=`;
}

async function notify(channel, title, message, priority = 'default', analysisId = null, subtitle = null) {
  if (!channel) return;
  try {
    // ntfy não tem subtítulo nativo — prepend ao message como linha em destaque
    const fullMessage = subtitle ? `${subtitle}\n${'─'.repeat(20)}\n${message}` : message;
    await fetch(`https://ntfy.sh/${channel}`, {
      method: 'POST',
      headers: { 'Title': encodeNtfyHeader(title), 'Priority': priority, 'Tags': 'car,autoimport' },
      body: fullMessage,
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
function fmtEur(n)   { return n != null ? '€' + n.toLocaleString('pt-PT') : '€—'; }

// ── Quick Score Calculation (replicates platform calcMarg in simplified form) ──
const TRANSPORT_BY_COUNTRY = {
  'D': 700, 'DE': 700, 'Alemanha': 700, 'Germany': 700,
  'F': 600, 'FR': 600, 'França': 600, 'France': 600,
  'B': 500, 'BE': 500, 'Bélgica': 500, 'Belgium': 500,
  'NL': 600, 'Holanda': 600, 'Netherlands': 600,
  'IT': 800, 'Itália': 800, 'Italy': 800,
  'ES': 400, 'Espanha': 400, 'Spain': 400,
  'AT': 750, 'Austria': 750, 'Áustria': 750,
};

const ISV_BY_FUEL_SIMPLIFIED = {
  'Elétrico': 0, 'Eletrico': 0, 'Electric': 0,
  'PHEV': 1500, 'Plug-in': 1500, 'plug-in-hybrid': 1500, 'HYBRID_PLUGIN': 1500,
  'Híbrido': 3500, 'Hibrido': 3500, 'Hybrid': 3500,
  'Gasolina': 5500, 'Petrol': 5500, 'PETROL': 5500,
  'Gasóleo': 6500, 'Gasoleo': 6500, 'Diesel': 6500, 'DIESEL': 6500,
};

const LEGAL_FIXED = 1000; // legalização média

function getCountry(r) {
  return r['vehicle/country'] || r['dealer/contry'] || r['dealer/address/contry'] || r.country || r['vehicleLocation/country'] || 'D';
}

function getFuel(r) {
  return r['vehicle/fuel'] || r.fuel || r['fuelType'] || r['properties/fuelType'] || '';
}

function calcQuickScore(car, cachedRef) {
  if (!cachedRef?.priceMedian) return null;
  const price = getPrice(car);
  if (!price) return null;

  const country = getCountry(car);
  const transp = TRANSPORT_BY_COUNTRY[country] || 700;

  const fuel = getFuel(car);
  let isv = 5500;
  for (const [k, v] of Object.entries(ISV_BY_FUEL_SIMPLIFIED)) {
    if (fuel.toString().toLowerCase().includes(k.toLowerCase())) {
      isv = v;
      break;
    }
  }

  const custo = price + transp + isv + LEGAL_FIXED;
  const svRef = cachedRef.priceMedian;
  const mb = svRef - custo;
  const ivaM = Math.round(0.23 * (svRef - price));
  const ml = mb - ivaM;
  const mp = custo > 0 ? mb / custo : 0;
  const score = Math.min(100, Math.max(0, Math.round(mp * 200)));

  return { score, custo, mb, ml, svRef, transp, isv };
}

// ── Sync ──────────────────────────────────────────────────────────────────
async function syncAnalysis(analysis) {
  // Filtros suportados: minScore (principal) + maxPrice (segurança extra)
  const { name, searchUrls, ntfyChannel, minScore = 30, maxPrice = 0, cachedRef } = analysis;
  if (!searchUrls?.length) return;
  console.log(`[${new Date().toISOString()}] Syncing: ${name} (maxPrice=${maxPrice || 'none'})`);

  const freshOrigin = [];
  for (const { url, source } of searchUrls.filter(s => s.source !== 'sv')) {
    try {
      const actor = source === 'mde' ? APIFY_MDE : APIFY_AS24;
      const rows  = await scrapeUrl(actor, url);
      freshOrigin.push(...rows.map(r => ({ ...r, _src: source })));
      console.log(`  ${source.toUpperCase()}: ${rows.length}`);
    } catch (e) { console.error(`  ${source} error:`, e.message); }
  }

  // Modo aprendizagem: primeira sync nunca notifica, só regista
  const isFirstSync = !analysis.lastSync;
  const knownListings = analysis.knownListings || {};
  const newListings = [];
  const priceDrops = [];

  // Avalia cada anúncio: calcula score + verifica filtros
  const evaluate = (r) => {
    const price = getPrice(r);
    if (!price) return { passes: false, score: null, calc: null };

    // Hard limit: maxPrice (se definido)
    if (maxPrice > 0 && price > maxPrice) {
      return { passes: false, reason: 'over-maxPrice', score: null, calc: null };
    }

    // Score (precisa cachedRef)
    const calc = cachedRef ? calcQuickScore(r, cachedRef) : null;
    const score = calc?.score ?? null;

    // Sem cachedRef: notifica tudo (não consegue decidir)
    // Com cachedRef: só notifica se score >= minScore
    const passes = score == null ? true : score >= minScore;

    return { passes, score, calc };
  };

  for (const r of freshOrigin) {
    const id = getId(r);
    if (!id) continue;
    const price = getPrice(r);
    const evalResult = evaluate(r);

    if (!knownListings[id]) {
      // Anúncio novo
      if (evalResult.passes) {
        newListings.push({ r, score: evalResult.score, calc: evalResult.calc });
      }
      knownListings[id] = {
        price,
        score: evalResult.score,
        firstSeen: new Date().toISOString()
      };
    } else {
      // Anúncio conhecido
      const prev = knownListings[id];
      const priceDropped = price != null && prev.price != null && price < prev.price;
      const wasBelow = prev.score == null || prev.score < minScore;
      const nowPasses = evalResult.passes;

      // Notifica descida se: caiu de preço E agora passa no filtro
      if (priceDropped && nowPasses) {
        priceDrops.push({
          r, prev, price,
          score: evalResult.score,
          calc: evalResult.calc,
          crossedThreshold: wasBelow
        });
      }
      knownListings[id] = {
        price,
        score: evalResult.score,
        firstSeen: prev.firstSeen
      };
    }
  }

  // ── PRIMEIRA SYNC: aprende silenciosamente ──
  if (isFirstSync) {
    console.log(`  → Primeira sync (aprendizagem): ${freshOrigin.length} anúncios registados`);
    if (ntfyChannel) {
      const refTxt = cachedRef?.priceMedian
        ? `Ref. PT: ${fmtEur(cachedRef.priceMedian)} (${cachedRef.countMatched || 'n/d'} carros)`
        : '⚠ Sem referência PT — score não vai estar disponível';
      const msg = `${freshOrigin.length} anúncios registados como ponto de partida.\n\nFiltros activos:\n• Score mín: ${minScore}\n${maxPrice ? `• Preço máx: ${fmtEur(maxPrice)}\n` : ''}• ${refTxt}\n\nPróxima sync: 12h00`;
      await notify(ntfyChannel, `🌱 ${name} (sync iniciada)`, msg, 'default', analysis.id);
    }
  } else {
    // ── 🚗 Novos anúncios ──
    const MAX_NEW = 5;
    if (newListings.length > 0) {
      console.log(`  → ${newListings.length} novos anúncios passam filtros`);

      if (newListings.length > MAX_NEW) {
        // RESUMO: muitos novos. Ordena por score desc (melhores primeiro).
        const sorted = [...newListings].sort((a, b) => (b.score || 0) - (a.score || 0));
        const top3 = sorted.slice(0, 3);
        const avgScore = Math.round(sorted.reduce((s, x) => s + (x.score || 0), 0) / sorted.length);

        const top3Lines = top3.map((x, i) => {
          const price = getPrice(x.r);
          const km = getKm(x.r);
          return `${i+1}. Score ${x.score ?? '—'} · ${fmtEur(price)} · ${km || 'n/d'}`;
        }).join('\n');

        const msg = `Top 3 (score médio ${avgScore}):\n${top3Lines}\n\n+ ${sorted.length - 3} outros (score ≥ ${minScore})\n👉 Tap para ver todos`;
        await notify(ntfyChannel, `🚗 ${name} (${sorted.length} novos)`, msg, 'high', analysis.id);
      } else {
        // POUCOS NOVOS: notificação detalhada por cada
        // Ordena por score desc (melhor primeiro)
        const sorted = [...newListings].sort((a, b) => (b.score || 0) - (a.score || 0));
        for (const { r, score, calc } of sorted) {
          const price = getPrice(r);
          const make = getMake(r);
          const model = getModel(r);
          const km = getKm(r);

          // Título: modelo (e ano se disponível)
          const year = r['firstRegistration'] || r.year || r['vehicle/firstRegistration'] || '';
          const yearStr = year ? ` ${year}`.slice(0, 5) : '';
          const title = `🚗 ${make} ${model}${yearStr}`.trim();

          // Linha 1 (subtítulo): score + preço + margem
          let subtitle;
          if (score != null && calc) {
            const marginSign = calc.ml >= 0 ? '+' : '−';
            subtitle = `Score ${score} · ${fmtEur(price)} · ${marginSign}${fmtEur(Math.abs(calc.ml))} margem`;
          } else {
            subtitle = `${fmtEur(price)} · ${km || 'km n/d'}`;
          }

          // Corpo: detalhes
          let body;
          if (calc) {
            body = `${km || 'km n/d'}${yearStr ? ' · ' + year : ''}\nCusto total: ${fmtEur(calc.custo)}\nRef. PT: ${fmtEur(calc.svRef)}\n👉 Tap para abrir`;
          } else {
            body = `${km || 'km n/d'}\n${getId(r)}`;
          }

          await notify(ntfyChannel, title, body, 'high', analysis.id, subtitle);
        }
      }
    } else {
      console.log(`  → Sem novos anúncios acima de score ${minScore}`);
    }

    // ── 📉 Descidas de preço ──
    const MAX_DROPS = 3;
    if (priceDrops.length > 0) {
      console.log(`  → ${priceDrops.length} descidas de preço`);
      // Ordena pelas maiores descidas
      const sortedDrops = [...priceDrops].sort((a, b) => (b.prev.price - b.price) - (a.prev.price - a.price));

      for (const { r, prev, price, score, calc, crossedThreshold } of sortedDrops.slice(0, MAX_DROPS)) {
        const drop = prev.price - price;
        const dropPct = Math.round((drop / prev.price) * 100);

        const make = getMake(r);
        const model = getModel(r);
        const year = r['firstRegistration'] || r.year || r['vehicle/firstRegistration'] || '';
        const yearStr = year ? ` ${year}`.slice(0, 5) : '';

        const title = `📉 ${make} ${model}${yearStr}`.trim();

        // Subtítulo: descida + score actual + margem
        let subtitle;
        if (score != null && calc) {
          const marginSign = calc.ml >= 0 ? '+' : '−';
          subtitle = `−${fmtEur(drop)} · Score ${score} · margem ${marginSign}${fmtEur(Math.abs(calc.ml))}`;
        } else {
          subtitle = `−${fmtEur(drop)} (−${dropPct}%)`;
        }

        // Body: histórico de preço + detalhes
        const cross = crossedThreshold ? '\n✓ Agora dentro do filtro' : '';
        let body = `${fmtEur(prev.price)} → ${fmtEur(price)} (−${dropPct}%)${cross}\n${getKm(r) || 'km n/d'}`;
        if (calc) {
          body += `\nCusto: ${fmtEur(calc.custo)} · Ref. PT: ${fmtEur(calc.svRef)}`;
        }
        body += `\n👉 Tap para abrir`;

        await notify(ntfyChannel, title, body, 'high', analysis.id, subtitle);
      }
      if (sortedDrops.length > MAX_DROPS) {
        await notify(ntfyChannel, `📉 ${name}`, `+ ${sortedDrops.length - MAX_DROPS} outras descidas de preço.\n👉 Tap para ver todas.`, 'low', analysis.id);
      }
    }
  }

  // Prune knownListings (mantém só os IDs ainda visíveis, max 2000)
  const freshIds = new Set(freshOrigin.map(getId).filter(Boolean));
  const pruned = {};
  for (const [id, val] of Object.entries(knownListings)) {
    if (freshIds.has(id)) pruned[id] = val;
  }
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

  // POST /notify { channel, title, message, priority?, tags? } — proxy ntfy via servidor (evita CORS no browser)
  if (req.method === 'POST' && u.pathname === '/notify') {
    try {
      const body = await readBody(req);
      const { channel, title, message, priority = 'default', tags = '' } = body;
      if (!channel) return err(res, 'channel required');
      if (!message) return err(res, 'message required');

      const headers = {};
      if (title) headers['Title'] = encodeNtfyHeader(title);
      if (priority) headers['Priority'] = priority;
      if (tags) headers['Tags'] = tags;  // tags são sempre ASCII no ntfy

      const resp = await fetch(`https://ntfy.sh/${encodeURIComponent(channel)}`, {
        method: 'POST',
        headers,
        body: message  // o body pode ter UTF-8 sem problema
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        return err(res, `ntfy ${resp.status}: ${text.substring(0,200)}`, resp.status);
      }
      return ok(res, { sent: true });
    } catch (e) {
      return err(res, e.message);
    }
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

  // POST /backup — upload current state (plataforma → servidor)
  if (req.method === 'POST' && u.pathname === '/backup') {
    try {
      const body = await readBody(req);
      const data = loadData();
      const now = Date.now();
      data.backup = {
        payload: body.payload,       // full JSON from exportarDados()
        uploadedAt: now,
        uploadedBy: body.uploader || 'unknown',
        version: (data.backup?.version || 0) + 1,
        sizeBytes: JSON.stringify(body.payload).length
      };
      saveData(data);

      // Notify via ntfy if channel provided
      if (body.ntfyChannel) {
        try {
          await fetch(`https://ntfy.sh/${body.ntfyChannel}`, {
            method: 'POST',
            headers: {
              'Title': encodeNtfyHeader('📦 Backup actualizado'),
              'Priority': 'default',
              'Tags': 'package,arrow_down',
              'Click': body.clickUrl || ''
            },
            body: `${body.uploader || 'Alguém'} actualizou os dados. Abre a app e sincroniza.`
          });
        } catch (e) { console.warn('ntfy notify failed:', e.message); }
      }

      return ok(res, { version: data.backup.version, uploadedAt: now });
    } catch (e) { return err(res, e.message); }
  }

  // GET /backup/meta — check if new version available (lightweight, <100 bytes)
  if (req.method === 'GET' && u.pathname === '/backup/meta') {
    try {
      const data = loadData();
      if (!data.backup) return ok(res, { exists: false });
      return ok(res, {
        exists: true,
        version: data.backup.version,
        uploadedAt: data.backup.uploadedAt,
        uploadedBy: data.backup.uploadedBy,
        sizeBytes: data.backup.sizeBytes
      });
    } catch (e) { return err(res, e.message); }
  }

  // GET /backup — download the current backup (returns full payload)
  if (req.method === 'GET' && u.pathname === '/backup') {
    try {
      const data = loadData();
      if (!data.backup) return err(res, 'No backup available', 404);
      return ok(res, data.backup);
    } catch (e) { return err(res, e.message); }
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
