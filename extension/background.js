const DEFAULT_CONFIG = {
  symbol: 'sh000300',
  bubbleOpacity: 1,
  bubbleSize: { width: 60, height: 60 },
  bubblePosition: { x: 24, y: 24 },
  theme: 'auto'
};

const DEFAULT_BUBBLE_STATE = {
  collapsed: false,
  hidden: false,
  bubblePosition: { ...DEFAULT_CONFIG.bubblePosition },
  bubbleSize: { ...DEFAULT_CONFIG.bubbleSize }
};

let currentConfig = { ...DEFAULT_CONFIG };
let pollTimerId = null;
let consecutiveFailures = 0;
let lastQuote = null;
let enabled = true; // 控制是否在页面显示气泡
let lastSuccessfulProvider = null; // 上次成功的行情源
const DEBUG = true; // 后台调试日志已开启

function storageGet(area, keys) {
  return new Promise((resolve) => {
    chrome.storage[area].get(keys, (result) => resolve(result));
  });
}

function storageSet(area, items) {
  return new Promise((resolve) => {
    chrome.storage[area].set(items, () => resolve());
  });
}

async function ensureDefaults() {
  const syncData = await storageGet('sync', null);
  const updates = {};
  for (const key of Object.keys(DEFAULT_CONFIG)) {
    if (typeof syncData[key] === 'undefined') {
      updates[key] = DEFAULT_CONFIG[key];
    }
  }
  if (Object.keys(updates).length > 0) {
    await storageSet('sync', updates);
  }

  const localData = await storageGet('local', ['bubbleState']);
  const localUpdates = {};
  if (typeof localData.bubbleState === 'undefined') {
    localUpdates.bubbleState = { ...DEFAULT_BUBBLE_STATE };
  }
  if (typeof localData.enabled === 'undefined') {
    localUpdates.enabled = true;
  }
  if (Object.keys(localUpdates).length) {
    await storageSet('local', localUpdates);
  }
}

async function loadConfig() {
  const data = await storageGet('sync', Object.keys(DEFAULT_CONFIG));
  currentConfig = { ...DEFAULT_CONFIG, ...data };
  currentConfig.bubbleOpacity = Math.min(1, Math.max(0.2, Number(currentConfig.bubbleOpacity) || DEFAULT_CONFIG.bubbleOpacity));
}

async function saveLastQuote(quote) {
  lastQuote = quote;
  await storageSet('local', { lastQuote: quote });
}

function colorForEnabled(isEnabled) {
  // 启用=红色，停用=绿色
  return isEnabled ? '#ef4444' : '#22c55e';
}

function makeLetterAImageData(size, color) {
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, size, size);
  // Transparent background; draw anti-aliased letter A
  const fontSize = Math.floor(size * 0.75);
  ctx.font = `700 ${fontSize}px system-ui, -apple-system, Segoe UI, Arial, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = color;
  // Slight vertical tweak for better centering across sizes
  const cy = size / 2 + Math.floor(size * 0.05);
  ctx.fillText('A', size / 2, cy);
  return ctx.getImageData(0, 0, size, size);
}

async function updateActionIcon(isEnabled = true) {
  try {
    if (typeof OffscreenCanvas === 'undefined') {
      // OffscreenCanvas may be unavailable in some environments; skip icon update
      return;
    }
    const color = colorForEnabled(isEnabled);
    const sizes = [16, 32, 48, 128];
    const imageData = {};
    for (const s of sizes) {
      imageData[s] = makeLetterAImageData(s, color);
    }
    await chrome.action.setIcon({ imageData });
  } catch (_) {
    // ignore icon errors to avoid breaking polling
  }
}

async function broadcastEnabledToAllTabs(isEnabled) {
  const tabs = await chrome.tabs.query({});
  await Promise.all(
    tabs
      .filter((tab) => typeof tab.id === 'number')
      .map((tab) => chrome.tabs.sendMessage(tab.id, { type: 'SET_ENABLED', payload: { enabled: isEnabled } }).catch(() => {}))
  );
}

async function toggleEnabled() {
  enabled = !enabled;
  await storageSet('local', { enabled });
  updateActionIcon(enabled);
  await broadcastEnabledToAllTabs(enabled);
}

async function broadcastQuote(quote) {
  try {
    const tabs = await chrome.tabs.query({});
    await Promise.all(
      tabs
        .filter((tab) => typeof tab.id === 'number')
        .map((tab) => chrome.tabs.sendMessage(tab.id, { type: 'QUOTE_UPDATE', payload: quote }).catch(() => {}))
    );
  } catch (error) {
    console.error('广播行情失败', error);
  }
}

function computeQuoteMetrics(raw) {
  if (!raw || Number.isNaN(raw.price) || Number.isNaN(raw.previousClose)) {
    return raw;
  }
  const change = raw.price - raw.previousClose;
  const changePercent = raw.previousClose === 0 ? 0 : (change / raw.previousClose) * 100;
  const direction = change === 0 ? 'flat' : change > 0 ? 'up' : 'down';
  const color = direction === 'up' ? '#ef4444' : direction === 'down' ? '#22c55e' : '#64748b';
  return { ...raw, change, changePercent, direction, color };
}

function parseTencentQuote(symbol, text) {
  const match = text.match(/="([^"]*)"/);
  if (!match) {
    throw new Error('无法解析腾讯行情响应');
  }
  const parts = match[1].split('~');
  const num = (v) => {
    const x = parseFloat(v);
    return Number.isFinite(x) ? x : NaN;
  };
  let price = num(parts[3]);
  let previousClose = num(parts[4]);
  if (!Number.isFinite(previousClose)) previousClose = num(parts[2]);
  if (!Number.isFinite(price)) price = num(parts[1]);
  const open = num(parts[5]);
  const high = num(parts[33]);
  const low = num(parts[34]);
  const date = parts[30];
  const time = parts[31];
  return {
    symbol,
    name: parts[1] || symbol,
    price,
    previousClose,
    open,
    high,
    low,
    time: date && time ? `${date} ${time}` : undefined,
    provider: 'tencent'
  };
}

function parseSinaQuote(symbol, text) {
  const match = text.match(/="([^"]*)"/);
  if (!match) {
    throw new Error('无法解析新浪行情响应');
  }
  const parts = match[1].split(',');
  const num = (v) => {
    const x = parseFloat(v);
    return Number.isFinite(x) ? x : NaN;
  };
  const price = num(parts[3]);
  const previousClose = num(parts[2]);
  const open = num(parts[1]);
  const high = num(parts[4]);
  const low = num(parts[5]);
  const date = parts[30];
  const time = parts[31];
  return {
    symbol,
    name: parts[0] || symbol,
    price,
    previousClose,
    open,
    high,
    low,
    time: date && time ? `${date} ${time}` : undefined,
    provider: 'sina'
  };
}

async function fetchQuote() {
  const symbol = currentConfig.symbol;

  async function fetchFromProvider(provider) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      if (provider === 'sina') {
        const url = `https://hq.sinajs.cn/list=${symbol}`;
        const response = await fetch(url, {
          cache: 'no-store',
          signal: controller.signal,
          headers: { 'Content-Type': 'text/plain; charset=gbk' }
        });
        if (!response.ok) throw new Error(`Sina HTTP ${response.status}`);
        const buffer = await response.arrayBuffer();
        let decoder;
        try {
          decoder = new TextDecoder('gbk');
        } catch (error) {
          try {
            decoder = new TextDecoder('gb18030');
          } catch (_) {
            decoder = new TextDecoder();
          }
        }
        const text = decoder.decode(buffer);
        const q = parseSinaQuote(symbol, text);
        if (DEBUG) console.debug('[bg] Sina parsed', q);
        return computeQuoteMetrics(q);
      } else {
        const url = `https://qt.gtimg.cn/q=${symbol}`;
        const response = await fetch(url, { cache: 'no-store', signal: controller.signal });
        if (!response.ok) throw new Error(`Tencent HTTP ${response.status}`);
        const text = await response.text();
        const q = parseTencentQuote(symbol, text);
        if (DEBUG) console.debug('[bg] Tencent parsed', q);
        return computeQuoteMetrics(q);
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  const prefer = lastSuccessfulProvider || 'tencent';
  const fallback = prefer === 'tencent' ? 'sina' : 'tencent';
  try {
    if (DEBUG) console.debug('[bg] fetchQuote prefer', prefer, 'symbol=', symbol);
    const q = await fetchFromProvider(prefer);
    if (q && q.provider) {
      lastSuccessfulProvider = q.provider;
      await storageSet('local', { lastSuccessfulProvider });
    }
    return q;
  } catch (e1) {
    try {
      if (DEBUG) console.log('[bg] fetchQuote fallback', fallback, 'err1=', e1?.message || e1);
      const q2 = await fetchFromProvider(fallback);
      if (q2 && q2.provider) {
        lastSuccessfulProvider = q2.provider;
        await storageSet('local', { lastSuccessfulProvider });
      }
      return q2;
    } catch (e2) {
      if (DEBUG) console.log('[bg] fetchQuote both failed', e1, e2);
      // 都失败则抛出组合错误信息，便于排查
      throw new Error(`${e1?.message || e1} | ${e2?.message || e2}`);
    }
  }
}

// Probe both providers and return connectivity + parsed quotes for comparison
async function testConnectivityForSymbol(symbol) {
  const controllerFactory = () => {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 8000);
    return { c, t };
  };
  async function tryProvider(provider) {
    const { c, t } = controllerFactory();
    const start = Date.now();
    try {
      if (provider === 'sina') {
        const url = `https://hq.sinajs.cn/list=${symbol}`;
        const response = await fetch(url, { cache: 'no-store', signal: c.signal, headers: { 'Content-Type': 'text/plain; charset=gbk' } });
        if (!response.ok) throw new Error(`Sina HTTP ${response.status}`);
        const buffer = await response.arrayBuffer();
        let decoder;
        try { decoder = new TextDecoder('gbk'); } catch (_) { try { decoder = new TextDecoder('gb18030'); } catch (_) { decoder = new TextDecoder(); } }
        const text = decoder.decode(buffer);
        const q = parseSinaQuote(symbol, text);
        const ms = Date.now() - start;
        return { ok: true, provider: 'sina', ms, price: q.price, quote: computeQuoteMetrics(q) };
      } else {
        const url = `https://qt.gtimg.cn/q=${symbol}`;
        const response = await fetch(url, { cache: 'no-store', signal: c.signal });
        if (!response.ok) throw new Error(`Tencent HTTP ${response.status}`);
        const text = await response.text();
        const q = parseTencentQuote(symbol, text);
        const ms = Date.now() - start;
        return { ok: true, provider: 'tencent', ms, price: q.price, quote: computeQuoteMetrics(q) };
      }
    } catch (e) {
      const ms = Date.now() - start;
      return { ok: false, provider, ms, error: String(e?.message || e) };
    } finally {
      clearTimeout(t);
    }
  }
  const [tencent, sina] = await Promise.all([tryProvider('tencent'), tryProvider('sina')]);
  let diff = { changed: false };
  if (tencent.ok && sina.ok) {
    const p1 = tencent.price;
    const p2 = sina.price;
    const changed = Number.isFinite(p1) && Number.isFinite(p2) && Math.abs(p1 - p2) > 1e-6;
    diff = { changed, delta: changed ? (p1 - p2) : 0 };
  }
  return { ok: true, tencent, sina, diff };
}

async function fetchAndBroadcast() {
  try {
    const quote = await fetchQuote();
    quote.updatedAt = Date.now();
    await saveLastQuote(quote);
    await broadcastQuote(quote);
    consecutiveFailures = 0;
  } catch (error) {
    console.error('获取行情失败', error);
    consecutiveFailures += 1;
  }
}

function stopPolling() {
  if (pollTimerId) {
    clearTimeout(pollTimerId);
    pollTimerId = null;
  }
}

function isTradingHours(now = new Date()) {
  const day = now.getDay();
  if (day === 0 || day === 6) return false; // 周末
  const h = now.getHours();
  const m = now.getMinutes();
  const hm = h * 60 + m;
  const amStart = 9 * 60 + 30;
  const amEnd = 11 * 60 + 30;
  const pmStart = 13 * 60;
  const pmEnd = 15 * 60;
  return (hm >= amStart && hm <= amEnd) || (hm >= pmStart && hm <= pmEnd);
}

function nextIntervalMs() {
  if (consecutiveFailures > 0) {
    return Math.min(30000, 5000 + (consecutiveFailures - 1) * 5000);
  }
  return isTradingHours() ? 5000 : 30000;
}

function scheduleNext() {
  clearTimeout(pollTimerId);
  pollTimerId = setTimeout(async () => {
    await fetchAndBroadcast();
    scheduleNext();
  }, nextIntervalMs());
}

function startPolling() {
  stopPolling();
  scheduleNext();
  fetchAndBroadcast();
}

async function init() {
  await ensureDefaults();
  await loadConfig();
  const local = await storageGet('local', ['lastQuote', 'enabled', 'lastSuccessfulProvider']);
  if (local.lastQuote) {
    lastQuote = local.lastQuote;
  }
  enabled = typeof local.enabled === 'boolean' ? local.enabled : true;
  if (typeof local.lastSuccessfulProvider === 'string') {
    lastSuccessfulProvider = local.lastSuccessfulProvider;
  }
  updateActionIcon(enabled);
  startPolling();
  // schedule daily index refresh at 06:00 local
  try { await chrome.alarms.clear('refreshIndexDaily'); } catch (_) {}
  scheduleDailyRefresh();
  // Proactively refresh Eastmoney index once at startup (non-blocking)
  refreshIndexFromEastmoney().catch(() => {});
}

chrome.runtime.onInstalled.addListener(() => {
  init();
});

chrome.runtime.onStartup.addListener(() => {
  init();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'sync') {
    let configChanged = false;
    for (const key of Object.keys(changes)) {
      if (key in DEFAULT_CONFIG) {
        currentConfig[key] = changes[key].newValue;
        configChanged = true;
      }
    }
    if (configChanged) {
      startPolling();
    }
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') {
    return;
  }
  if (message.type === 'GET_INITIAL_STATE') {
    sendResponse({
      config: currentConfig,
      quote: lastQuote,
      enabled
    });
    return false;
  }
  if (message.type === 'SAVE_BUBBLE_STATE') {
    storageSet('local', { bubbleState: message.payload }).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (message.type === 'REQUEST_REFRESH') {
    fetchAndBroadcast().then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (message.type === 'SET_ENABLED_REQUEST') {
    try {
      const next = !!(message && message.payload && message.payload.enabled);
      enabled = next;
      storageSet('local', { enabled }).then(() => {
        updateActionIcon(enabled);
        broadcastEnabledToAllTabs(enabled).then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: true }));
      });
    } catch (_) {
      sendResponse({ ok: false });
    }
    return true;
  }
});

chrome.action.onClicked.addListener(() => { toggleEnabled(); });

chrome.commands.onCommand.addListener((command) => {
  if (command === 'toggle-enabled') {
    toggleEnabled();
  }
});

init();

// --- Daily index refresh support ---
function scheduleDailyRefresh() {
  const now = new Date();
  const next = new Date(now);
  next.setHours(6, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  chrome.alarms.create('refreshIndexDaily', { when: next.getTime(), periodInMinutes: 24 * 60 });
}

// removed legacy fetchAndCacheIndexFromUrl

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm?.name !== 'refreshIndexDaily') return;
  await refreshIndexFromEastmoneyWithRetry(3);
});

// --- Eastmoney local index refresh ---
async function refreshIndexFromEastmoney() {
  try {
    const url = 'https://push2.eastmoney.com/api/qt/clist/get';
    const segments = ['m:1 t:2', 'm:1 t:23', 'm:0 t:6', 'm:0 t:80', 'm:0 t:81'];
    const all = [];
    for (const fs of segments) {
      let pn = 1;
      const pz = 500;
      for (let i = 0; i < 50; i++) {
        const params = { pn, pz, po: 1, np: 1, fltt: 2, invt: 2, fid: 'f3', fields: 'f12,f14', fs, ut: 'fa5fd1943c7b386f172d6893dbfba10b' };
        // Ensure spaces in fs are encoded as %20 (not +)
        const qs = new URLSearchParams(params).toString().replace(/\+/g, '%20');
        const resp = await fetch(`${url}?${qs}`, { cache: 'no-store' });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const json = await resp.json();
        const diff = json?.data?.diff || [];
        if (!Array.isArray(diff) || diff.length === 0) break;
        for (const x of diff) {
          const code = String(x?.f12 || '').trim();
          const name = String(x?.f14 || '').trim();
          if (/^\d{6}$/.test(code) && name) {
            all.push({ code, name });
          }
        }
        pn += 1;
      }
    }
    const cleaned = all
      .filter((x) => /^\d{6}$/.test(x.code) && x.name)
      .map((x) => ({ market: x.code.startsWith('6') ? 'sh' : 'sz', code: x.code, name: x.name }));
    const uniqMap = new Map();
    for (const it of cleaned) {
      uniqMap.set(`${it.market}${it.code}`, it);
    }
    const finalList = Array.from(uniqMap.values());
    await chrome.storage.local.set({
      stockIndex: finalList,
      stockIndexUpdatedAt: Date.now(),
      stockIndexLastStatus: 'success',
      stockIndexLastError: ''
    });
    return { ok: true, size: finalList.length };
  } catch (e) {
    console.warn('[bg] eastmoney refresh failed', e);
    await chrome.storage.local.set({
      stockIndexUpdatedAt: Date.now(),
      stockIndexLastStatus: 'fail',
      stockIndexLastError: String(e && e.message ? e.message : e)
    });
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

// Simple retry wrapper with backoff
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function refreshIndexFromEastmoneyWithRetry(maxAttempts = 3) {
  let last;
  for (let i = 1; i <= maxAttempts; i++) {
    last = await refreshIndexFromEastmoney();
    if (last && last.ok) return last;
    await sleep(i * 1000);
  }
  return last || { ok: false, error: 'retry-failed' };
}

// Expose manual refresh via message
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return;
  if (message.type === 'REFRESH_STOCK_INDEX') {
    refreshIndexFromEastmoneyWithRetry(3).then((res) => sendResponse(res)).catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }
  if (message.type === 'TEST_CONNECTIVITY') {
    const sym = message && message.payload && message.payload.symbol;
    if (!sym || !/^(sh|sz)\d{6}$/i.test(sym)) {
      sendResponse({ ok: false, error: 'invalid-symbol' });
      return false;
    }
    testConnectivityForSymbol(sym)
      .then((res) => sendResponse(res))
      .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }
});
