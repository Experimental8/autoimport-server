const cron  = require('node-cron');
const fetch = require('node-fetch');
const fs    = require('fs');
const http  = require('http');
const crypto = require('crypto');  // verificação da assinatura do webhook Lemon

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
const APP_VERSION = '2026-05-23-1';
const APP_BUILT_AT = new Date().toISOString();

// Modelo de IA usado pelo endpoint /co2-suggest (extensão autoimport.app).
// Sonnet 4.6 — atual e ativo (o claude-sonnet-4-20250514 foi reformado pela
// Anthropic em 2026-04-20, daí dar 404). Se a B2B usar outro, mudar só esta linha.
const CO2_MODEL = 'claude-sonnet-4-6';

// Sync SV: refrescar referência PT a cada 2 dias (em ms)
const SV_SYNC_INTERVAL_MS = 2 * 24 * 60 * 60 * 1000;

// ── Persistence ───────────────────────────────────────────────────────────
function loadData() {
  if (!fs.existsSync(DATA_FILE)) return { analyses: [], notifications: [], sv_analyses: {}, subscriptions: {} };
  try {
    const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    // Migração suave: ficheiros antigos não têm sv_analyses
    if (!d.sv_analyses) d.sv_analyses = {};
    // Migração suave: ficheiros antigos não têm subscriptions (campos do trial,
    // guardados pelo webhook por chave de licença — ver /lemon/webhook)
    if (!d.subscriptions) d.subscriptions = {};
    return d;
  }
  catch { return { analyses: [], notifications: [], sv_analyses: {}, subscriptions: {} }; }
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

  // Potência pedida (bucket de 10): SÓ definida pelo /co2-suggest
  // (raw.__potBucket). Distingue variantes do MESMO modelo/geração — ex.:
  // Porsche 991 GT3 RS (~500cv) vs 991 Carrera (~370cv), que de outra forma
  // a cache juntava por terem marca|modelo|ano|combustível iguais. A B2B
  // nunca passa __potBucket → pq='' → comportamento igual ao anterior.
  const pq = (raw && raw.__potBucket != null) ? String(raw.__potBucket) : '';

  // Chave do cliente: marca|modelo|subFirst|ano|combustivel|pot[|transm]
  // Servidor procura com prefixo: marca|modelo|*|ano|combustivel|*
  // (subFirst e pot variam, vamos fazer match parcial)
  const todos = [];
  for (const [key, val] of Object.entries(specsCache)) {
    const parts = key.split('|');
    if (parts.length < 5) continue;
    if (parts[0] === make && parts[1] === model && parseInt(parts[3]) === year && parts[4] === fuel) {
      if (val && val.co2) todos.push({ v: val, tr: parts[6] || '', pot: parts[5] || '0' });
    }
  }
  if (!todos.length) return null;

  let pool = todos;

  // Filtro por potência (só quando o cliente a envia — extensão). Se NÃO
  // houver entrada da mesma potência, devolve null (cache-miss) → vai à IA
  // buscar o valor certo, em vez de devolver a média de outra variante.
  // (Não cai na média: era isso que dava o CO2 do Carrera a um GT3 RS.)
  if (pq) {
    const mesmaPot = pool.filter(m => m.pot === pq);
    if (!mesmaPot.length) return null;
    pool = mesmaPot;
  }

  // Se sabemos a transmissão e há entradas dessa transmissão → usar SÓ essas
  // (PDK ≠ manual). Senão, cair na média de todas (comportamento antigo).
  if (tq) {
    const mesmaTr = pool.filter(m => m.tr === tq);
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

// Tokeniza uma string em Set de tokens normalizados (lowercase, sem acentos,
// só alfanuméricos, length >= 2, sem stopwords PT + automotive + technical).
// Usado pelo endpoint /sv-analyses/lookup para fazer match fuzzy entre
// marca/modelo/submodelo (do MB.de/AS24) e search_key/search_label das
// análises SV armazenadas.
const TOKEN_STOPWORDS = new Set([
  // Stopwords PT comuns
  'a', 'o', 'de', 'da', 'do', 'em', 'na', 'no', 'com', 'sem', 'para',
  // SV URL conventions
  'carros', 'q', 'todos', 'anuncio',
  // SV query params (filter_enum_make=porsche dá ruído se tokenizado)
  'search', 'filter', 'enum', 'float', 'from', 'to',
  'make', 'model', 'year', 'price', 'mileage', 'km',
  // Combustível (varia entre sites — ignorar no match)
  'gasolina', 'diesel', 'gasoleo', 'hibrido', 'plug', 'in',
  'phev', 'bev', 'ev', 'hev', 'mhev', 'eletrico', 'electrico', 'electric',
  // Transmissão (varia entre sites — ignorar no match)
  'auto', 'manual', 'automatica', 'automatic', 'caixa', 'transmissao',
  // Categorias estruturais do fabricante usadas em URLs do SV mas que
  // raramente aparecem nos campos marca/modelo do MB.de/AS24:
  //   Porsche /carros/porsche/911/...   ← 911 é modelo, sem categoria
  //   BMW    /carros/bmw/serie-3/320d   ← "serie-3" é categoria, 320d é modelo
  //   Merc.  /carros/mercedes-benz/classe-c/c-220 ← "classe-c" é categoria
  // Sem estes stopwords, BMW/Mercedes ficariam abaixo do threshold de 80%.
  'serie', 'series', 'classe', 'class'
]);
function tokenizar(s) {
  if (!s || typeof s !== 'string') return new Set();
  return new Set(
    s.toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')  // remover acentos
      .split(/[^a-z0-9]+/)
      // length >= 1 (não >= 2): mantém tokens de 1 caráter como o "2" de
      // "Atto 2" / "3" de "Atto 3" / "2" de "Mazda 2". Sem isto, modelos
      // distinguidos por um único dígito ficavam indistinguíveis e o lookup
      // devolvia o modelo errado (ex.: Atto 2 → dados do Atto 3). O >= 1
      // ainda descarta as strings vazias que o split produz nas pontas.
      .filter(t => t.length >= 1 && !TOKEN_STOPWORDS.has(t))
  );
}

// ── Lemon Squeezy — licenças (extensão Carscore) ──────────────────────────
// A "License API" da Lemon é SEPARADA da API normal e NÃO precisa de chave
// secreta: basta a própria license_key. Pede-se Accept: application/json e
// envia-se o corpo como application/x-www-form-urlencoded.
// Segurança: confirmar que store_id/product_id da resposta batem com os
// NOSSOS — senão qualquer chave Lemon de outra loja desbloquearia a extensão.
//
// ⚠️ COLE AQUI os números da sua loja/produto quando criar o produto na Lemon
//    (ou defina LEMON_STORE_ID / LEMON_PRODUCT_ID como variáveis no Railway).
//    Enquanto forem null, os endpoints respondem 503 de propósito — para nunca
//    validar contra "qualquer loja".
const LEMON_STORE_ID   = process.env.LEMON_STORE_ID   || null; // ex.: "123456"
const LEMON_PRODUCT_ID = process.env.LEMON_PRODUCT_ID || null; // ex.: "987654"
const LEMON_LICENSE_BASE = 'https://api.lemonsqueezy.com/v1/licenses';

// Para o webhook que acerta o nº de lugares (activation_limit = quantity):
//  - LEMON_API_KEY: chave Bearer da API principal (Settings → API), para LER e
//    ESCREVER nas license keys. (A License API dos /license/* NÃO precisa dela;
//    esta é só para o webhook.)
//  - LEMON_WEBHOOK_SECRET: o "Signing secret" que se define ao criar o webhook,
//    para confirmar que o pedido vem mesmo da Lemon. Sem ele, recusamos.
const LEMON_API_KEY        = process.env.LEMON_API_KEY        || null;
const LEMON_WEBHOOK_SECRET = process.env.LEMON_WEBHOOK_SECRET || null;
const LEMON_API_BASE       = 'https://api.lemonsqueezy.com/v1';

function lemonConfigOk() {
  return LEMON_STORE_ID != null && LEMON_PRODUCT_ID != null;
}

// Confirma que a resposta da Lemon pertence à NOSSA loja/produto.
function lemonPertenceAMim(meta) {
  if (!meta) return false;
  return String(meta.store_id)   === String(LEMON_STORE_ID)
      && String(meta.product_id) === String(LEMON_PRODUCT_ID);
}

async function lemonLicenseCall(action, params) {
  // action: 'activate' | 'validate' | 'deactivate'
  const resp = await fetch(`${LEMON_LICENSE_BASE}/${action}`, {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(params).toString(),
  });
  let json = null;
  try { json = await resp.json(); } catch (e) { json = null; }
  return { httpStatus: resp.status, json };
}

// Chamada à API PRINCIPAL da Lemon (a que precisa de Bearer) — usada pelo webhook
// para listar a chave de uma encomenda e para lhe acertar o activation_limit.
async function lemonApiCall(method, apiPath, bodyObj) {
  const headers = {
    'Accept': 'application/vnd.api+json',
    'Authorization': `Bearer ${LEMON_API_KEY}`,
  };
  const opts = { method, headers };
  if (bodyObj) {
    headers['Content-Type'] = 'application/vnd.api+json';
    opts.body = JSON.stringify(bodyObj);
  }
  const resp = await fetch(`${LEMON_API_BASE}${apiPath}`, opts);
  let json = null;
  try { json = await resp.json(); } catch (e) { json = null; }
  return { httpStatus: resp.status, json };
}

// Confirma que o webhook vem mesmo da Lemon: HMAC-SHA256 do corpo CRU com o
// nosso segredo, comparado em tempo constante com o cabeçalho X-Signature.
function lemonWebhookValido(rawBody, signature) {
  if (!LEMON_WEBHOOK_SECRET || !signature) return false;
  const digest = crypto.createHmac('sha256', LEMON_WEBHOOK_SECRET)
                       .update(rawBody, 'utf8').digest('hex');
  const a = Buffer.from(digest, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Lê o corpo CRU do pedido (sem fazer JSON.parse) — preciso para a assinatura,
// porque o HMAC tem de bater com os bytes exatos que a Lemon enviou.
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

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

  // POST /bug-report { assunto, corpo } — relatório de bug da extensão Carscore.
  // O popup (modal de bug, desde v0.25.0) monta o assunto e o corpo em texto
  // simples e envia-os aqui; este endpoint reencaminha-os por email para
  // geral@carscore.pt via Resend. A UI do popup trata 200 como "enviado"; em
  // qualquer outro código de erro recorre ao plano B (copiar para a área de
  // transferência). Por isso devolvemos 200 só quando o email saiu mesmo.
  if (req.method === 'POST' && u.pathname === '/bug-report') {
    try {
      const body = await readBody(req);
      const assunto = (body.assunto || '').trim();
      const corpo   = (body.corpo   || '').trim();
      if (!assunto || !corpo) return err(res, 'assunto e corpo obrigatórios');

      const resendKey = process.env.RESEND_API_KEY;
      if (!resendKey) return err(res, 'RESEND_API_KEY não configurada no servidor', 500);

      // O remetente tem de pertencer a um domínio verificado no Resend (DKIM/SPF
      // configurados em carscore.pt). Ambos configuráveis por env para não ter
      // de mexer no código se o endereço mudar.
      const from = process.env.BUG_REPORT_FROM || 'Carscore <bug@carscore.pt>';
      const to   = process.env.BUG_REPORT_TO   || 'geral@carscore.pt';

      const resp = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + resendKey,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ from, to, subject: assunto, text: corpo })
      });
      if (!resp.ok) {
        const detalhe = await resp.text().catch(() => '');
        return err(res, 'Resend ' + resp.status + ': ' + detalhe, 502);
      }
      return ok(res, { sent: true });
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
      // Potência em bucket de 10 (mesmo cálculo da escrita, mais abaixo). Só a
      // passamos quando é conhecida — assim a cache distingue variantes pela
      // potência (GT3 RS vs Carrera). Sem potência → null → comportamento antigo.
      const potParaCache = parseInt(b.potencia) || 0;
      const pseudoRaw = { make: marca, model: modelo, fuel: fuelNorm, year: ano, engineSize: b.cilindrada || 0, __transmissaoNorm: normTransm(b.transmissao), __potBucket: potParaCache > 0 ? String(Math.round(potParaCache / 10) * 10) : null };
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

      // Submodelo limpo: tira pontuação/parênteses e palavras de stand que não
      // definem a versão (LIFT, PCCB, PCM, PTS, navi...). Sem isto, anúncios
      // como "Porsche 991 -1 (911) GT3 RS PTS,Lift,PCM" afogavam o "GT3 RS" e
      // a pesquisa caía num 911 genérico (≈ Carrera, ~207 g/km) em vez do GT3 RS
      // (~296). A lista é curta de propósito — cobre o comum, é fácil de alargar.
      const SUB_JUNK = new Set([
        'lift', 'pccb', 'pcm', 'pts', 'pdk', 'bose', 'burmester', 'led', 'xenon',
        'matrix', 'navi', 'navigation', 'chrono', 'sportchrono', 'approved',
        'approvedfahig', 'garantie', 'garantia', 'scheckheft', 'voll',
        'vollausstattung', 'paket', 'packet', 'package', 'kamera', 'camera',
        'leder', 'klima', 'memory', 'keyless', 'hud', 'acc'
      ]);
      const limparSubmodelo = (sub) => {
        return (sub || '').toString()
          .replace(/[(),/\\.;:]+/g, ' ')                 // pontuação → espaço
          .split(/\s+/)
          .filter(tok => {
            if (!tok) return false;
            const t = tok.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
            if (SUB_JUNK.has(t)) return false;            // palavra de stand
            if (/^-?\d$/.test(tok)) return false;         // dígito solto ("-1")
            return true;
          })
          .slice(0, 4)                                    // não deixar a query enorme
          .join(' ');
      };
      const subLimpo = limparSubmodelo(b.submodelo);

      // Descritor limpo só em inglês para os sites de specs. O 'desc' acima
      // tem ruído PT (gasóleo, potência, caixa, norma) que, misturado com
      // inglês, fazia a 1ª query vir sempre vazia (caso BMW 320d 2025).
      const descEN = [marca, modelo, subLimpo, ano, fuelEN].filter(Boolean).join(' ');

      // Caixa em inglês para entrar em ALGUMAS queries (auto vs manual pode dar
      // CO2 de homologação diferente). Não entra em todas, para não
      // sobre-especificar e voltar ao problema do 320d 2025 (queries vazias).
      const transmNorm = normTransm(b.transmissao);
      const transmEN = transmNorm === 'auto' ? 'automatic'
                     : transmNorm === 'manual' ? 'manual' : '';

      // Classificação da fonte de cada trecho (oficiais valem mais).
      //  - 'oficial' : a marca é o NOME PRINCIPAL do domínio (bmw.de, bmw.pt,
      //                www.bmw.com.br). Não basta conter "bmw": um forum-bmw.pt
      //                ou bmwblog.com NÃO são oficiais. Marcas de domínio curto
      //                (Volkswagen→vw.com) ficam em 'outra' — usadas na mesma,
      //                só sem prioridade. Preferimos falhar para 'outra' do que
      //                marcar um fórum como oficial (mais seguro).
      //  - 'tecnica' : bases técnicas reconhecidas (número exacto por versão).
      //  - 'outra'   : restantes (usadas só se as de cima não derem número).
      const TRUSTED_SPECS = new Set([
        'carfolio.com', 'automobile-catalog.com', 'ev-database.org',
        'ultimatespecs.com', 'cars-data.com', 'car-emissions.com', 'auto-data.net'
      ]);
      const marcaToken = marca.toLowerCase().normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
      // Nome principal do domínio (label antes do TLD), saltando SLD públicos
      // tipo .com.br / .co.uk, e sem hífens (mercedes-benz → mercedesbenz).
      const SLD_PUBLICOS = new Set(['com', 'co', 'org', 'net', 'gov', 'edu']);
      const dominioPrincipal = (dominio) => {
        const labels = (dominio || '').split('.').filter(Boolean);
        if (labels.length < 2) return '';
        let i = labels.length - 1;                                 // TLD
        if (i >= 2 && SLD_PUBLICOS.has(labels[i - 1])) i -= 1;     // .com.br / .co.uk
        return (labels[i - 1] || '').replace(/[^a-z0-9]/g, '');
      };
      const classificarFonte = (dominio) => {
        if ([...TRUSTED_SPECS].some(s => dominio === s || dominio.endsWith('.' + s))) return 'tecnica';
        if (marcaToken && marcaToken.length >= 3 && dominioPrincipal(dominio) === marcaToken) return 'oficial';
        return 'outra';
      };

      // Corre uma lista de queries no Brave (3 tentativas cada por soluços
      // temporários) e empilha os trechos (com domínio + tier) em `trechos`.
      // Extraído para função para poder correr 2 lotes: primeiro com ano e —
      // só se vier vazio — um mais largo sem ano (ver abaixo).
      const correrQueries = async (lista) => {
        for (const q of lista) {
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
                if (!t) return;
                let dominio = '';
                try { dominio = ((r.meta_url && r.meta_url.hostname) || new URL(r.url).hostname || '').replace(/^www\./, ''); } catch (e) {}
                trechos.push({ dominio: dominio, tier: classificarFonte(dominio), texto: t.slice(0, 300) });
              });
              break; // query bem-sucedida → próxima query
            } catch (e) {
              if (tentativa < 3) { await sleep(tentativa * 500); continue; }
            }
          }
        }
      };

      if (braveKey) {
        const cx = transmEN ? ' ' + transmEN : '';
        const sub = subLimpo ? ' ' + subLimpo : '';
        const queriesAno = [
          // 1ª fica larga (sem caixa) para garantir que há resultados.
          descEN + ' CO2 emissions g/km',
          // 2ª e 3ª levam o submodelo limpo (a versão, ex. "GT3 RS") + a caixa
          // quando conhecida. Sem o submodelo, "991" sozinho dava um 911 genérico.
          marca + ' ' + modelo + sub + ' ' + ano + ' ' + fuelEN + cx + ' CO2 specifications',
          protocoloProvavel
            ? marca + ' ' + modelo + sub + ' ' + ano + ' ' + fuelEN + cx + ' ' + protocoloProvavel + ' CO2'
            : marca + ' ' + modelo + sub + ' ' + ano + ' ' + fuelEN + cx + ' technical data CO2'
        ];
        // Para PHEV o CO2 "ponderado" é diferente do CO2 a gasolina puro;
        // query específica encontra trechos com weighted/combined.
        if (fuelNorm === 'phev') {
          queriesAno.push(marca + ' ' + modelo + ' ' + ano + ' plug-in hybrid weighted CO2 electric range km');
        }
        await correrQueries(queriesAno);

        // Recurso para carros muito recentes (ex.: BMW 320d 2025): os sites de
        // specs indexam por geração, não pelo ano à risca, e forçar o ano em
        // todas as queries devolvia zero trechos. Se o lote com ano não trouxe
        // nada, tenta sem ano. A IA continua ancorada na web (não adivinha);
        // o ano segue na descrição do prompt para escolher a norma WLTP/NEDC.
        if (!trechos.length) {
          const queriesSemAno = [
            marca + ' ' + modelo + sub + ' ' + fuelEN + ' CO2 emissions g/km',
            protocoloProvavel
              ? marca + ' ' + modelo + sub + ' ' + fuelEN + ' ' + protocoloProvavel + ' CO2 emissions'
              : marca + ' ' + modelo + sub + ' ' + fuelEN + ' CO2 emissions technical data'
          ];
          await correrQueries(queriesSemAno);
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
      // Ordenar por fiabilidade da fonte. ATENÇÃO ao ano: o site da marca só
      // tem o MODELO ATUAL — para um carro antigo mostra a geração de agora
      // (ex.: porsche.com dá ~242 para o GT3 RS de hoje, mas o 991 de 2016 são
      // 296). Por isso, para carros com >= 4 anos, pomos as bases técnicas
      // (valor por ano) à frente das oficiais. Recentes: oficial primeiro.
      const anoAtual = new Date().getFullYear();
      const carroAntigo = (anoAtual - ano) >= 4;
      const ordemTier = carroAntigo
        ? { tecnica: 0, oficial: 1, outra: 2 }
        : { oficial: 0, tecnica: 1, outra: 2 };
      trechos.sort((a, b2) => (ordemTier[a.tier] - ordemTier[b2.tier]));
      const topTrechos = trechos.slice(0, 12);
      contextoWeb = '\n\nResultados de pesquisa web (ÚNICA fonte permitida, ordenados por fiabilidade da fonte):\n'
        + topTrechos.map(x => '- [' + (x.tier === 'oficial' ? 'OFICIAL ' + x.dominio
                                     : x.tier === 'tecnica' ? 'TÉCNICA ' + x.dominio
                                     : (x.dominio || 'web')) + '] ' + x.texto).join('\n');
      const nOficial = trechos.filter(x => x.tier === 'oficial').length;
      console.log('[co2-suggest]', marca, modelo, ano, fuelNorm,
                  b.pais_vendedor ? '('+b.pais_vendedor+')' : '',
                  '→ trechos:', trechos.length, '(oficiais:', nOficial + ')');

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
        + 'Os resultados estão ordenados por fiabilidade para ESTE veículo — prefere os primeiros. '
        + 'ATENÇÃO ao ano: o veículo é de ' + ano + '. As páginas oficiais da marca mostram muitas vezes o MODELO ATUAL (outra geração), com valores diferentes — NÃO uses um valor a menos que corresponda ao ano/geração deste veículo. Para carros mais antigos, as bases técnicas que indicam o ano específico são mais fiáveis do que o site atual da marca. '
        + 'NÃO uses conhecimento geral nem adivinhes: se os resultados não permitirem uma estimativa fiável para este ano, devolve 0 e confianca "baixa". '
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

      // Devolver a fonte para a extensão poder mostrar de onde veio o valor.
      // fonte_oficial = houve algum trecho do site da marca entre os usados.
      // fontes = até 3 domínios de topo (já ordenados por fiabilidade).
      const fonteOficial = topTrechos.some(x => x.tier === 'oficial');
      const fontes = topTrechos.slice(0, 3).map(x => x.dominio).filter(Boolean);
      return ok(res, { co2: co2, norma: norma, autonomia: autonomia, confianca: confianca, nota: nota, fonte: 'ia', fonte_oficial: fonteOficial, fontes: fontes });
    } catch (e) {
      return err(res, e.message, 500);
    }
  }

  // ============================================================
  // StandVirtual — pool partilhada de mercado nacional
  // ============================================================
  // Pool partilhada entre todos os utilizadores da extensão. Análises
  // identificadas pela search_key (URL canónica da pesquisa SV). Sem
  // autenticação por agora — segue o padrão dos outros endpoints.
  // Cada anúncio guarda first_seen/last_seen + status active|retired.
  // Quando uma análise é marcada concluída (chega à última página),
  // anúncios não vistos desde a última conclusão passam a "retired"
  // com retired_at registado, para preservar histórico para futuras
  // estatísticas sem influenciar a mediana actual.
  // ============================================================

  if (req.method === 'POST' && u.pathname === '/sv-analyses') {
    try {
      const body = await readBody(req);
      if (!body || !body.search_key) {
        return err(res, 'search_key é obrigatório', 400);
      }
      const data = loadData();
      const now = Date.now();
      const key = String(body.search_key);

      let analise = data.sv_analyses[key];
      if (!analise) {
        analise = {
          search_key: key,
          search_label: body.search_label || key,
          pages_visited: [],
          concluida: false,
          created_at: now,
          last_updated: now,
          last_completed: null,
          ads: {}
        };
      }

      // Actualizar label se vier (heurística do cliente pode evoluir)
      if (body.search_label) analise.search_label = String(body.search_label);

      // Merge pages_visited (union, ordenado)
      if (Array.isArray(body.pages_visited)) {
        const set = new Set(analise.pages_visited || []);
        body.pages_visited.forEach(p => {
          const n = parseInt(p, 10);
          if (n > 0) set.add(n);
        });
        analise.pages_visited = Array.from(set).sort((a, b) => a - b);
      }

      // Merge ads — dedup pelo data-id, actualizar preços, reactivar retirados
      if (body.ads && typeof body.ads === 'object') {
        for (const id of Object.keys(body.ads)) {
          const novo = body.ads[id];
          if (!novo || typeof novo !== 'object') continue;
          const existente = analise.ads[id];
          if (existente) {
            if (typeof novo.preco === 'number' && novo.preco > 0) existente.preco = novo.preco;
            if (typeof novo.km === 'number' && novo.km >= 0) existente.km = novo.km;
            if (typeof novo.ano === 'number' && novo.ano > 0) existente.ano = novo.ano;
            if (typeof novo.url === 'string' && novo.url) existente.url = novo.url;
            existente.last_seen = now;
            // Anúncio retirado que reapareceu: volta a active
            if (existente.status === 'retired') {
              existente.status = 'active';
              existente.retired_at = null;
            }
          } else {
            analise.ads[id] = {
              preco: typeof novo.preco === 'number' ? novo.preco : 0,
              km: typeof novo.km === 'number' ? novo.km : 0,
              ano: typeof novo.ano === 'number' ? novo.ano : 0,
              url: typeof novo.url === 'string' ? novo.url : '',
              first_seen: now,
              last_seen: now,
              status: 'active',
              retired_at: null
            };
          }
        }
      }

      // Marcar concluída + detectar retirados
      if (body.concluida === true) {
        analise.concluida = true;
        // Só detectamos retirados a partir da 2ª conclusão. Na primeira,
        // last_completed é null — usamos esta como "baseline" sem comparar.
        // Comparamos com <= porque anúncios vistos no momento exacto da
        // última conclusão têm last_seen === last_completed.
        if (analise.last_completed) {
          const referencia = analise.last_completed;
          for (const id of Object.keys(analise.ads)) {
            const ad = analise.ads[id];
            if (ad.status === 'active' && ad.last_seen <= referencia) {
              ad.status = 'retired';
              ad.retired_at = now;
            }
          }
        }
        analise.last_completed = now;
      } else if (body.concluida === false) {
        analise.concluida = false;
      }

      analise.last_updated = now;
      data.sv_analyses[key] = analise;
      saveData(data);
      return ok(res, analise);
    } catch (e) {
      return err(res, 'POST /sv-analyses: ' + e.message, 500);
    }
  }

  // Cross-site lookup: cliente em MB.de/AS24 manda marca+modelo+submodelo
  // do anúncio actual; servidor devolve a análise SV mais relevante (se
  // houver match >= 80%) para popular automaticamente a secção "mercado PT"
  // no card de cálculo, sem o utilizador ter de afixar manualmente.
  //
  // Regras:
  //  - marca e modelo são obrigatórios (pelo menos 1 token cada)
  //  - filtra análises com < 3 anúncios activos (estatística não-fiável)
  //  - score = (tokens da análise que existem no input do cliente) / (tokens da análise)
  //    → análises mais específicas que o cliente pediu são penalizadas
  //  - threshold de 80% para devolver match
  //  - desempate: mais anúncios activos, depois mais recente
  if (req.method === 'GET' && u.pathname === '/sv-analyses/lookup') {
    try {
      const tokensMarca = tokenizar(u.searchParams.get('marca') || '');
      const tokensModelo = tokenizar(u.searchParams.get('modelo') || '');
      const tokensSub = tokenizar(u.searchParams.get('submodelo') || '');

      if (tokensMarca.size === 0 || tokensModelo.size === 0) {
        return ok(res, null);
      }

      // União de tokens do cliente (para calcular o score)
      const tokensCliente = new Set([...tokensMarca, ...tokensModelo, ...tokensSub]);

      const data = loadData();
      const candidatos = [];

      for (const k of Object.keys(data.sv_analyses || {})) {
        const a = data.sv_analyses[k];
        if (!a) continue;

        // Contar anúncios activos (status === 'active' ou sem status)
        const ads = a.ads || {};
        let nActive = 0;
        for (const id of Object.keys(ads)) {
          if (!ads[id].status || ads[id].status === 'active') nActive++;
        }
        if (nActive < 3) continue;

        // Tokens da análise. Usamos só o CAMINHO do search_key (corta tudo
        // a partir do '?'): a query string do SV traz filtros como
        // ?search[filter_enum_fuel_type]=...&advanced_search_expanded=true
        // cujas palavras (fuel, type, advanced, expanded, true) o MB.de/AS24
        // nunca tem e afundavam o score abaixo dos 80% (ex.: Atto 2 dava 33%).
        // O caminho (/carros/marca/modelo) já tem marca+modelo, que é o que
        // interessa para o match.
        const searchKeyPath = (a.search_key || '').split('?')[0];
        // Remover segmentos estruturais de categoria (serie-3, classe-c,
        // série 3...) ANTES de tokenizar. Sem isto, o dígito/letra da
        // categoria (o "3" de "Série 3") fica como token solto que o
        // MB.de/AS24 não tem (lá o modelo vem como "330d", sem a série) e
        // afunda o score. O stopword 'serie'/'classe' só apanhava a palavra,
        // não o número/letra colado a seguir. NÃO afecta o "2" de "atto-2"
        // porque "atto" não é categoria.
        const textoMatch = (searchKeyPath + ' ' + (a.search_label || ''))
          .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
          .replace(/\b(classe|class|series|serie)[\s\-]?[a-z0-9]{1,2}\b/gi, ' ');
        const tokensAnalise = tokenizar(textoMatch);
        if (tokensAnalise.size === 0) continue;

        // Marca obrigatória: pelo menos um token da marca tem de existir
        let temMarca = false;
        for (const t of tokensMarca) {
          if (tokensAnalise.has(t)) { temMarca = true; break; }
        }
        if (!temMarca) continue;

        // Modelo obrigatório: pelo menos um token do modelo tem de existir
        let temModelo = false;
        for (const t of tokensModelo) {
          if (tokensAnalise.has(t)) { temModelo = true; break; }
        }
        if (!temModelo) continue;

        // Score = % de tokens da análise que estão no cliente
        // (penaliza análises mais específicas do que o que o cliente pediu)
        let matches = 0;
        for (const t of tokensAnalise) {
          if (tokensCliente.has(t)) matches++;
        }
        const score = matches / tokensAnalise.size;

        if (score >= 0.8) {
          // matches = nº de tokens da análise presentes no carro. Serve de
          // medida de ESPECIFICIDADE: a análise "991 · GT3 RS" cobre 4 tokens
          // (porsche, 991, gt3, rs); a genérica "991" cobre 2. Usado abaixo
          // para desempatar a favor da mais específica.
          candidatos.push({ analise: a, score: score, matches: matches, nActive: nActive });
        }
      }

      if (candidatos.length === 0) return ok(res, null);

      // Ordenar: PRIMEIRO a mais específica (cobre mais tokens do carro) —
      // senão uma pesquisa genérica "991" (mais anúncios) ganhava sempre à
      // específica "991 · GT3 RS" e dava a mediana de todas as versões. Depois
      // maior score, mais activos, mais recente.
      candidatos.sort((x, y) => {
        if (y.matches !== x.matches) return y.matches - x.matches;
        if (y.score !== x.score) return y.score - x.score;
        if (y.nActive !== x.nActive) return y.nActive - x.nActive;
        return (y.analise.last_updated || 0) - (x.analise.last_updated || 0);
      });

      return ok(res, candidatos[0].analise);
    } catch (e) {
      return err(res, 'GET /sv-analyses/lookup: ' + e.message, 500);
    }
  }

  if (req.method === 'GET' && u.pathname === '/sv-analyses') {
    try {
      const data = loadData();
      const searchKey = u.searchParams.get('search_key');
      if (searchKey) {
        // Detalhe de uma análise
        const a = data.sv_analyses[searchKey];
        if (!a) return ok(res, null);
        return ok(res, a);
      }
      // Lista — só metadados (sem ads, para ser leve)
      const lista = Object.values(data.sv_analyses).map(a => {
        const ads = a.ads || {};
        const ids = Object.keys(ads);
        let active = 0, retired = 0;
        for (let i = 0; i < ids.length; i++) {
          if (ads[ids[i]].status === 'retired') retired++;
          else active++;
        }
        return {
          search_key: a.search_key,
          search_label: a.search_label,
          pages_visited: a.pages_visited,
          concluida: a.concluida,
          ad_count: ids.length,
          ad_count_active: active,
          ad_count_retired: retired,
          created_at: a.created_at,
          last_updated: a.last_updated,
          last_completed: a.last_completed
        };
      });
      // Ordenar por mais recente primeiro
      lista.sort((x, y) => (y.last_updated || 0) - (x.last_updated || 0));
      return ok(res, lista);
    } catch (e) {
      return err(res, 'GET /sv-analyses: ' + e.message, 500);
    }
  }

  // ── Licenças (extensão Carscore) ─────────────────────────────────────────
  // Ativar a chave neste dispositivo.
  if (req.method === 'POST' && u.pathname === '/license/activate') {
    try {
      if (!lemonConfigOk()) return err(res, 'Licenciamento ainda não configurado no servidor', 503);
      const b = await readBody(req);
      const licenseKey   = (b.license_key   || '').toString().trim();
      const instanceName = (b.instance_name || 'Carscore').toString().trim().slice(0, 80);
      if (!licenseKey) return err(res, 'license_key obrigatória');

      const r = await lemonLicenseCall('activate', { license_key: licenseKey, instance_name: instanceName });
      if (!r.json) return err(res, 'Resposta inválida da Lemon Squeezy', 502);

      // Chave inválida / limite de ativações atingido → activated:false + error.
      if (!r.json.activated) {
        return ok(res, { ok: false, error: r.json.error || 'Não foi possível ativar a chave.' });
      }
      // É mesmo da nossa loja/produto?
      if (!lemonPertenceAMim(r.json.meta)) {
        return ok(res, { ok: false, error: 'Esta chave não pertence ao Carscore.' });
      }
      const lk = r.json.license_key || {};
      const inst = r.json.instance || {};
      return ok(res, {
        ok: true,
        instance_id: inst.id || null,
        status: lk.status || 'active',      // active | expired | disabled
        expires_at: lk.expires_at || null,  // null = renova com a subscrição
      });
    } catch (e) {
      return err(res, 'POST /license/activate: ' + e.message, 502);
    }
  }

  // Verificar se a chave/instância continua válida.
  if (req.method === 'POST' && u.pathname === '/license/validate') {
    try {
      if (!lemonConfigOk()) return err(res, 'Licenciamento ainda não configurado no servidor', 503);
      const b = await readBody(req);
      const licenseKey = (b.license_key || '').toString().trim();
      const instanceId = (b.instance_id || '').toString().trim();
      if (!licenseKey) return err(res, 'license_key obrigatória');

      const params = { license_key: licenseKey };
      if (instanceId) params.instance_id = instanceId;
      const r = await lemonLicenseCall('validate', params);
      if (!r.json) return err(res, 'Resposta inválida da Lemon Squeezy', 502);

      // Sem meta = chave desconhecida/inválida.
      if (!r.json.meta) {
        return ok(res, { ok: true, valid: false, status: null, expires_at: null });
      }
      if (!lemonPertenceAMim(r.json.meta)) {
        return ok(res, { ok: false, valid: false, error: 'Esta chave não pertence ao Carscore.' });
      }
      const lk = r.json.license_key || {};
      // Juntar os campos da subscrição que o webhook guardou (trial, estado,
      // cancelamento, lugares). A extensão usa-os para a contagem do trial.
      // Aditivo: os campos antigos (valid/status/expires_at) ficam iguais.
      const sub = (loadData().subscriptions || {})[licenseKey] || null;
      return ok(res, {
        ok: true,
        valid: !!r.json.valid,
        status: lk.status || null,          // estado da CHAVE: active | expired | disabled
        expires_at: lk.expires_at || null,
        // estado da SUBSCRIÇÃO (null se ainda não chegou nenhum webhook desta chave):
        subscription: sub ? {
          status:        sub.status || null,         // on_trial | active | cancelled | expired | ...
          trial_ends_at: sub.trial_ends_at || null,
          renews_at:     sub.renews_at || null,
          ends_at:       sub.ends_at || null,
          cancelled:     !!sub.cancelled,
          quantity:      sub.quantity || null,
        } : null,
      });
    } catch (e) {
      return err(res, 'POST /license/validate: ' + e.message, 502);
    }
  }

  // Remover (desativar) a instância deste dispositivo.
  if (req.method === 'POST' && u.pathname === '/license/deactivate') {
    try {
      if (!lemonConfigOk()) return err(res, 'Licenciamento ainda não configurado no servidor', 503);
      const b = await readBody(req);
      const licenseKey = (b.license_key || '').toString().trim();
      const instanceId = (b.instance_id || '').toString().trim();
      if (!licenseKey || !instanceId) return err(res, 'license_key e instance_id obrigatórios');

      const r = await lemonLicenseCall('deactivate', { license_key: licenseKey, instance_id: instanceId });
      if (!r.json) return err(res, 'Resposta inválida da Lemon Squeezy', 502);

      return ok(res, { ok: !!r.json.deactivated, error: r.json.error || null });
    } catch (e) {
      return err(res, 'POST /license/deactivate: ' + e.message, 502);
    }
  }

  // ── Webhook Lemon — acerta o nº de lugares na chave ──────────────────────
  // A Lemon avisa-nos quando uma subscrição é criada/alterada. Lemos o nº de
  // lugares comprados (quantity) e pomos esse valor no activation_limit da
  // chave dessa encomenda — assim a própria Lemon passa a travar a partir do
  // (lugares+1)-ésimo dispositivo. Os /license/* não mudam.
  if (req.method === 'POST' && u.pathname === '/lemon/webhook') {
    // O corpo CRU tem de ser lido ANTES de qualquer parse (para a assinatura).
    let raw;
    try { raw = await readRawBody(req); } catch (e) { return err(res, 'corpo ilegível', 400); }

    // Sem segredo do webhook ou sem chave de API não há como verificar/escrever.
    if (!LEMON_WEBHOOK_SECRET || !LEMON_API_KEY) {
      return err(res, 'Webhook Lemon ainda não configurado no servidor', 503);
    }
    // Confirmar que vem mesmo da Lemon.
    const sig = (req.headers['x-signature'] || '').toString();
    if (!lemonWebhookValido(raw, sig)) return err(res, 'Assinatura inválida', 401);

    let payload;
    try { payload = JSON.parse(raw); } catch (e) { return err(res, 'JSON inválido', 400); }

    const event = (payload.meta && payload.meta.event_name)
               || (req.headers['x-event-name'] || '').toString();
    // Só nos interessam estes dois eventos. Os outros confirmam-se com 200.
    if (event !== 'subscription_created' && event !== 'subscription_updated') {
      return ok(res, { ok: true, ignored: event || 'sem-evento' });
    }

    const attrs     = (payload.data && payload.data.attributes) || {};
    const orderId   = attrs.order_id;
    const productId = attrs.product_id;
    const quantity  = attrs.first_subscription_item && attrs.first_subscription_item.quantity;

    // Só o NOSSO produto.
    if (LEMON_PRODUCT_ID != null && String(productId) !== String(LEMON_PRODUCT_ID)) {
      return ok(res, { ok: true, ignored: 'produto-diferente' });
    }
    if (!orderId || !quantity || quantity < 1) {
      console.warn('[lemon-webhook] sem order_id/quantity utilizáveis', orderId, quantity);
      return ok(res, { ok: true, ignored: 'sem-dados' });
    }

    try {
      // 1) Encontrar a(s) chave(s) desta encomenda.
      const list = await lemonApiCall('GET', `/license-keys?filter[order_id]=${encodeURIComponent(orderId)}`);
      const keys = (list.json && Array.isArray(list.json.data)) ? list.json.data : [];
      const minhas = keys.filter(k =>
        String(k.attributes && k.attributes.product_id) === String(LEMON_PRODUCT_ID));

      // A chave pode ainda não existir (corrida com a criação). Devolver 500
      // faz a Lemon repetir com backoff (5s/25s/125s) → dá tempo a nascer.
      if (minhas.length === 0) {
        console.warn('[lemon-webhook] chave ainda não encontrada p/ order', orderId, '→ retry');
        return err(res, 'chave ainda não disponível, tentar de novo', 500);
      }

      // 2) Guardar os campos da subscrição (trial, estado, cancelamento, lugares)
      //    por CHAVE DE LICENÇA — a extensão pede-os ao /license/validate para
      //    mostrar a contagem do trial. A License API da Lemon não traz estas
      //    datas; só vêm no objeto da subscrição, que é o que chega aqui.
      const data = loadData();
      for (const k of minhas) {
        const keyStr = k.attributes && k.attributes.key;
        if (!keyStr) continue;
        data.subscriptions[keyStr] = {
          status:        attrs.status || null,        // on_trial | active | cancelled | expired | past_due | paused | unpaid
          trial_ends_at: attrs.trial_ends_at || null, // fim do período de avaliação
          renews_at:     attrs.renews_at || null,     // próxima renovação
          ends_at:       attrs.ends_at || null,       // data em que termina (definida se cancelada)
          cancelled:     !!attrs.cancelled,           // cancelou (mas pode ainda ter acesso até ends_at)
          quantity:      quantity,                    // nº de lugares
          updated_at:    new Date().toISOString(),
        };
      }
      saveData(data);

      // 3) Acertar o activation_limit = quantity em cada chave.
      for (const k of minhas) {
        const patch = await lemonApiCall('PATCH', `/license-keys/${k.id}`, {
          data: { type: 'license-keys', id: String(k.id), attributes: { activation_limit: quantity } }
        });
        if (patch.httpStatus >= 300) {
          console.error('[lemon-webhook] PATCH falhou', k.id, patch.httpStatus, JSON.stringify(patch.json));
          return err(res, 'PATCH à chave falhou', 500); // retry
        }
        console.log(`[lemon-webhook] ${event}: chave ${k.id} → activation_limit=${quantity} (order ${orderId})`);
      }
      return ok(res, { ok: true, updated: minhas.length, quantity });
    } catch (e) {
      console.error('[lemon-webhook] erro', e.message);
      return err(res, 'erro no webhook: ' + e.message, 500); // retry
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
