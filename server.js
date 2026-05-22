const cron  = require('node-cron');
const fetch = require('node-fetch');
const fs    = require('fs');
const http  = require('http');

const path  = require('path');

// Caminho de persistência: se o Railway montou um volume, usa-o (sobrevive a deploys/restarts).
// Caso contrário, fallback para './data.json' no working dir (modo desenvolvimento ou
// servidor sem volume — comportamento histórico).
// Bug histórico (até 2026-05-04): o filesystem do Railway era efémero. Cada redeploy
// apagava knownListings, notifications, e analyses. Mitigação manual: backup antes de
// cada deploy. Fix: volume persistente — RAILWAY_VOLUME_MOUNT_PATH é set automaticamente
// pelo Railway em runtime quando há volume configurado no dashboard.
const VOLUME_PATH = process.env.RAILWAY_VOLUME_MOUNT_PATH || null;
const DATA_FILE   = VOLUME_PATH ? path.join(VOLUME_PATH, 'data.json') : './data.json';
const LEGACY_DATA = './data.json';

// Migração transparente: na primeira vez que arrancamos com volume montado, se o ficheiro
// não existe no volume mas existe no caminho legacy (deploy anterior), copia-o.
// Idempotente: só corre se faz sentido (volume vazio + legacy presente).
if (VOLUME_PATH) {
  try {
    if (!fs.existsSync(VOLUME_PATH)) fs.mkdirSync(VOLUME_PATH, { recursive: true });
    if (!fs.existsSync(DATA_FILE) && fs.existsSync(LEGACY_DATA)) {
      fs.copyFileSync(LEGACY_DATA, DATA_FILE);
      console.log(`📦 Migração: data.json copiado de ${LEGACY_DATA} para ${DATA_FILE}`);
    }
    console.log(`💾 Persistência: ${DATA_FILE} (volume montado em ${VOLUME_PATH})`);
  } catch (e) {
    console.error(`⚠ Erro a inicializar volume:`, e.message);
  }
} else {
  console.log(`💾 Persistência: ${DATA_FILE} (sem volume — efémero)`);
}

const APIFY_TOKEN = process.env.APIFY_TOKEN;
const APIFY_AS24 = 'ivanvs/autoscout-scraper';
const APIFY_MDE  = 'ivanvs/mobile-de-scraper';
const APIFY_SV   = 'dadhalfdev/standvirtual-scraper';

// Versão da aplicação — usar formato YYYY-MM-DD-N (incrementar N se vários pushes no mesmo dia)
// Esta tem que coincidir com APP_VERSION no autoimport_v5.html
const APP_VERSION = '2026-05-14-8';
const APP_BUILT_AT = new Date().toISOString();

// Modelo de IA usado pelo endpoint /co2-suggest (extensão autoimport.app).
// Sonnet 4.6 — atual e ativo (o claude-sonnet-4-20250514 foi reformado pela
// Anthropic em 2026-04-20, daí dar 404). Se a B2B usar outro, mudar só esta linha.
const CO2_MODEL = 'claude-sonnet-4-6';

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
// Apify devolve JSON aninhado por defeito ({properties: {milage: "..."}}).
// O resto do código procura chaves planas com slash ({'properties/milage': "..."}).
// Esta função aplana o raw recursivamente — idempotente, preserva arrays.
// Bug histórico 2026-04-30: 42 BMW M3 vindos do scrape do servidor ficaram com
// preço=null porque getPrice procurava 'price/amount' mas o raw tinha price.amount
// aninhado. Cliente também falhou ao processar pelo mesmo motivo.
function flattenRaw(obj, prefix){
  prefix = prefix || '';
  if(!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;
  const out = {};
  for(const k in obj){
    if(!Object.prototype.hasOwnProperty.call(obj, k)) continue;
    const v = obj[k];
    const newKey = prefix ? prefix + '/' + k : k;
    if(v && typeof v === 'object' && !Array.isArray(v)){
      Object.assign(out, flattenRaw(v, newKey));
    } else {
      out[newKey] = v;
    }
  }
  return out;
}

function getId(r) { return r.url || r.id || null; }

function getPrice(r) {
  r = flattenRaw(r);
  const raw = r['price/amount'] || r.rawPrice || r.price || '';
  const n = parseFloat(String(raw).replace(/[^0-9.]/g, ''));
  return isNaN(n) ? null : n;
}

function getMake(r)  { r = flattenRaw(r); return r.manufacturer || r.make || ''; }
function getModel(r) { r = flattenRaw(r); return r.model || ''; }
function getKm(r)    { r = flattenRaw(r); return r['properties/milage'] || r.milage || ''; }
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
  r = flattenRaw(r);
  return r['vehicle/country'] || r['dealer/contry'] || r['dealer/address/contry'] || r.country || r['vehicleLocation/country'] || 'D';
}

function getFuel(r) {
  r = flattenRaw(r);
  return r['vehicle/fuel'] || r.fuel || r['fuelType'] || r['properties/fuelType'] || '';
}

// ── ISV correcto via specsCache (0.2.4) ──────────────────────────────────
// Bug histórico: ISV_BY_FUEL_SIMPLIFIED usava €5500 fixo gasolina mas BMW M3 paga
// €19 586 (3.5×). Notificações apareciam com 18% margem quando o cliente real via 3%.
// Fix: o servidor usa specsCache (que o cliente popula com cilindrada+CO2 da IA) +
// cilindrada do raw + fórmula AT real para calcular ISV verdadeira. Se não houver
// dados suficientes, NÃO notifica em vez de notificar com estimativa errada.

function getCC(r) {
  r = flattenRaw(r);
  const raw = r.engineSize || r['engineSize'] || r['vehicle/engineSize'] || '';
  if (!raw) return 0;
  // Format AS24: "2,993 cc" / MDE pode vir "2993 cm³"
  const m = String(raw).match(/[\d,.]+/);
  if (!m) return 0;
  return Math.round(parseFloat(m[0].replace(/[,.]/g, '')));
}

function getYear(r) {
  r = flattenRaw(r);
  const raw = r.firstRegistration || r.year || r['vehicle/firstRegistration'] || '';
  if (!raw) return 0;
  // Formato AS24: "04/2025" — só queremos o ano
  const m = String(raw).match(/(\d{4})/);
  return m ? parseInt(m[1]) : 0;
}

// Normaliza fuel do raw para o vocabulário do specsCache (que segue o do cliente).
// Cliente normaliza para: 'gasolina', 'gasóleo', 'elétrico', 'híbrido', 'phev', etc.
function normFuel(raw) {
  const f = (raw || '').toString().toLowerCase().trim();
  if (!f) return '';
  if (f.includes('gasolin') || f === 'petrol' || f.includes('benzin')) return 'gasolina';
  if (f.includes('diesel') || f.includes('gasóleo') || f.includes('gasoleo')) return 'gasóleo';
  if (f.includes('electric') || f.includes('elétric') || f.includes('eletric') || f === 'bev') return 'elétrico';
  if (f.includes('plug') || f.includes('phev')) return 'phev';
  if (f.includes('hybrid') || f.includes('híbrido') || f.includes('hibrido')) return 'híbrido';
  return f;
}

// Normaliza a transmissão para 'auto' | 'manual' | '' (desconhecida).
// Usada só pelo endpoint /co2-suggest (a B2B nunca passa transmissão).
function normTransm(raw) {
  const t = (raw || '').toString().toLowerCase().trim();
  if (!t) return '';
  if (t.includes('manual') || t.includes('schalt') || /\bmt\b/.test(t)) return 'manual';
  if (t.includes('auto') || t.includes('automá') || t.includes('pdk') || t.includes('dsg')
      || t.includes('tiptronic') || t.includes('tronic') || t.includes('dct')
      || t.includes('cvt') || t.includes('powershift') || t.includes('edc')
      || t.includes('g-tronic') || /\bat\b/.test(t)) return 'auto';
  return '';
}

// Fórmula AT real — port directo de calcISV() do cliente (autoimport_v5.html ~linha 2275).
// Mantém compatibilidade exacta com o que o cliente calcula, para que servidor e cliente
// concordem sempre sobre carros que estão no specsCache.
function calcISV_PT(cil, co2, fuel, ano, norma) {
  const c = (fuel || '').toLowerCase().trim();
  if (c === 'elétrico' || c === 'eletrico') return 0;
  const idade = new Date().getFullYear() - (ano || 2020);
  let cc = cil <= 1000 ? cil * 1.09 - 849.03
        : cil <= 1250 ? cil * 1.18 - 850.69
        : cil * 5.61 - 6194.88;
  cc = Math.max(0, cc);
  const isD = c === 'gasóleo' || c === 'gasoleo';
  const isPH = c === 'phev' || c.includes('plug');
  const n = isPH ? 'WLTP' : (norma || 'WLTP').toUpperCase();
  // Componentes ambientais (g/km)
  const agw = g => g <= 110 ? g*.44 - 43.02 : g <= 115 ? g*1.10 - 115.80 : g <= 120 ? g*1.38 - 147.79 : g <= 130 ? g*5.27 - 619.17 : g <= 145 ? g*6.38 - 762.73 : g <= 175 ? g*41.54 - 5819.56 : g <= 195 ? g*51.38 - 7247.39 : g <= 235 ? g*193.01 - 34190.52 : g*233.81 - 41910.96;
  const agn = g => g <= 99 ? g*4.62 - 427 : g <= 115 ? g*8.09 - 750.99 : g <= 145 ? g*52.56 - 5903.94 : g <= 175 ? g*61.24 - 7140.17 : g <= 195 ? g*155.97 - 23627.27 : g*205.65 - 33390.12;
  const adw = g => g <= 110 ? g*1.72 - 11.50 : g <= 120 ? g*18.96 - 1906.19 : g <= 140 ? g*65.04 - 7360.85 : g <= 150 ? g*127.40 - 16080.57 : g <= 160 ? g*160.81 - 21176.06 : g <= 170 ? g*221.69 - 29227.38 : g <= 190 ? g*274.08 - 36987.98 : g*282.35 - 38271.32;
  const adn = g => g <= 79 ? g*5.78 - 439.04 : g <= 95 ? g*23.45 - 1848.58 : g <= 120 ? g*79.22 - 7195.63 : g <= 140 ? g*175.73 - 18924.92 : g <= 160 ? g*195.43 - 21720.92 : g*268.42 - 33447.90;
  let amb = isD ? (n === 'NEDC' ? adn(co2) : adw(co2)) : (isPH ? agw(co2) : (n === 'NEDC' ? agn(co2) : agw(co2)));
  let bruto = cc + amb;
  if (isPH) bruto = Math.max(100, bruto * 0.25);
  else bruto = Math.max(100, bruto);
  // Tabela redução por idade (0% novo a 80% após 10 anos)
  const ds = [0, .10, .20, .28, .35, .43, .52, .60, .65, .70, .75, .80];
  const desc = idade <= 0 ? 0 : idade <= 10 ? ds[Math.min(idade, 10)] : ds[11];
  let isv = Math.max(100, Math.round(bruto * (1 - desc)));
  return isv;
}

// Procura entradas no specsCache que combinem com o raw. Como o servidor não tem
// submodelo nem potência (só vêm da IA do cliente), faz lookup por chave parcial
// e calcula média do CO2 das entradas que combinem. Se o specsCache tiver entradas
// para "BMW M3 2025 gasolina" com CO2 [232, 235, 238], usa a média (235).
function lookupSpecsForRaw(raw, specsCache) {
  if (!specsCache) return null;
  const make  = (getMake(raw)  || '').toLowerCase().trim();
  const model = (getModel(raw) || '').toLowerCase().trim();
  const fuel  = normFuel(getFuel(raw));
  const year  = getYear(raw);
  if (!make || !model || !fuel || !year) return null;

  // Transmissão pedida: SÓ definida pelo endpoint /co2-suggest
  // (raw.__transmissaoNorm). A B2B nunca a passa → tq='' → comportamento
  // EXACTAMENTE igual ao anterior (zero impacto na B2B).
  const tq = (raw && raw.__transmissaoNorm) || '';

  // Chave do cliente: marca|modelo|subFirst|ano|combustivel|pot[|transm]
  // Servidor procura com prefixo: marca|modelo|*|ano|combustivel|*
  // (subFirst e pot variam, vamos fazer match parcial)
  const todos = [];
  for (const [key, val] of Object.entries(specsCache)) {
    const parts = key.split('|');
    if (parts.length < 5) continue;
    if (parts[0] === make && parts[1] === model && parseInt(parts[3]) === year && parts[4] === fuel) {
      if (val && val.co2) todos.push({ v: val, tr: parts[6] || '' });
    }
  }
  if (!todos.length) return null;

  // Se sabemos a transmissão e há entradas dessa transmissão → usar SÓ essas
  // (PDK ≠ manual). Senão, cair na média de todas (comportamento antigo).
  let pool = todos;
  if (tq) {
    const mesmaTr = todos.filter(m => m.tr === tq);
    if (mesmaTr.length) pool = mesmaTr;
  }
  const matches = pool.map(m => m.v);

  // Média do CO2 das entradas que combinam
  const co2Avg = Math.round(matches.reduce((s, v) => s + (v.co2 || 0), 0) / matches.length);
  // Para cilindrada, preferimos o que vem do raw (mais preciso). Fallback: média do cache.
  const cilFromRaw = getCC(raw);
  const cilAvg = Math.round(matches.reduce((s, v) => s + (v.cilindrada || 0), 0) / matches.length);
  // Autonomia elétrica (km): média das entradas que a tenham. 0 se nenhuma tiver.
  const autEntries = matches.filter(v => v.autonomia != null && v.autonomia > 0);
  const autAvg = autEntries.length
    ? Math.round(autEntries.reduce((s, v) => s + v.autonomia, 0) / autEntries.length)
    : 0;
  return {
    co2: co2Avg,
    cilindrada: cilFromRaw || cilAvg,
    norma: matches[0].co2_norma || 'WLTP',
    autonomia: autAvg,
    matchCount: matches.length,
  };
}

function calcQuickScore(car, cachedRef, specsCache) {
  if (!cachedRef?.priceMedian) return null;
  const price = getPrice(car);
  if (!price) return null;

  const country = getCountry(car);
  const transp = TRANSPORT_BY_COUNTRY[country] || 700;

  const fuel = normFuel(getFuel(car));
  let isv;

  if (fuel === 'elétrico') {
    // Eléctricos: ISV é 0 por lei. Cálculo certo sem precisar de specsCache.
    isv = 0;
  } else {
    // Combustão: tenta lookup no specsCache. Sem dados → não notifica.
    const specs = lookupSpecsForRaw(car, specsCache);
    if (!specs) return null;  // Sem dados suficientes — não calcula nem notifica
    const ano = getYear(car) || 2020;
    isv = calcISV_PT(specs.cilindrada, specs.co2, fuel, ano, specs.norma);
  }

  const custo = price + transp + isv + LEGAL_FIXED;
  const svRef = cachedRef.priceMedian;
  const mb = svRef - custo;
  const ivaM = Math.round(0.23 * (svRef - price));
  const ml = mb - ivaM;
  const mp = custo > 0 ? mb / custo : 0;
  const score = Math.min(100, Math.max(0, Math.round(mp * 200)));
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

// ── Sync — peças ──────────────────────────────────────────────────────────
// syncAnalysis foi decomposta em 5 peças nomeadas para legibilidade.
// O orquestrador `syncAnalysis` chama-as por ordem. Comportamento idêntico ao anterior,
// excepto por uma adição: deduplicação cross-source nas notificações (evita push duplicado
// quando o mesmo carro aparece em AS24+MDE). knownListings continua a guardar ambos —
// o cliente faz uma 2ª camada de dedup ao integrar.

// ── 1. Recolher anúncios — Apify paralelo, ou usar raws fornecidos via /ingest ──
async function recolherAnuncios(analysis, injectedFreshOrigin) {
  if (injectedFreshOrigin) {
    // Modo ingest: usa raws fornecidos (já com _src injectado pelo cliente)
    console.log(`  INGEST: ${injectedFreshOrigin.length} raws recebidos`);
    return injectedFreshOrigin;
  }
  // Modo normal: paraleliza chamadas Apify (AS24, MDE) — antes era sequencial.
  // Promise.allSettled garante que falha de uma fonte não cancela as outras.
  const scrapeTargets = (analysis.searchUrls || []).filter(s => s.source !== 'sv');
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
  return freshOrigin;
}

// ── 2. Classificar listings — para cada raw, decidir se é novo, conhecido, ou alterado ──
// Modifica analysis.knownListings in-place. Devolve { newListings, priceDrops, isFirstSync }.
// `specsCache` (opcional) é usado pelo calcQuickScore para calcular ISV correcta com base
// em CO2/cilindrada que o cliente já populou via Fase 2 IA. Sem specsCache, calcQuickScore
// devolve null para combustão (não notifica) e ISV=0 só para eléctricos.
function classificarListings(analysis, freshOrigin, specsCache) {
  const { minMarginPct = 0.05, maxPrice = 0, cachedRef } = analysis;
  // Modo aprendizagem: primeira sync nunca notifica, só regista
  const isFirstSync = !analysis.lastSync;
  if (!analysis.knownListings) analysis.knownListings = {};
  const knownListings = analysis.knownListings;
  const newListings = [];
  const priceDrops = [];
  // Contadores de diagnóstico (logs após loop)
  let skippedNoSpecs = 0;

  // Avalia cada anúncio: calcula margem + verifica filtros
  const evaluate = (r) => {
    const price = getPrice(r);
    if (!price) return { passes: false, mlPct: null, calc: null };
    // Hard limit: maxPrice (se definido)
    if (maxPrice > 0 && price > maxPrice) {
      return { passes: false, reason: 'over-maxPrice', mlPct: null, calc: null };
    }
    // Margem (precisa cachedRef). Sem cachedRef: notifica tudo (não consegue decidir).
    // Com cachedRef mas sem specs no cache: calcQuickScore devolve null para combustão
    // → não notifica (decisão do utilizador: melhor sem notificação que falsa).
    const calc = cachedRef ? calcQuickScore(r, cachedRef, specsCache) : null;
    const mlPct = calc?.mlPct ?? null;
    // Se calc é null para combustão (sem specs), não passa
    if (cachedRef && !calc && normFuel(getFuel(r)) !== 'elétrico') {
      skippedNoSpecs++;
      return { passes: false, reason: 'no-specs-cache', mlPct: null, calc: null };
    }
    const passes = mlPct == null ? true : mlPct >= minMarginPct;
    return { passes, mlPct, calc };
  };

  for (const rawItem of freshOrigin) {
    const r = flattenRaw(rawItem);  // garante chaves planas para todo o loop
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
        raw: r, source: r._src || null,
        price, prevPrice: null, priceChangedAt: null,
        mlPct: evalResult.mlPct,
        firstSeen: nowIso, lastSeen: nowIso,
        missingCount: 0, archived: false, archivedAt: null,
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
          mlPct: evalResult.mlPct, calc: evalResult.calc,
          crossedThreshold: wasBelow
        });
      }
      // Actualiza estado, preservando histórico de preço se mudou
      knownListings[id] = {
        ...prev,
        raw: r, source: r._src || prev.source || null,
        price,
        prevPrice: priceChanged ? prev.price : prev.prevPrice,
        priceChangedAt: priceChanged ? nowIso : prev.priceChangedAt,
        mlPct: evalResult.mlPct,
        lastSeen: nowIso, missingCount: 0,
        // Se estava arquivado e voltou a aparecer, desarquiva
        archived: false,
        archivedAt: prev.archived ? null : prev.archivedAt,
      };
    }
  }
  return { newListings, priceDrops, isFirstSync, skippedNoSpecs };
}

// ── 2b. Detectar duplicado cross-source em raws ──
// Critério apertado (espelha isSameCarTight do cliente): marca + modelo iguais
// (case-insensitive), ano igual, km dentro 100, preço dentro 0.5%, fontes diferentes.
// Funciona em raws (não normalizados) usando os getters getMake/getModel/getKm/getPrice.
function _isDupCrossSourceRaw(a, b) {
  if (a._src && b._src && a._src === b._src) return false; // tem que ser cross-source
  const mA = String(getMake(a) || '').toLowerCase().trim();
  const mB = String(getMake(b) || '').toLowerCase().trim();
  if (mA && mB && mA !== mB) return false;
  const moA = String(getModel(a) || '').toLowerCase().trim();
  const moB = String(getModel(b) || '').toLowerCase().trim();
  if (moA && moB && moA !== moB) return false;
  const extractYear = s => { const m = String(s || '').match(/(\d{4})/); return m ? parseInt(m[1]) : 0; };
  const yA = extractYear(a.firstRegistration || a['properties/firstRegistration'] || a['vehicle/firstRegistration']);
  const yB = extractYear(b.firstRegistration || b['properties/firstRegistration'] || b['vehicle/firstRegistration']);
  if (yA && yB && yA !== yB) return false;
  const parseKm = v => parseInt(String(v || 0).replace(/[^0-9]/g, '')) || 0;
  const kA = parseKm(getKm(a));
  const kB = parseKm(getKm(b));
  if (kA && kB && Math.abs(kA - kB) > 100) return false;
  const pA = getPrice(a), pB = getPrice(b);
  if (pA && pB && Math.abs(pA - pB) / Math.max(pA, pB) > 0.005) return false;
  return true;
}

// ── 2c. Deduplicar lista de candidatos a notificação ──
// Usado para evitar enviar 2 push do mesmo carro (mesmo carro físico em AS24+MDE).
// items: array de { r, ... } onde r é o raw flattened.
// Devolve subset com 1 representante por grupo de duplicados.
function _deduplicarCrossSource(items) {
  const out = [];
  const used = new Set();
  for (let i = 0; i < items.length; i++) {
    if (used.has(i)) continue;
    out.push(items[i]);
    for (let j = i + 1; j < items.length; j++) {
      if (used.has(j)) continue;
      if (_isDupCrossSourceRaw(items[i].r, items[j].r)) used.add(j);
    }
  }
  return out;
}

// ── 3. Enviar notificações — primeira sync silenciosa, novos, descidas ──
async function enviarNotificacoes(analysis, freshOriginCount, isFirstSync, newListings, priceDrops) {
  const { name, ntfyChannel, minMarginPct = 0.05, maxPrice = 0, cachedRef } = analysis;
  const fmtMlp = (m) => m == null ? '—' : Math.round(m * 100) + '%';

  // ── PRIMEIRA SYNC: aprende silenciosamente ──
  if (isFirstSync) {
    console.log(`  → Primeira sync (aprendizagem): ${freshOriginCount} anúncios registados`);
    if (ntfyChannel) {
      const refTxt = cachedRef?.priceMedian
        ? `Ref. PT: ${fmtEur(cachedRef.priceMedian)} (${cachedRef.countMatched || 'n/d'} carros)`
        : '⚠ Sem referência PT — margem não vai estar disponível';
      const msg = `${freshOriginCount} anúncios registados como ponto de partida.\n\nFiltros activos:\n• Margem mín: ${Math.round(minMarginPct*100)}%\n${maxPrice ? `• Preço máx: ${fmtEur(maxPrice)}\n` : ''}• ${refTxt}\n\nPróxima sync: 12h00`;
      await notify(ntfyChannel, `🌱 ${name} (sync iniciada)`, msg, 'default', analysis.id);
    }
    return;
  }

  // ── 🚗 Novos anúncios — dedup cross-source antes de notificar ──
  const newDedup = _deduplicarCrossSource(newListings);
  const dupsSavedNew = newListings.length - newDedup.length;
  if (dupsSavedNew > 0) {
    console.log(`  → Dedup cross-source: ${dupsSavedNew} push duplicado(s) evitado(s) (novos)`);
  }

  const MAX_NEW = 5;
  if (newDedup.length > 0) {
    console.log(`  → ${newDedup.length} novos anúncios passam filtros`);
    if (newDedup.length > MAX_NEW) {
      // RESUMO: muitos novos. Ordena por margem desc (melhores primeiro).
      const sorted = [...newDedup].sort((a, b) => (b.mlPct || 0) - (a.mlPct || 0));
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
      const sorted = [...newDedup].sort((a, b) => (b.mlPct || 0) - (a.mlPct || 0));
      for (const { r, mlPct, calc } of sorted) {
        const price = getPrice(r);
        const make = getMake(r);
        const model = getModel(r);
        const km = getKm(r);
        // Título: modelo (e ano se disponível) + sufixo "oportunidade"
        const year = r['firstRegistration'] || r.year || r['vehicle/firstRegistration'] || '';
        const yearStr = year ? ` ${year}`.slice(0, 5) : '';
        const title = `🚗 ${make} ${model}${yearStr} — oportunidade`.trim();
        // Subtítulo: só preço (mais honesto — margem é estimativa frágil)
        const subtitle = `${fmtEur(price)}`;
        // Corpo: km/ano + custo estimado + ref PT + aviso ISV
        let body;
        if (calc) {
          // Eléctricos: ISV é exacta (=0), não dizer "estimada"
          const fuel = normFuel(getFuel(r));
          const isvNote = fuel === 'elétrico' ? '' : '\n⚠ ISV estimada';
          body = `${km || 'km n/d'}${yearStr ? ' · ' + year : ''}\nCusto estimado: ~${fmtEur(calc.custo)}\nRef. PT: ${fmtEur(calc.svRef)}${isvNote}\n👉 Tap para confirmar`;
        } else {
          body = `${km || 'km n/d'}\n${getId(r)}`;
        }
        await notify(ntfyChannel, title, body, 'high', analysis.id, subtitle, getId(r));
      }
    }
  } else {
    console.log(`  → Sem novos anúncios acima de margem ${Math.round(minMarginPct*100)}%`);
  }

  // ── 📉 Descidas de preço — também dedup cross-source ──
  const dropsDedup = _deduplicarCrossSource(priceDrops);
  const dupsSavedDrops = priceDrops.length - dropsDedup.length;
  if (dupsSavedDrops > 0) {
    console.log(`  → Dedup cross-source: ${dupsSavedDrops} push duplicado(s) evitado(s) (descidas)`);
  }

  const MAX_DROPS = 3;
  if (dropsDedup.length > 0) {
    console.log(`  → ${dropsDedup.length} descidas de preço`);
    // Ordena pelas maiores descidas
    const sortedDrops = [...dropsDedup].sort((a, b) => (b.prev.price - b.price) - (a.prev.price - a.price));
    for (const { r, prev, price, mlPct, calc, crossedThreshold } of sortedDrops.slice(0, MAX_DROPS)) {
      const drop = prev.price - price;
      const dropPct = Math.round((drop / prev.price) * 100);
      const make = getMake(r);
      const model = getModel(r);
      const year = r['firstRegistration'] || r.year || r['vehicle/firstRegistration'] || '';
      const yearStr = year ? ` ${year}`.slice(0, 5) : '';
      const title = `📉 ${make} ${model}${yearStr}`.trim();
      // Subtítulo: descida + margem actual + margem €
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
      if (calc) body += `\nCusto: ${fmtEur(calc.custo)} · Ref. PT: ${fmtEur(calc.svRef)}`;
      body += `\n👉 Tap para abrir`;
      await notify(ntfyChannel, title, body, 'high', analysis.id, subtitle, getId(r));
    }
    if (sortedDrops.length > MAX_DROPS) {
      await notify(ntfyChannel, `📉 ${name}`, `+ ${sortedDrops.length - MAX_DROPS} outras descidas de preço.\n👉 Tap para ver todas.`, 'low', analysis.id);
    }
  }
}

// ── 4. Arquivar desaparecidos — incrementar missingCount, arquivar após 2 syncs ──
// (em vez de prune imediato — tolerância de 2 syncs antes de arquivar)
function arquivarDesaparecidos(knownListings, freshOrigin) {
  const ARCHIVE_THRESHOLD = 2;
  const freshIds = new Set(freshOrigin.map(getId).filter(Boolean));
  const nowIso = new Date().toISOString();
  for (const [id, val] of Object.entries(knownListings)) {
    if (freshIds.has(id)) continue; // já actualizado em classificarListings
    val.missingCount = (val.missingCount || 0) + 1;
    if (val.missingCount >= ARCHIVE_THRESHOLD && !val.archived) {
      val.archived = true;
      val.archivedAt = nowIso;
    }
  }
}

// ── 5. Limpar histórico antigo ──
// Limite máximo de 3000 entradas. Mantém todos os activos + arquivados < 30 dias.
function limparHistoricoAntigo(knownListings) {
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
  return Object.fromEntries(survivors);
}

// ── Orquestrador principal ──
// Filtros suportados: minMarginPct (principal) + maxPrice (segurança extra).
// Se vier injectedFreshOrigin (ingest manual), salta scrape Apify — útil para testes
// end-to-end ou re-sincronização a partir de raws descarregados do Apify Console.
async function syncAnalysis(analysis, injectedFreshOrigin) {
  const { name, searchUrls, minMarginPct = 0.05, maxPrice = 0 } = analysis;
  if (!injectedFreshOrigin && !searchUrls?.length) return;
  const mode = injectedFreshOrigin ? 'INGEST' : 'SCRAPE';
  console.log(`[${new Date().toISOString()}] Syncing (${mode}): ${name} (minMargin=${Math.round(minMarginPct*100)}% maxPrice=${maxPrice || 'none'})`);

  // 1. Recolher raws
  const freshOrigin = await recolherAnuncios(analysis, injectedFreshOrigin);

  // 2. Classificar (modifica analysis.knownListings in-place)
  // Carrega specsCache do disco para calcular ISV real via cilindrada+CO2 que o cliente já viu
  const specsCache = (loadData().specsCache) || {};
  const { newListings, priceDrops, isFirstSync, skippedNoSpecs } = classificarListings(analysis, freshOrigin, specsCache);
  if (skippedNoSpecs > 0) {
    console.log(`  → ${skippedNoSpecs} carro(s) de combustão saltados (specsCache não tem dados — será notificado quando o cliente integrar)`);
  }

  // 3. Notificar
  await enviarNotificacoes(analysis, freshOrigin.length, isFirstSync, newListings, priceDrops);

  // 4. Arquivar desaparecidos
  arquivarDesaparecidos(analysis.knownListings, freshOrigin);

  // 5. Limpar histórico antigo
  analysis.knownListings = limparHistoricoAntigo(analysis.knownListings);

  // 6. Registar entry no histórico de syncs (para card UI)
  // Mantém apenas últimos 7 dias para evitar bloat. Limpeza no momento da escrita —
  // mais simples que job separado e suficiente garantia.
  if (!analysis.syncHistory) analysis.syncHistory = [];
  analysis.syncHistory.push({
    ts: new Date().toISOString(),
    novos: newListings.length,
    descidas: priceDrops.length,
    isFirst: isFirstSync,
  });
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  analysis.syncHistory = analysis.syncHistory.filter(e => new Date(e.ts).getTime() > cutoff);

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
  // Hot-fix 0.2.3: a função notify() faz o seu próprio loadData/saveData para gravar
  // o histórico de notificações. Como o nosso `data` em memória aqui está desactualizado
  // em relação a esse campo (a notify escreveu no disco mas a nossa cópia não viu),
  // o saveData final apagava as notificações guardadas durante o loop.
  // Solução mínima: relê notifications do disco antes do save final.
  // Fix arquitectural correcto (passar `data` à notify) fica para 0.3.x.
  data.notifications = loadData().notifications || [];
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

      // Last-write-wins com timestamp para syncEnabled.
      // Bug histórico (até 2026-05-04): se o dispositivo A desligava sync e o dispositivo B
      // sincronizava do backup logo a seguir (com estado antigo), o re-push do B
      // sobrescrevia o `false` do A com `true`. Resultado: cron continuava a chamar Apify
      // mesmo com sync desligado.
      // Fix: se o cliente envia syncEnabledUpdatedAt mais antigo que o que o servidor
      // tem registado, ignoramos a mudança de syncEnabled (mas aceitamos restantes campos).
      if (idx >= 0 && cleanPayload.syncEnabled !== undefined) {
        const existing = data.analyses[idx];
        const incomingTs  = cleanPayload.syncEnabledUpdatedAt
          ? new Date(cleanPayload.syncEnabledUpdatedAt).getTime() : 0;
        const existingTs  = existing.syncEnabledUpdatedAt
          ? new Date(existing.syncEnabledUpdatedAt).getTime() : 0;
        if (existingTs > 0 && incomingTs < existingTs) {
          console.log(`POST /analyses: rejeito syncEnabled stale (${cleanPayload.id}). incoming=${incomingTs} existing=${existingTs}`);
          delete cleanPayload.syncEnabled;
          delete cleanPayload.syncEnabledUpdatedAt;
        }
      }

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
      // Devolve o estado autoritativo do servidor para o cliente reconciliar
      const finalIdx = data.analyses.findIndex(a => a.id === payload.id);
      const final = finalIdx >= 0 ? data.analyses[finalIdx] : null;
      return ok(res, {
        ok: true,
        syncEnabled: final?.syncEnabled,
        syncEnabledUpdatedAt: final?.syncEnabledUpdatedAt
      });
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
        novos.push({ id: listingId, raw: flattenRaw(v.raw), source: v.source, firstSeen: v.firstSeen, mlPct: v.mlPct });
      }
      // Alterado: priceChangedAt depois do since (e não é só "novo")
      else if (priceChangedTs > sinceTs && !v.archived && firstSeenTs <= sinceTs) {
        alterados.push({
          id: listingId, raw: flattenRaw(v.raw), source: v.source,
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

  // GET /analyses/:id/sync-history
  // Devolve histórico de syncs dos últimos 7 dias para o card UI da plataforma.
  // O servidor regista cada entry no fim de syncAnalysis e limpa entries > 7 dias.
  if (req.method === 'GET' && /^\/analyses\/[^/]+\/sync-history$/.test(u.pathname)) {
    const id = u.pathname.split('/')[2];
    const data = loadData();
    const a = (data.analyses || []).find(x => String(x.id) === String(id));
    if (!a) return err(res, 'analysis not found', 404);
    return ok(res, {
      analysisId: a.id,
      history: a.syncHistory || [],
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

  // POST /analyses/:id/ingest
  // Body: { raws: [{...rawApify, _src: 'as24'|'mde'}, ...] }
  // Funciona como sync mas usa raws fornecidos pelo cliente em vez de chamar Apify.
  // Útil para testes end-to-end, re-sincronização a partir de CSVs locais, e
  // evita custos do scrape quando já temos os dados.
  if (req.method === 'POST' && /^\/analyses\/[^/]+\/ingest$/.test(u.pathname)) {
    try {
      const id = u.pathname.split('/')[2];
      const body = await readBody(req);
      const raws = Array.isArray(body?.raws) ? body.raws : null;
      if (!raws) return err(res, 'raws array required in body', 400);

      const data = loadData();
      const analysis = (data.analyses || []).find(x => String(x.id) === String(id));
      if (!analysis) return err(res, 'analysis not found', 404);

      // Garantir que cada raw tem _src (default 'as24' se ausente — defensivo)
      const freshOrigin = raws.map(r => ({ ...r, _src: r._src || 'as24' }));

      // Responde imediatamente, processa em background (igual a POST /sync)
      ok(res, { ok: true, message: `Ingest iniciado: ${freshOrigin.length} raws` });
      syncAnalysis(analysis, freshOrigin)
        .then(() => {
          saveData(data);
          console.log(`[INGEST] ${analysis.name}: concluído, ${Object.keys(analysis.knownListings || {}).length} known listings`);
        })
        .catch(e => console.error(`[INGEST] ${analysis.name} falhou:`, e));
      return;
    } catch (e) { return err(res, e.message); }
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
      // readBody já faz JSON.parse — body é o array directamente
      // Bug histórico (até 2026-05-04-7): havia um JSON.parse redundante aqui que
      // explodia em todos os requests, devolvendo 400 Bad Request silenciosamente.
      // Resultado: cache de specs nunca era enviado ao servidor → cada cliente acabava
      // por re-pagar IA das mesmas chaves em vez de partilhar com outros utilizadores.
      const entries = await readBody(req);
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

  // POST /co2-suggest — sugere CO2 para a extensão autoimport.app.
  // Body: { marca, modelo, submodelo, ano, combustivel, potencia, cilindrada, norma_euro }
  // 1) Cache-first (mesmo matching da B2B → consistência total, custo zero)
  // 2) Cache-miss → IA (Anthropic), 3) guarda de volta na cache partilhada.
  if (req.method === 'POST' && u.pathname === '/co2-suggest') {
    try {
      const b = await readBody(req);
      const marca = (b.marca || '').toString().trim();
      const modelo = (b.modelo || '').toString().trim();
      const ano = parseInt(b.ano) || 0;
      const fuelNorm = normFuel(b.combustivel);
      if (!marca || !modelo || !ano || !fuelNorm) {
        return err(res, 'marca, modelo, ano e combustivel são obrigatórios');
      }

      // Para PHEV/híbrido/elétrico a autonomia é necessária (entra no ISV).
      const precisaAutonomia = ['phev', 'híbrido', 'elétrico'].includes(fuelNorm);

      // 1) Cache-first — reutiliza lookupSpecsForRaw (igual à plataforma B2B)
      const specsCache = (loadData().specsCache) || {};
      const pseudoRaw = { make: marca, model: modelo, fuel: fuelNorm, year: ano, engineSize: b.cilindrada || 0, __transmissaoNorm: normTransm(b.transmissao) };
      const hit = lookupSpecsForRaw(pseudoRaw, specsCache);
      // Só usar a cache se tiver o necessário: CO2 sempre; autonomia quando o
      // carro precisa dela. Se faltar autonomia num PHEV, cai para a IA.
      if (hit && hit.co2 && (!precisaAutonomia || (hit.autonomia && hit.autonomia > 0))) {
        return ok(res, {
          co2: hit.co2, norma: hit.norma, autonomia: hit.autonomia || 0,
          confianca: 'cache', fonte: 'cache', matchCount: hit.matchCount
        });
      }

      // 2) Cache-miss → Brave (ancorar) + IA
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) return err(res, 'ANTHROPIC_API_KEY não configurada no servidor', 500);

      const desc = [marca, modelo, b.submodelo, ano, fuelNorm,
        b.potencia ? ('potência ' + b.potencia) : '',
        b.cilindrada ? (b.cilindrada + ' cm3') : '',
        b.transmissao ? ('caixa ' + b.transmissao) : '',
        b.norma_euro ? ('norma ' + b.norma_euro) : ''
      ].filter(Boolean).join(' ');

      // 2a) Pesquisa Brave — OBRIGATÓRIA para ancorar. Sem Brave a IA NÃO
      //     adivinha. Cada query insiste até 3 tentativas (soluços temporários).
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      let contextoWeb = '';
      const braveKey = process.env.BRAVE_API_KEY;
      const trechos = [];

      // Fuel em inglês para queries de sites internacionais (carfolio,
      // automobile-catalog, evdatabase usam "diesel"/"petrol", não "gasóleo").
      // PHEV/híbrido/elétrico ficam iguais (são palavras comuns em todas línguas).
      const fuelEN = fuelNorm === 'gasóleo' ? 'diesel'
                   : fuelNorm === 'gasolina' ? 'petrol'
                   : fuelNorm;
      // Protocolo provável conforme regra UE (WLTP obrigatório desde 09/2018).
      // Carros 2018 ficam ambíguos: query genérica em vez de forçar protocolo.
      const protocoloProvavel = ano >= 2019 ? 'WLTP' : (ano <= 2017 ? 'NEDC' : '');

      if (braveKey) {
        const queries = [
          desc + ' CO2 emissions g/km',
          marca + ' ' + modelo + ' ' + (b.submodelo || '') + ' ' + ano + ' ' + fuelEN + ' CO2 specifications',
          protocoloProvavel
            ? marca + ' ' + modelo + ' ' + ano + ' ' + fuelEN + ' ' + protocoloProvavel + ' CO2'
            : marca + ' ' + modelo + ' ' + ano + ' ' + fuelEN + ' technical data CO2'
        ];
        // Para PHEV o CO2 "ponderado" é diferente do CO2 a gasolina puro;
        // query específica encontra trechos com weighted/combined.
        if (fuelNorm === 'phev') {
          queries.push(marca + ' ' + modelo + ' ' + ano + ' plug-in hybrid weighted CO2 electric range km');
        }
        for (const q of queries) {
          for (let tentativa = 1; tentativa <= 3; tentativa++) {
            try {
              const bUrl = 'https://api.search.brave.com/res/v1/web/search?q=' + encodeURIComponent(q) + '&count=3';
              const bResp = await fetch(bUrl, { headers: { 'Accept': 'application/json', 'X-Subscription-Token': braveKey } });
              if (!bResp.ok) {
                if (tentativa < 3) { await sleep(tentativa * 500); continue; }
                break;
              }
              const bData = await bResp.json();
              const results = (bData && bData.web && bData.web.results) || [];
              results.forEach(r => {
                const t = ((r.title || '') + ' — ' + (r.description || '')).replace(/\s+/g, ' ').trim();
                if (t) trechos.push(t.slice(0, 300));
              });
              break; // query bem-sucedida → próxima query
            } catch (e) {
              if (tentativa < 3) { await sleep(tentativa * 500); continue; }
            }
          }
        }
      }

      // Sem chave Brave OU sem qualquer resultado → NÃO chamar a IA.
      // Devolve "sem-info": a extensão fica só com o preenchimento manual.
      if (!trechos.length) {
        return ok(res, {
          co2: 0, autonomia: 0, fonte: 'sem-info',
          nota: 'Sem informação web suficiente — preenche à mão (valor do COC).'
        });
      }
      contextoWeb = '\n\nResultados de pesquisa web (ÚNICA fonte permitida):\n- '
        + trechos.slice(0, 12).join('\n- ');
      console.log('[co2-suggest]', marca, modelo, ano, fuelNorm,
                  b.pais_vendedor ? '('+b.pais_vendedor+')' : '',
                  '→ trechos:', trechos.length);

      // Mercado: ajuda a desambiguar versões nacionais (ex.: BMW 218 versão
      // IT vs DE pode ter CO2 ligeiramente diferente). Vazio se não enviado.
      const mercado = b.pais_vendedor ? (' (mercado ' + b.pais_vendedor + ')') : '';

      const prompt = 'És um especialista em homologação automóvel europeia. '
        + 'Indica o valor de emissões de CO2 (g/km) de homologação mais provável para este veículo'
        + (precisaAutonomia
            ? ', e a autonomia elétrica oficial em modo elétrico (km). '
            : '. ')
        + 'Veículo: ' + desc + mercado + '.'
        + contextoWeb
        + ' Baseia-te EXCLUSIVAMENTE nos resultados de pesquisa acima. '
        + 'NÃO uses conhecimento geral nem adivinhes: se os resultados não permitirem uma estimativa fiável, devolve 0 e confianca "baixa". '
        + 'Norma de homologação: carros matriculados em 2019 ou mais recente são WLTP; em 2017 ou anterior são NEDC; 2018 é zona de transição (escolhe conforme indicado nos resultados). '
        + 'Responde APENAS com JSON, sem texto antes nem depois, no formato exacto: '
        + '{"co2": <número g/km>, "autonomia": <autonomia elétrica em km, ou 0 se não aplicável/desconhecida>, "norma": "WLTP" ou "NEDC", "confianca": "alta" ou "média" ou "baixa", "nota": "<frase curta>"}.';

      // Chamada à IA com retry: até 3 tentativas em erros temporários
      // (429/500/502/503/529 ou exceção de rede). Erros de chave/pedido não repetem.
      const transitorio = s => [429, 500, 502, 503, 529].includes(s);
      let aiData = null;
      for (let tentativa = 1; tentativa <= 3; tentativa++) {
        try {
          const aiResp = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': apiKey,
              'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
              model: CO2_MODEL,
              max_tokens: 300,
              messages: [{ role: 'user', content: prompt }]
            })
          });
          if (aiResp.ok) { aiData = await aiResp.json(); break; }
          const t = await aiResp.text();
          if (transitorio(aiResp.status) && tentativa < 3) { await sleep(tentativa * 700); continue; }
          return err(res, 'IA ' + aiResp.status + ': ' + t.slice(0, 200), 502);
        } catch (e) {
          if (tentativa < 3) { await sleep(tentativa * 700); continue; }
          return err(res, 'IA inacessível: ' + e.message, 502);
        }
      }
      if (!aiData) return err(res, 'IA sem resposta', 502);

      let txt = '';
      if (Array.isArray(aiData.content)) {
        txt = aiData.content.filter(c => c.type === 'text').map(c => c.text).join('');
      }
      let parsed;
      try {
        const m = txt.match(/\{[\s\S]*\}/);
        parsed = JSON.parse(m ? m[0] : txt);
      } catch (e) {
        return err(res, 'Resposta da IA ilegível', 502);
      }
      const co2 = parseInt(parsed.co2) || 0;
      const autonomia = parseInt(parsed.autonomia) || 0;
      const norma = (parsed.norma === 'NEDC') ? 'NEDC' : 'WLTP';
      const confianca = ['alta', 'média', 'baixa'].includes(parsed.confianca) ? parsed.confianca : 'baixa';
      const nota = (parsed.nota || '').toString().slice(0, 200);

      // 3) Guardar de volta na cache partilhada (grátis na próxima; ajuda a B2B).
      //    Chave no mesmo formato do cliente B2B: marca|modelo|subFirst|ano|fuel|pot
      //    O campo "autonomia" é aditivo — a B2B ignora campos que não conhece.
      if (co2 > 0 || autonomia > 0) {
        const subFirst = ((b.submodelo || '').toString().trim().split(/\s+/)[0] || '').toLowerCase();
        const potBucket = b.potencia ? String(Math.round((parseInt(b.potencia) || 0) / 10) * 10) : '0';
        const transmNorm = normTransm(b.transmissao);
        const key = [marca.toLowerCase(), modelo.toLowerCase(), subFirst, ano, fuelNorm, potBucket, transmNorm].join('|');
        const data = loadData();
        if (!data.specsCache) data.specsCache = {};
        data.specsCache[key] = {
          co2: co2,
          cilindrada: parseInt(b.cilindrada) || 0,
          co2_norma: norma,
          co2_conf: confianca,
          autonomia: autonomia,
          ts: Date.now()
        };
        const keys = Object.keys(data.specsCache);
        if (keys.length > 1000) {
          const sorted = keys.sort((a, b2) => (data.specsCache[a].ts || 0) - (data.specsCache[b2].ts || 0));
          sorted.slice(0, keys.length - 1000).forEach(k => delete data.specsCache[k]);
        }
        saveData(data);
      }

      return ok(res, { co2: co2, norma: norma, autonomia: autonomia, confianca: confianca, nota: nota, fonte: 'ia' });
    } catch (e) {
      return err(res, e.message, 500);
    }
  }

  err(res, 'Not found', 404);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`AutoImport server running on port ${PORT}`));
// Sync às 12h e 17h30 — hora de Lisboa (PT). Sem `timezone` explícita,
// node-cron usa o TZ do processo, que no Railway é UTC → no horário de verão
// (CEST, UTC+1) os crons corriam 1h atrasados (08h Lisboa → 09h real).
// Bug detectado em produção 2026-04-30: análise tinha cron das 12h a disparar às 13h.
// Reduzido de 4× para 2×/dia em 2026-05-04 — menos custo Apify, mantém recovery diário.
const syncTimes = ['0 12 * * *', '30 17 * * *'];
syncTimes.forEach(expr => {
  cron.schedule(expr, () => {
    console.log(`⏰ Sync scheduled: ${expr}`);
    syncAll().catch(console.error);
  }, { timezone: 'Europe/Lisbon' });
});
console.log('✅ Cron: 12h, 17h30 (Europe/Lisbon) — todos os dias');

// Boot sync removido em 2026-05-04: cada deploy/restart não dispara mais Apify.
// Se o servidor cair entre crons, o próximo cron agendado encarrega-se.
// Histórico: até 2026-05-04-9 havia debounce de 6h; antes disso corria sempre no boot.
