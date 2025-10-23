const DEFAULT_CONFIG = {
  symbol: 'sh000300',
  refreshInterval: 10,
  quoteProvider: 'tencent',
  bubbleOpacity: 0.95,
  bubbleSize: { width: 220, height: 120 },
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
  if (typeof localData.bubbleState === 'undefined') {
    await storageSet('local', { bubbleState: { ...DEFAULT_BUBBLE_STATE } });
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
  const provider = currentConfig.quoteProvider;
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
    }
    const url = `https://qt.gtimg.cn/q=${symbol}`;
    const response = await fetch(url, { cache: 'no-store', signal: controller.signal });
    const text = await response.text();
    return computeQuoteMetrics(parseTencentQuote(symbol, text));
  } finally {
    clearTimeout(timeout);
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
  const local = await storageGet('local', ['lastQuote']);
  if (local.lastQuote) {
    lastQuote = local.lastQuote;
  }
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
      quote: lastQuote
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

init();
