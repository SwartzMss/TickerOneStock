const DEFAULT_CONFIG = {
  symbol: 'sh000300',
  refreshInterval: 10,
  bubbleOpacity: 1,
  bubbleSize: { width: 120, height: 120 },
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
let lastQuote = null;
let enabled = true; // 控制是否在页面显示气泡
let lastSuccessfulProvider = null; // 上次成功的行情源

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
  currentConfig.refreshInterval = Math.max(3, Number(currentConfig.refreshInterval) || DEFAULT_CONFIG.refreshInterval);
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

function makeCircleImageData(size, color) {
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, size, size);
  ctx.fillStyle = color;
  const r = Math.floor(size / 2);
  ctx.beginPath();
  ctx.arc(r, r, r - 1, 0, Math.PI * 2);
  ctx.closePath();
  ctx.fill();
  return ctx.getImageData(0, 0, size, size);
}

async function updateActionIcon(isEnabled = true) {
  try {
    const color = colorForEnabled(isEnabled);
    const sizes = [16, 32, 48, 128];
    const imageData = {};
    for (const s of sizes) {
      imageData[s] = makeCircleImageData(s, color);
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
  if (parts.length < 32) {
    throw new Error('腾讯行情响应字段不足');
  }
  const price = parseFloat(parts[3]);
  const previousClose = parseFloat(parts[4]);
  const open = parseFloat(parts[5]);
  const high = parseFloat(parts[33]);
  const low = parseFloat(parts[34]);
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
    time: `${date} ${time}`,
    provider: 'tencent'
  };
}

function parseSinaQuote(symbol, text) {
  const match = text.match(/="([^"]*)"/);
  if (!match) {
    throw new Error('无法解析新浪行情响应');
  }
  const parts = match[1].split(',');
  if (parts.length < 32) {
    throw new Error('新浪行情响应字段不足');
  }
  const price = parseFloat(parts[3]);
  const previousClose = parseFloat(parts[2]);
  const open = parseFloat(parts[1]);
  const high = parseFloat(parts[4]);
  const low = parseFloat(parts[5]);
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
    time: `${date} ${time}`,
    provider: 'sina'
  };
}

async function fetchQuote() {
  const symbol = currentConfig.symbol;

  async function fetchFromProvider(provider) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.max(5000, currentConfig.refreshInterval * 1000));
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
        return computeQuoteMetrics(parseSinaQuote(symbol, text));
      } else {
        const url = `https://qt.gtimg.cn/q=${symbol}`;
        const response = await fetch(url, { cache: 'no-store', signal: controller.signal });
        if (!response.ok) throw new Error(`Tencent HTTP ${response.status}`);
        const text = await response.text();
        return computeQuoteMetrics(parseTencentQuote(symbol, text));
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  const prefer = lastSuccessfulProvider || 'tencent';
  const fallback = prefer === 'tencent' ? 'sina' : 'tencent';
  try {
    const q = await fetchFromProvider(prefer);
    if (q && q.provider) {
      lastSuccessfulProvider = q.provider;
      await storageSet('local', { lastSuccessfulProvider });
    }
    return q;
  } catch (e1) {
    try {
      const q2 = await fetchFromProvider(fallback);
      if (q2 && q2.provider) {
        lastSuccessfulProvider = q2.provider;
        await storageSet('local', { lastSuccessfulProvider });
      }
      return q2;
    } catch (e2) {
      // 都失败则抛出第一错误
      throw e1;
    }
  }
}

async function fetchAndBroadcast() {
  try {
    const quote = await fetchQuote();
    quote.updatedAt = Date.now();
    await saveLastQuote(quote);
    await broadcastQuote(quote);
  } catch (error) {
    console.error('获取行情失败', error);
  }
}

function stopPolling() {
  if (pollTimerId) {
    clearInterval(pollTimerId);
    pollTimerId = null;
  }
}

function startPolling() {
  stopPolling();
  const interval = Math.max(3, Number(currentConfig.refreshInterval) || DEFAULT_CONFIG.refreshInterval) * 1000;
  pollTimerId = setInterval(fetchAndBroadcast, interval);
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
});

chrome.action.onClicked.addListener(() => { toggleEnabled(); });

chrome.commands.onCommand.addListener((command) => {
  if (command === 'toggle-enabled') {
    toggleEnabled();
  }
});

init();
