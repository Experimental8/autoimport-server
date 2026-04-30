const cron  = require('node-cron');
const fetch = require('node-fetch');
const fs    = require('fs');
const http  = require('http');

const DATA_FILE  = './data.json';
const APIFY_TOKEN = process.env.APIFY_TOKEN;
const APIFY_AS24 = 'ivanvs/autoscout-scraper';
const APIFY_MDE  = 'ivanvs/mobile-de-scraper';
const APIFY_SV   = 'dadhalfdev/standvirtual-scraper';

// Versão da aplicação — usar formato YYYY-MM-DD-N (incrementar N se vários pushes no mesmo dia)
// Esta tem que coincidir com APP_VERSION no autoimport_v5.html
const APP_VERSION = '2026-04-30-8';
const APP_BUILT_AT = new Date().toISOString();

// Sync SV: refrescar referência PT a cada 2 dias (em ms)
const SV_SYNC_INTERVAL_MS = 2 * 24 * 60 * 60 * 1000;

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

// StandVirtual usa formato diferente: input_url string (não objecto)
// Actor browser-based, lento. 50 carros dão mediana robusta. 8GB RAM acelera ~2× vs 4GB.
async function scrapeUrlSV(url, maxItems = 50) {
  const endpoint = `https://api.apify.com/v2/acts/${encodeURIComponent(APIFY_SV)}/run-sync-get-dataset-items`;
  const params = new URLSearchParams({ token: APIFY_TOKEN, maxItems, format: 'json', memory: '8192' });
  const input = { input_url: url, maxItems };
  const resp = await fetch(`${endpoint}?${params}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
  });
  if (!resp.ok) throw new Error(`Apify SV ${resp.status}`);
  return resp.json();
}

// ── ntfy + history ────────────────────────────────────────────────────────
// Codifica headers HTTP com UTF-8 (RFC 2047) para suportar emojis
function encodeNtfyHeader(val) {
  if (!val) return val;
  if (/^[\x00-\x7F]*$/.test(val)) return val;
  return `=?UTF-8?B?${Buffer.from(val, 'utf-8').toString('base64')}?=`;
}

async function notify(channel, title, message, priority = 'default', analysisId = null, subtitle = null, listingUrl = null) {
  // Push via ntfy: só se houver canal configurado
  if (channel) {
    try {
      // ntfy não tem subtítulo nativo — prepend ao message como linha em destaque
      const fullMessage = subtitle ? `${subtitle}\n${'─'.repeat(20)}\n${message}` : message;
      await fetch(`https://ntfy.sh/${channel}`, {
        method: 'POST',
        headers: { 'Title': encodeNtfyHeader(title), 'Priority': priority, 'Tags': 'car,autoimport' },
        body: fullMessage,
      });
    } catch (e) { console.error('ntfy error:', e.message); }
  }

  // Histórico (7 dias) — SEMPRE guardado, mesmo sem canal ntfy.
  // Este é o feed que aparece na vista "Notificações" da app.
  const data = loadData();
  if (!data.notifications) data.notifications = [];
  data.notifications.push({
    id: Date.now() + Math.floor(Math.random() * 1000),  // evita colisões em chamadas rápidas
    analysisId,
    listingUrl,
    title,
    message,
    subtitle: subtitle || null,
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
  // Margem líquida em percentagem do custo total — métrica decisiva (substitui score na Fase 2)
  // mlPct é decimal (0.072 = 7.2%)
  const mlPct = custo > 0 ? ml / custo : 0;

  return { score, custo, mb, ml, svRef, transp, isv, mlPct, mlEur: ml };
}

// ── Sync ──────────────────────────────────────────────────────────────────

// Refresca cachedRef (referência PT) de uma análise via StandVirtual.
// Devolve true se foi feito, false se foi saltado (intervalo não atingido / sem URL SV).
async function syncSV(analysis) {
  const svUrls = (analysis.searchUrls || []).filter(s => s.source === 'sv');
  if (!svUrls.length) return false;

  // Verifica se passou o intervalo desde o último sync SV
  const lastSV = analysis.lastSyncSV ? new Date(analysis.lastSyncSV).getTime() : 0;
  const now = Date.now();
  if (now - lastSV < SV_SYNC_INTERVAL_MS) return false;

  console.log(`  [SV] Refresh referência PT: ${analysis.name}`);
  const allRows = [];
  for (const { url } of svUrls) {
    try {
      const rows = await scrapeUrlSV(url);
      allRows.push(...rows);
    } catch (e) {
      console.error(`  [SV] error:`, e.message);
    }
  }

  if (!allRows.length) {
    console.log(`  [SV] Sem resultados — mantém cachedRef anterior`);
    analysis.lastSyncSV = new Date().toISOString();
    return false;
  }

  // Calcular preço mediano e percentis 25/75
  const prices = allRows
    .map(r => parseFloat(String(r.price || r.preco || '').replace(/[^0-9.]/g, '')))
    .filter(p => !isNaN(p) && p > 0)
    .sort((a, b) => a - b);

  if (!prices.length) {
    analysis.lastSyncSV = new Date().toISOString();
    return false;
  }

  const median = prices[Math.floor(prices.length / 2)];
  const p25 = prices[Math.floor(prices.length * 0.25)];
  const p75 = prices[Math.floor(prices.length * 0.75)];

  analysis.cachedRef = {
    priceMedian: Math.round(median),
    priceP25: Math.round(p25),
    priceP75: Math.round(p75),
    countMatched: prices.length,
    timestamp: now,
  };
  analysis.lastSyncSV = new Date().toISOString();

  console.log(`  [SV] cachedRef actualizado: medianoPT=${Math.round(median)}€ (${prices.length} carros)`);
  return true;
}

async function syncAnalysis(analysis) {
  // Filtros suportados: minMarginPct (principal) + maxPrice (segurança extra)
  const { name, searchUrls, ntfyChannel, minMarginPct = 0.05, maxPrice = 0, cachedRef } = analysis;
  if (!searchUrls?.length) return;
  console.log(`[${new Date().toISOString()}] Syncing: ${name} (minMargin=${Math.round(minMarginPct*100)}% maxPrice=${maxPrice || 'none'})`);

  // Paraleliza chamadas Apify (AS24, MDE) — antes era sequencial, agora todas em simultâneo.
  // Promise.allSettled garante que falha de uma fonte não cancela as outras.
  const scrapeTargets = searchUrls.filter(s => s.source !== 'sv');
  const scrapeResults = await Promise.allSettled(
    scrapeTargets.map(async ({ url, source }) => {
      const actor = source === 'mde' ? APIFY_MDE : APIFY_AS24;
      const rows = await scrapeUrl(actor, url);
      return { source, rows };
    })
  );

  const freshOrigin = [];
  scrapeResults.forEach((result, i) => {
    const { source } = scrapeTargets[i];
    if (result.status === 'fulfilled') {
      const { rows } = result.value;
      freshOrigin.push(...rows.map(r => ({ ...r, _src: source })));
      console.log(`  ${source.toUpperCase()}: ${rows.length}`);
    } else {
      console.error(`  ${source} error:`, result.reason?.message || result.reason);
    }
  });

  // Modo aprendizagem: primeira sync nunca notifica, só regista
  const isFirstSync = !analysis.lastSync;
  const knownListings = analysis.knownListings || {};
  const newListings = [];
  const priceDrops = [];

  // Avalia cada anúncio: calcula margem + verifica filtros
  const evaluate = (r) => {
    const price = getPrice(r);
    if (!price) return { passes: false, mlPct: null, calc: null };

    // Hard limit: maxPrice (se definido)
    if (maxPrice > 0 && price > maxPrice) {
      return { passes: false, reason: 'over-maxPrice', mlPct: null, calc: null };
    }

    // Margem (precisa cachedRef)
    const calc = cachedRef ? calcQuickScore(r, cachedRef) : null;
    const mlPct = calc?.mlPct ?? null;

    // Sem cachedRef: notifica tudo (não consegue decidir)
    // Com cachedRef: só notifica se mlPct >= minMarginPct
    const passes = mlPct == null ? true : mlPct >= minMarginPct;

    return { passes, mlPct, calc };
  };

  for (const r of freshOrigin) {
    const id = getId(r);
    if (!id) continue;
    const price = getPrice(r);
    const evalResult = evaluate(r);
    const nowIso = new Date().toISOString();

    if (!knownListings[id]) {
      // Anúncio novo — guarda raw para a plataforma normalizar mais tarde
      if (evalResult.passes) {
        newListings.push({ r, mlPct: evalResult.mlPct, calc: evalResult.calc });
      }
      knownListings[id] = {
        raw: r,
        source: r._src || null,
        price,
        prevPrice: null,
        priceChangedAt: null,
        mlPct: evalResult.mlPct,
        firstSeen: nowIso,
        lastSeen: nowIso,
        missingCount: 0,
        archived: false,
        archivedAt: null,
      };
    } else {
      // Anúncio conhecido
      const prev = knownListings[id];
      const priceDropped = price != null && prev.price != null && price < prev.price;
      const priceChanged = price != null && prev.price != null && price !== prev.price;
      const wasBelow = prev.mlPct == null || prev.mlPct < minMarginPct;
      const nowPasses = evalResult.passes;

      // Notifica descida se: caiu de preço E agora passa no filtro
      if (priceDropped && nowPasses) {
        priceDrops.push({
          r, prev, price,
          mlPct: evalResult.mlPct,
          calc: evalResult.calc,
          crossedThreshold: wasBelow
        });
      }

      // Actualiza estado, preservando histórico de preço se mudou
      knownListings[id] = {
        ...prev,
        raw: r,
        source: r._src || prev.source || null,
        price,
        prevPrice: priceChanged ? prev.price : prev.prevPrice,
        priceChangedAt: priceChanged ? nowIso : prev.priceChangedAt,
        mlPct: evalResult.mlPct,
        lastSeen: nowIso,
        missingCount: 0,
        // Se estava arquivado e voltou a aparecer, desarquiva
        archived: false,
        archivedAt: prev.archived ? null : prev.archivedAt,
      };
    }
  }

  // ── PRIMEIRA SYNC: aprende silenciosamente ──
  if (isFirstSync) {
    console.log(`  → Primeira sync (aprendizagem): ${freshOrigin.length} anúncios registados`);
    if (ntfyChannel) {
      const refTxt = cachedRef?.priceMedian
        ? `Ref. PT: ${fmtEur(cachedRef.priceMedian)} (${cachedRef.countMatched || 'n/d'} carros)`
        : '⚠ Sem referência PT — margem não vai estar disponível';
      const msg = `${freshOrigin.length} anúncios registados como ponto de partida.\n\nFiltros activos:\n• Margem mín: ${Math.round(minMarginPct*100)}%\n${maxPrice ? `• Preço máx: ${fmtEur(maxPrice)}\n` : ''}• ${refTxt}\n\nPróxima sync: 12h00`;
      await notify(ntfyChannel, `🌱 ${name} (sync iniciada)`, msg, 'default', analysis.id);
    }
  } else {
    // ── 🚗 Novos anúncios ──
    const MAX_NEW = 5;
    if (newListings.length > 0) {
      console.log(`  → ${newListings.length} novos anúncios passam filtros`);

      const fmtMlp = (m) => m == null ? '—' : Math.round(m * 100) + '%';

      if (newListings.length > MAX_NEW) {
        // RESUMO: muitos novos. Ordena por margem desc (melhores primeiro).
        const sorted = [...newListings].sort((a, b) => (b.mlPct || 0) - (a.mlPct || 0));
        const top3 = sorted.slice(0, 3);
        const valid = sorted.filter(x => x.mlPct != null);
        const avgMlp = valid.length ? valid.reduce((s, x) => s + x.mlPct, 0) / valid.length : null;

        const top3Lines = top3.map((x, i) => {
          const price = getPrice(x.r);
          const km = getKm(x.r);
          return `${i+1}. ${fmtMlp(x.mlPct)} · ${fmtEur(price)} · ${km || 'n/d'}`;
        }).join('\n');

        const avgTxt = avgMlp != null ? ` (margem média ${fmtMlp(avgMlp)})` : '';
        const msg = `Top 3${avgTxt}:\n${top3Lines}\n\n+ ${sorted.length - 3} outros (margem ≥ ${Math.round(minMarginPct*100)}%)\n👉 Tap para ver todos`;
        await notify(ntfyChannel, `🚗 ${name} (${sorted.length} novos)`, msg, 'high', analysis.id);
      } else {
        // POUCOS NOVOS: notificação detalhada por cada
        // Ordena por margem desc (melhor primeiro)
        const sorted = [...newListings].sort((a, b) => (b.mlPct || 0) - (a.mlPct || 0));
        for (const { r, mlPct, calc } of sorted) {
          const price = getPrice(r);
          const make = getMake(r);
          const model = getModel(r);
          const km = getKm(r);

          // Título: modelo (e ano se disponível)
          const year = r['firstRegistration'] || r.year || r['vehicle/firstRegistration'] || '';
          const yearStr = year ? ` ${year}`.slice(0, 5) : '';
          const title = `🚗 ${make} ${model}${yearStr}`.trim();

          // Linha 1 (subtítulo): margem + preço + valor margem
          let subtitle;
          if (mlPct != null && calc) {
            const marginSign = calc.ml >= 0 ? '+' : '−';
            subtitle = `${fmtMlp(mlPct)} · ${fmtEur(price)} · ${marginSign}${fmtEur(Math.abs(calc.ml))} margem`;
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

          await notify(ntfyChannel, title, body, 'high', analysis.id, subtitle, getId(r));
        }
      }
    } else {
      console.log(`  → Sem novos anúncios acima de margem ${Math.round(minMarginPct*100)}%`);
    }

    // ── 📉 Descidas de preço ──
    const MAX_DROPS = 3;
    if (priceDrops.length > 0) {
      console.log(`  → ${priceDrops.length} descidas de preço`);
      // Ordena pelas maiores descidas
      const sortedDrops = [...priceDrops].sort((a, b) => (b.prev.price - b.price) - (a.prev.price - a.price));

      for (const { r, prev, price, mlPct, calc, crossedThreshold } of sortedDrops.slice(0, MAX_DROPS)) {
        const drop = prev.price - price;
        const dropPct = Math.round((drop / prev.price) * 100);

        const make = getMake(r);
        const model = getModel(r);
        const year = r['firstRegistration'] || r.year || r['vehicle/firstRegistration'] || '';
        const yearStr = year ? ` ${year}`.slice(0, 5) : '';

        const title = `📉 ${make} ${model}${yearStr}`.trim();

        // Subtítulo: descida + margem actual + margem €
        const fmtMlp = (m) => m == null ? '—' : Math.round(m * 100) + '%';
        let subtitle;
        if (mlPct != null && calc) {
          const marginSign = calc.ml >= 0 ? '+' : '−';
          subtitle = `−${fmtEur(drop)} · ${fmtMlp(mlPct)} · ${marginSign}${fmtEur(Math.abs(calc.ml))}`;
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

        await notify(ntfyChannel, title, body, 'high', analysis.id, subtitle, getId(r));
      }
      if (sortedDrops.length > MAX_DROPS) {
        await notify(ntfyChannel, `📉 ${name}`, `+ ${sortedDrops.length - MAX_DROPS} outras descidas de preço.\n👉 Tap para ver todas.`, 'low', analysis.id);
      }
    }
  }

  // Incrementa missingCount para anúncios que não apareceram nesta sync
  // (em vez de prune imediato — tolerância de 2 syncs antes de arquivar)
  const ARCHIVE_THRESHOLD = 2;
  const freshIds = new Set(freshOrigin.map(getId).filter(Boolean));
  const nowIso = new Date().toISOString();
  for (const [id, val] of Object.entries(knownListings)) {
    if (freshIds.has(id)) continue; // já actualizado no loop acima
    val.missingCount = (val.missingCount || 0) + 1;
    if (val.missingCount >= ARCHIVE_THRESHOLD && !val.archived) {
      val.archived = true;
      val.archivedAt = nowIso;
    }
  }

  // Limite máximo de entradas por análise: 3000 (mais generoso porque agora guardamos raw)
  // Mantém todos os archived recentes (últimos 30 dias) + activos
  const MAX_ENTRIES = 3000;
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const survivors = Object.entries(knownListings).filter(([_, v]) => {
    if (!v.archived) return true; // activos sempre
    const archivedTs = v.archivedAt ? new Date(v.archivedAt).getTime() : 0;
    return archivedTs > cutoff; // archived só se < 30 dias
  });
  // Se ainda passa o limite, descarta os mais antigos (por lastSeen)
  if (survivors.length > MAX_ENTRIES) {
    survivors.sort((a, b) => {
      const tA = new Date(a[1].lastSeen || a[1].firstSeen || 0).getTime();
      const tB = new Date(b[1].lastSeen || b[1].firstSeen || 0).getTime();
      return tB - tA; // mais recentes primeiro
    });
    survivors.length = MAX_ENTRIES;
  }
  analysis.knownListings = Object.fromEntries(survivors);
  analysis.lastSync = new Date().toISOString();
}

async function syncAll() {
  const data = loadData();
  if (!data.analyses.length) { console.log('No analyses to sync.'); return; }
  for (const a of data.analyses) {
    if (!a.syncEnabled) continue;
    try {
      // Refresca referência PT (1× a cada 2 dias) antes do sync principal
      await syncSV(a);
      await syncAnalysis(a);
    } catch (e) {
      console.error(`Error syncing ${a.name}:`, e.message);
    }
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

  if (req.method === 'GET' && u.pathname === '/version') {
    return ok(res, { version: APP_VERSION, builtAt: APP_BUILT_AT });
  }

  // POST /admin/wipe — apaga TODOS os dados do servidor
  // Sem autenticação por simplicidade (B2B com 2 utilizadores).
  // Apaga: analyses, notifications, backup, specsCache. Faz "fábrica zero".
  if (req.method === 'POST' && u.pathname === '/admin/wipe') {
    try {
      saveData({ analyses: [], notifications: [], backup: null, specsCache: {} });
      console.log(`[${new Date().toISOString()}] ⚠️  /admin/wipe: TUDO apagado (analyses, notifications, backup, specsCache)`);
      return ok(res, { ok: true, message: 'Todos os dados apagados (analyses + notifications + backup + specsCache)' });
    } catch (e) {
      return err(res, e.message);
    }
  }

  if (req.method === 'GET' && u.pathname === '/analyses') {
    return ok(res, loadData().analyses.map(a => ({
      id: a.id, name: a.name, syncEnabled: a.syncEnabled,
      minMarginPct: a.minMarginPct, ntfyChannel: a.ntfyChannel,
      lastSync: a.lastSync, searchUrls: a.searchUrls,
    })));
  }

  if (req.method === 'POST' && u.pathname === '/analyses') {
    try {
      const payload = await readBody(req);
      const data = loadData();
      const idx = data.analyses.findIndex(a => a.id === payload.id);

      // Extrair existingUrls (não persistir no analysis directamente — é input para knownListings)
      const existingUrls = Array.isArray(payload.existingUrls) ? payload.existingUrls : null;
      const cleanPayload = { ...payload };
      delete cleanPayload.existingUrls;

      if (idx >= 0) {
        data.analyses[idx] = { ...data.analyses[idx], ...cleanPayload };
        // Se análise já existe e cliente envia existingUrls, popular knownListings
        // dos URLs que ainda não estão lá. Usa firstSeen=epoch (1970) para garantir
        // que NÃO contam como novidade quando o cliente fizer GET /delta?since=AGORA.
        if (existingUrls){
          if (!data.analyses[idx].knownListings) data.analyses[idx].knownListings = {};
          const kl = data.analyses[idx].knownListings;
          const epoch = '1970-01-01T00:00:00.000Z';
          let added = 0;
          for (const url of existingUrls){
            if (!url) continue;
            if (!kl[url]){
              kl[url] = {
                raw: null, source: null,
                price: null, prevPrice: null,
                priceChangedAt: null, mlPct: null,
                firstSeen: epoch,            // ← garante que NÃO conta como novo
                lastSeen: epoch,
                missingCount: 0,
                archived: false, archivedAt: null,
              };
              added++;
            }
          }
          if (added > 0) console.log(`POST /analyses: pré-populadas ${added} known listings para análise ${cleanPayload.id}`);
        }
      } else {
        const newAnalysis = { knownListings: {}, lastSync: null, ...cleanPayload };
        // Mesmo tratamento para análise nova: pré-popular knownListings
        if (existingUrls){
          const epoch = '1970-01-01T00:00:00.000Z';
          for (const url of existingUrls){
            if (!url) continue;
            newAnalysis.knownListings[url] = {
              raw: null, source: null,
              price: null, prevPrice: null,
              priceChangedAt: null, mlPct: null,
              firstSeen: epoch, lastSeen: epoch,
              missingCount: 0, archived: false, archivedAt: null,
            };
          }
          console.log(`POST /analyses: análise nova ${cleanPayload.id} pré-populada com ${existingUrls.length} known listings`);
        }
        data.analyses.push(newAnalysis);
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

  // GET /analyses/:id/delta?since=<ISO timestamp>
  // Devolve novos / com preço alterado / arquivados desde o timestamp dado.
  // A plataforma usa para se actualizar com o que o cron descobriu.
  if (req.method === 'GET' && /^\/analyses\/[^/]+\/delta$/.test(u.pathname)) {
    const id = u.pathname.split('/')[2];
    const sinceParam = u.searchParams.get('since');
    const sinceTs = sinceParam ? new Date(sinceParam).getTime() : 0;
    const data = loadData();
    const a = (data.analyses || []).find(x => String(x.id) === String(id));
    if (!a) return err(res, 'analysis not found', 404);

    const kl = a.knownListings || {};
    const novos = [];
    const alterados = [];
    const arquivados = [];

    for (const [listingId, v] of Object.entries(kl)) {
      const firstSeenTs = v.firstSeen ? new Date(v.firstSeen).getTime() : 0;
      const priceChangedTs = v.priceChangedAt ? new Date(v.priceChangedAt).getTime() : 0;
      const archivedTs = v.archivedAt ? new Date(v.archivedAt).getTime() : 0;

      // Novo: firstSeen depois do since
      if (firstSeenTs > sinceTs && !v.archived) {
        novos.push({ id: listingId, raw: v.raw, source: v.source, firstSeen: v.firstSeen, mlPct: v.mlPct });
      }
      // Alterado: priceChangedAt depois do since (e não é só "novo")
      else if (priceChangedTs > sinceTs && !v.archived && firstSeenTs <= sinceTs) {
        alterados.push({
          id: listingId, raw: v.raw, source: v.source,
          price: v.price, prevPrice: v.prevPrice,
          priceChangedAt: v.priceChangedAt, mlPct: v.mlPct,
        });
      }
      // Arquivado: archivedAt depois do since
      if (v.archived && archivedTs > sinceTs) {
        arquivados.push({ id: listingId, archivedAt: v.archivedAt });
      }
    }

    return ok(res, {
      analysisId: a.id,
      lastSync: a.lastSync || null,
      lastSyncSV: a.lastSyncSV || null,
      cachedRef: a.cachedRef || null,
      novos, alterados, arquivados,
    });
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
          currentMargin: kl[listingUrl].mlPct,
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

  // POST /notify/test { channel, analysisId?, listingUrl? }
  // Envia uma notificação fake do tipo "carro novo".
  // Se passares analysisId+listingUrl, ao clicar na notificação na plataforma
  // navega para a análise + abre modal do carro (testa o fluxo completo).
  if (req.method === 'POST' && u.pathname === '/notify/test') {
    try {
      const body = await readBody(req);
      const { channel, analysisId, listingUrl } = body;
      if (!channel) return err(res, 'channel required');

      // Simular uma notificação igual à que o cron geraria
      const title = '🚗 BMW M3 Touring 2024 (TESTE)';
      const subtitle = 'Score 47 · €82.500 · +€8.400 margem';
      const message = '18.000 km · 2024\nCusto total: €89.500\nRef. PT: €97.900\n👉 Esta é uma notificação de teste';

      await notify(channel, title, message, 'high', analysisId || 'test', subtitle, listingUrl || null);
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

  // DELETE /notifications/<id> — apaga uma notificação
  if (req.method === 'DELETE' && u.pathname.startsWith('/notifications/')) {
    const id = parseInt(u.pathname.split('/').pop());
    const data = loadData();
    const before = (data.notifications || []).length;
    data.notifications = (data.notifications || []).filter(n => n.id !== id);
    saveData(data);
    return ok(res, { ok: true, removed: before - data.notifications.length });
  }

  // DELETE /notifications — apaga todas
  if (req.method === 'DELETE' && u.pathname === '/notifications') {
    const data = loadData();
    const before = (data.notifications || []).length;
    data.notifications = [];
    saveData(data);
    return ok(res, { ok: true, removed: before });
  }

  if (req.method === 'POST' && u.pathname === '/sync') {
    ok(res, { ok: true, message: 'Sync started' });
    syncAll().catch(console.error);
    return;
  }

  // ── Specs cache (compartilhado entre dispositivos e utilizadores) ──────
  // GET /specs-cache → devolve todo o cache { key: {co2, cilindrada, ...} }
  // Cliente faz lookup local sem round-trip.
  // Cresce até ~1000 entries (~80KB) — tamanho insignificante.
  if (req.method === 'GET' && u.pathname === '/specs-cache') {
    const data = loadData();
    return ok(res, data.specsCache || {});
  }

  // POST /specs-cache → recebe batch de novas entries para adicionar/atualizar
  // Body: [{ key, co2, cilindrada, co2_norma, co2_conf }, ...]
  // Útil para escrever várias entries de uma vez (ex: após processar Fase 2)
  if (req.method === 'POST' && u.pathname === '/specs-cache') {
    try {
      const body = await readBody(req);
      const entries = JSON.parse(body || '[]');
      if (!Array.isArray(entries)) return err(res, 'Body must be array', 400);
      const data = loadData();
      if (!data.specsCache) data.specsCache = {};
      let added = 0;
      entries.forEach(e => {
        if (!e.key) return;
        data.specsCache[e.key] = {
          co2: e.co2 || 0,
          cilindrada: e.cilindrada || 0,
          co2_norma: e.co2_norma || 'WLTP',
          co2_conf: e.co2_conf || 'média',
          ts: Date.now()
        };
        added++;
      });
      // Limit a 1000 entries — drop oldest (FIFO por timestamp)
      const keys = Object.keys(data.specsCache);
      if (keys.length > 1000) {
        const sorted = keys.sort((a,b) => (data.specsCache[a].ts||0) - (data.specsCache[b].ts||0));
        sorted.slice(0, keys.length - 1000).forEach(k => delete data.specsCache[k]);
      }
      saveData(data);
      return ok(res, { ok: true, added, total: Object.keys(data.specsCache).length });
    } catch(e){ return err(res, e.message, 400); }
  }

  // DELETE /specs-cache → limpar tudo (debug)
  if (req.method === 'DELETE' && u.pathname === '/specs-cache') {
    const data = loadData();
    const before = Object.keys(data.specsCache || {}).length;
    data.specsCache = {};
    saveData(data);
    return ok(res, { ok: true, removed: before });
  }

  err(res, 'Not found', 404);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`AutoImport server running on port ${PORT}`));
// Sync às 08h, 12h, 14h30 e 17h30 — hora de Lisboa (PT). Sem `timezone` explícita,
// node-cron usa o TZ do processo, que no Railway é UTC → no horário de verão
// (CEST, UTC+1) os crons corriam 1h atrasados (08h Lisboa → 09h real).
// Bug detectado em produção 2026-04-30: análise tinha cron das 12h a disparar às 13h.
const syncTimes = ['0 8 * * *', '0 12 * * *', '30 14 * * *', '30 17 * * *'];
syncTimes.forEach(expr => {
  cron.schedule(expr, () => {
    console.log(`⏰ Sync scheduled: ${expr}`);
    syncAll().catch(console.error);
  }, { timezone: 'Europe/Lisbon' });
});
console.log('✅ Cron: 08h, 12h, 14h30, 17h30 (Europe/Lisbon) — todos os dias');
syncAll().catch(console.error);
