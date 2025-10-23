const DEFAULT_INDEX_URL = 'https://raw.githubusercontent.com/your-name/TickerOneStock/main/extension/stocks.json';

const DEFAULT_CONFIG = {
  symbol: 'sh000300',
  bubbleOpacity: 1,
  bubbleSize: { width: 60, height: 60 },
  bubblePosition: { x: 24, y: 24 },
  theme: 'auto'
};

const form = document.getElementById('options-form');
const statusEl = document.getElementById('status');
const searchResults = document.getElementById('search-results');
const selectedSummary = document.getElementById('selected-summary');
const refreshIndexBtn = document.getElementById('refresh-index');
const indexInfo = document.getElementById('index-info');
const hasChrome = typeof chrome !== 'undefined' && !!chrome.storage;
const DEBUG = true;

function storageGet(area, keys) {
  if (!hasChrome) {
    return Promise.resolve({});
  }
  return new Promise((resolve) => chrome.storage[area].get(keys, resolve));
}

function storageSet(area, items) {
  if (!hasChrome) {
    return Promise.resolve();
  }
  return new Promise((resolve) => chrome.storage[area].set(items, resolve));
}

function showStatus(message, type = 'success') {
  statusEl.textContent = message;
  statusEl.style.color = type === 'error' ? 'rgba(239, 68, 68, 0.9)' : 'rgba(34, 197, 94, 0.9)';
  setTimeout(() => {
    statusEl.textContent = '';
  }, 3000);
}

async function loadConfig() {
  const keys = [...Object.keys(DEFAULT_CONFIG), 'symbolName', 'indexUrl'];
  const syncValues = await storageGet('sync', keys);
  const config = { ...DEFAULT_CONFIG, ...syncValues };
  if (DEBUG) console.log('[options] loadConfig syncValues=', syncValues);

  if (config.symbol && /^(sh|sz)\d{6}$/i.test(config.symbol) && syncValues.symbolName) {
    form.symbol.value = `${syncValues.symbolName}  ${config.symbol}`;
  } else {
    form.symbol.value = config.symbol || '';
  }
  form.bubbleWidth.value = config.bubbleSize?.width ?? DEFAULT_CONFIG.bubbleSize.width;
  // index url
  if (form.indexUrl) form.indexUrl.value = syncValues.indexUrl || DEFAULT_INDEX_URL || '';
}

function parseCombinedSymbol(input) {
  const val = String(input || '').trim();
  const m = val.match(/(sh|sz)\d{6}/i);
  if (!m) return { symbol: val, name: undefined };
  const sym = m[0].toLowerCase();
  const name = val.slice(0, m.index).trim() || undefined;
  return { symbol: sym, name };
}

function serializeForm() {
  const bubbleWidth = Number(form.bubbleWidth.value) || DEFAULT_CONFIG.bubbleSize.width;
  const parsed = parseCombinedSymbol(form.symbol.value);
  if (DEBUG) console.log('[options] serializeForm parsed=', parsed);
  return {
    symbol: parsed.symbol,
    symbolName: parsed.name,
    bubbleSize: { width: bubbleWidth },
    // 透明度和主题自动
  };
}

async function handleSubmit(event) {
  event.preventDefault();
  if (!hasChrome) {
    showStatus('当前页面未在扩展环境中运行，无法保存配置。', 'error');
    return;
  }
  // Ensure we save a normalized symbol (sh/sz+code)
  try {
    const { symbol: normalized, name: resolvedName } = await ensureNormalizedBeforeSave();
    form.symbol.value = resolvedName ? `${resolvedName}  ${normalized}` : normalized;
    if (DEBUG) console.log('[options] normalized before save =', { normalized, resolvedName });
  } catch (e) {
    showStatus('无法识别该标的，请更换关键词', 'error');
    if (DEBUG) console.log('[options] normalize failed', e);
    return;
  }
  // Build config directly using normalized result to avoid mis-parsing
  const bubbleWidth = Number(form.bubbleWidth.value) || DEFAULT_CONFIG.bubbleSize.width;
  const displayVal = String(form.symbol.value || '');
  // Try to split display "name  shxxxxxx" back to components
  const parsed = parseCombinedSymbol(displayVal);
  const symbolName = parsed.name; // may be undefined; we also fallback to resolvedName in ensureNormalizedBeforeSave
  const finalName = symbolName || (displayVal.includes('  ') ? displayVal.split('  ')[0].trim() : undefined);
  const finalSymbol = (await ensureNormalizedBeforeSave()).symbol; // guaranteed normalized
  const config = {
    symbol: finalSymbol,
    symbolName: finalName,
    bubbleSize: { width: bubbleWidth },
    indexUrl: form.indexUrl ? (form.indexUrl.value || undefined) : undefined
  };
  await storageSet('sync', config);
  showStatus('已保存，后台将在下个周期使用新配置刷新。');
}

// 透明度与主题已自动，无需交互

// 移除“重置气泡位置”按钮逻辑

form.addEventListener('submit', handleSubmit);

loadConfig()
  .then(() => {
    if (!hasChrome) {
      showStatus('提示：当前为预览模式，保存与同步功能不可用。', 'error');
    }
  })
  .catch((error) => {
    console.error('加载配置失败', error);
    showStatus('加载配置失败，请重试。', 'error');
  });

// --- Symbol helpers ---
let stockIndex = null;
async function ensureStockIndex() {
  if (stockIndex) return stockIndex;
  // 1) Try cached in local storage
  if (hasChrome) {
    const local = await new Promise((resolve) => chrome.storage.local.get(['stockIndex', 'stockIndexUpdatedAt'], resolve));
    if (Array.isArray(local.stockIndex) && local.stockIndex.length) {
      stockIndex = local.stockIndex;
      if (indexInfo && local.stockIndexUpdatedAt) {
        const dt = new Date(local.stockIndexUpdatedAt);
        indexInfo.textContent = `索引本地缓存，共 ${stockIndex.length} 条，更新时间 ${dt.toLocaleString()}`;
      }
      return stockIndex;
    }
    // If no cache but indexUrl configured, try once now
    const { indexUrl } = await new Promise((resolve) => chrome.storage.sync.get(['indexUrl'], resolve));
    const sourceUrl = indexUrl || DEFAULT_INDEX_URL;
    if (sourceUrl) {
      try {
        const resp = await fetch(sourceUrl, { cache: 'no-store' });
        if (resp.ok) {
          const list = await resp.json();
          const cleaned = Array.isArray(list)
            ? list.map((x) => ({ market: String(x.market||'').toLowerCase(), code: String(x.code||'').trim(), name: String(x.name||'').trim() }))
                  .filter((x) => /^(sh|sz)$/.test(x.market) && /^\d{6}$/.test(x.code) && x.name)
            : [];
          if (cleaned.length) {
            await new Promise((resolve) => chrome.storage.local.set({ stockIndex: cleaned, stockIndexUpdatedAt: Date.now() }, resolve));
            stockIndex = cleaned;
            if (indexInfo) indexInfo.textContent = `索引本地缓存，共 ${cleaned.length} 条，更新时间 ${new Date().toLocaleString()}`;
            return stockIndex;
          }
        }
      } catch (_) {}
    }
  }
  // 2) Fallback to packaged stocks.json
  try {
    const url = chrome.runtime.getURL('stocks.json');
    const resp = await fetch(url, { cache: 'no-store' });
    stockIndex = await resp.json();
    if (indexInfo) indexInfo.textContent = `使用内置索引，共 ${stockIndex.length} 条`;
  } catch (_) {
    stockIndex = [];
    if (indexInfo) indexInfo.textContent = '未能加载索引';
  }
  return stockIndex;
}

function normalizeCodeToSymbol(input) {
  const val = String(input).trim();
  if (!val) return '';
  if (/^(sh|sz)\d{6}$/i.test(val)) return val.toLowerCase();
  const isDigits = /^\d{6}$/.test(val);
  if (val === '000300') return 'sh000300';
  if (val.startsWith('399')) return `sz${val}`;
  if (val.startsWith('000')) return `sh${val}`;
  if (isDigits) {
    if (val.startsWith('688') || /^(6|9|5|7|8)/.test(val)) return `sh${val}`;
    return `sz${val}`;
  }
  return '';
}

async function doDetect() {
  const raw = form.symbol.value.trim();
  if (!raw) {
    showStatus('请输入名称或代码', 'error');
    return;
  }
  const idx = await ensureStockIndex();
  const key = raw.toLowerCase();
  const match = idx.find((s) => s.name.toLowerCase() === key || s.code === raw);
  if (match) {
    const sym = `${match.market}${match.code}`;
    form.symbol.value = sym;
    showStatus(`已补全为 ${sym}`);
    return;
  }
  const sym2 = normalizeCodeToSymbol(raw);
  if (sym2) {
    form.symbol.value = sym2;
    showStatus(`已补全为 ${sym2}`);
    return;
  }
  showStatus('未识别，请使用模糊搜索选择', 'error');
}

function renderSearchResults(list) {
  if (!list || list.length === 0) {
    searchResults.style.display = 'none';
    searchResults.innerHTML = '';
    return;
  }
  searchResults.innerHTML = list
    .slice(0, 50)
    .map((s) => `<div class="search-item" role="option" data-sym="${s.market}${s.code}" data-name="${s.name}"><span class="search-item__name">${s.name}</span><span class="search-item__meta">${s.market}${s.code}</span></div>`) 
    .join('');
  searchResults.style.display = 'block';
}

async function doSearch() {
  const raw = form.symbol.value.trim();
  if (raw.length < 2) {
    searchResults.style.display = 'none';
    searchResults.innerHTML = '';
    return;
  }
  // Prefer live API; fallback to local index
  const apiResults = await fetchSinaSuggest(raw).catch(() => []);
  if (apiResults && apiResults.length) { renderSearchResults(apiResults); return; }
  const apiResults2 = await fetchTencentSuggest(raw).catch(() => []);
  if (apiResults2 && apiResults2.length) { renderSearchResults(apiResults2); return; }
  const idx = await ensureStockIndex();
  if (!raw) {
    renderSearchResults(idx.slice(0, 20));
    return;
  }
  const key = raw.toLowerCase();
  const results = idx.filter((s) => s.name.toLowerCase().includes(key) || s.code.includes(key));
  renderSearchResults(results);
}

searchResults?.addEventListener('click', (e) => {
  const item = e.target.closest('.search-item');
  if (!item) return;
  const sym = item.getAttribute('data-sym');
  const nm = item.getAttribute('data-name') || '';
  if (sym) {
    form.symbol.value = nm ? `${nm}  ${sym}` : sym;
    if (selectedSummary) {
      selectedSummary.textContent = nm ? `已选择：${nm}  ${sym}` : `已选择：${sym}`;
      if (nm) selectedSummary.dataset.name = nm; else delete selectedSummary.dataset.name;
    }
    showStatus(`已选择 ${nm || sym}`);
  }
  searchResults.style.display = 'none';
});

form.symbol.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    doSearch().then(() => {
      // Select first suggestion if available
      const first = searchResults.querySelector('.search-item');
      if (first) {
        const sym = first.getAttribute('data-sym');
        const nm = first.getAttribute('data-name') || '';
        if (sym) {
          form.symbol.value = nm ? `${nm}  ${sym}` : sym;
          searchResults.style.display = 'none';
          if (selectedSummary) {
            selectedSummary.textContent = nm ? `已选择：${nm}  ${sym}` : `已选择：${sym}`;
            if (nm) selectedSummary.dataset.name = nm; else delete selectedSummary.dataset.name;
          }
          showStatus(`已选择 ${nm || sym}`);
        }
      } else {
        doDetect();
      }
    });
  }
});

// Live API suggest (Sina)
async function fetchSinaSuggest(key) {
  const q = (key || form.symbol.value || '').trim();
  if (!q) return [];
  const url = `https://suggest3.sinajs.cn/suggest/type=11,12,13,14&key=${encodeURIComponent(q)}`;
  const resp = await fetch(url, { cache: 'no-store', headers: { 'Content-Type': 'text/plain; charset=gbk' } });
  const buf = await resp.arrayBuffer();
  let decoder;
  try { decoder = new TextDecoder('gbk'); } catch (_) { decoder = new TextDecoder('gb18030'); }
  const text = decoder.decode(buf);
  const m = text.match(/="([^"]*)"/);
  if (!m) return [];
  const entries = m[1].split(';').filter(Boolean);
  const list = entries.map((line) => {
    const parts = line.split(',');
    const sym = (parts[0] || '').trim().toLowerCase();
    const name = (parts[4] || parts[1] || '').trim();
    const market = sym.slice(0, 2);
    const code = sym.slice(2);
    return market && code ? { market, code, name } : null;
  }).filter(Boolean);
  return list;
}

// Live API suggest (Tencent)
async function fetchTencentSuggest(key) {
  const q = (key || form.symbol.value || '').trim();
  if (!q) return [];
  const url = `https://smartbox.gtimg.cn/s3/?t=all&q=${encodeURIComponent(q)}`;
  const resp = await fetch(url, { cache: 'no-store' });
  const text = await resp.text();
  // Expected like: v_hint="sz000001,平安银行,...;sh600519,贵州茅台,...;"
  const m = text.match(/="([^"]*)"/);
  if (!m) return [];
  const entries = m[1].split(';').filter(Boolean);
  const list = entries.map((line) => {
    const parts = line.split(',');
    const sym = (parts[0] || '').trim().toLowerCase();
    const name = (parts[1] || '').trim();
    if (!/^((sh|sz)\d{6})$/.test(sym)) return null;
    const market = sym.slice(0, 2);
    const code = sym.slice(2);
    return { market, code, name };
  }).filter(Boolean);
  return list;
}

// Debounced live search on input
let searchTimer = null;
form.symbol.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    doSearch().catch(() => {});
  }, 250);
});

// Hide dropdown on outside click or ESC/blur
document.addEventListener('click', (e) => {
  const inside = e.target.closest && (e.target.closest('#search-results') || e.target.closest('#symbol'));
  if (!inside) {
    searchResults.style.display = 'none';
  }
});

form.symbol.addEventListener('blur', () => {
  setTimeout(() => { searchResults.style.display = 'none'; }, 150);
});

form.symbol.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    searchResults.style.display = 'none';
  }
});

async function ensureNormalizedBeforeSave() {
  const val = form.symbol.value.trim();
  if (/^(sh|sz)\d{6}$/i.test(val)) {
    const name = await resolveNameForSymbol(val).catch(() => undefined);
    return { symbol: val.toLowerCase(), name };
  }
  const first = searchResults.querySelector('.search-item');
  if (first) {
    const sym = first.getAttribute('data-sym');
    const nm = first.getAttribute('data-name') || '';
    if (sym && /^(sh|sz)\d{6}$/i.test(sym)) return { symbol: sym.toLowerCase(), name: nm };
  }
  const idx = await ensureStockIndex();
  const key = val.toLowerCase();
  const match = idx.find((s) => s.name.toLowerCase() === key || s.code === val);
  if (match) {
    const sym = `${match.market}${match.code}`.toLowerCase();
    if (/^(sh|sz)\d{6}$/i.test(sym)) return { symbol: sym, name: match.name };
  }
  const sym2 = normalizeCodeToSymbol(val);
  if (sym2) {
    const name = await resolveNameForSymbol(sym2).catch(() => undefined);
    return { symbol: sym2, name };
  }
  const api = await fetchSinaSuggest(val).catch(() => []);
  if (api && api.length) {
    const a = api[0];
    const sym = `${a.market}${a.code}`.toLowerCase();
    if (/^(sh|sz)\d{6}$/i.test(sym)) return { symbol: sym, name: a.name };
  }
  const api2 = await fetchTencentSuggest(val).catch(() => []);
  if (api2 && api2.length) {
    const a2 = api2[0];
    const sym = `${a2.market}${a2.code}`.toLowerCase();
    if (/^(sh|sz)\d{6}$/i.test(sym)) return { symbol: sym, name: a2.name };
  }
  throw new Error('no-match');
}

async function resolveNameForSymbol(sym) {
  const code = sym.slice(2);
  let list = await fetchSinaSuggest(code).catch(() => []);
  if (list && list.length) {
    const hit = list.find((x) => `${x.market}${x.code}`.toLowerCase() === sym.toLowerCase());
    if (hit) return hit.name;
  }
  list = await fetchTencentSuggest(code).catch(() => []);
  if (list && list.length) {
    const hit = list.find((x) => `${x.market}${x.code}`.toLowerCase() === sym.toLowerCase());
    if (hit) return hit.name;
  }
  const idx = await ensureStockIndex();
  const item = idx.find((s) => `${s.market}${s.code}`.toLowerCase() === sym.toLowerCase());
  return item?.name;
}

// --- Manual refresh for full index ---
async function refreshStockIndex() {
  if (!hasChrome) { showStatus('仅在扩展环境中可用', 'error'); return; }
  const preset = (form.indexUrl && form.indexUrl.value) || DEFAULT_INDEX_URL || '';
  const url = window.prompt('请输入股票索引 JSON 的 URL（同源或支持 CORS）：', preset);
  if (!url) return;
  try {
    const resp = await fetch(url, { cache: 'no-store' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const list = await resp.json();
    if (!Array.isArray(list)) throw new Error('索引格式非数组');
    const cleaned = list
      .map((x) => ({ market: (x.market||'').toLowerCase(), code: String(x.code||'').trim(), name: String(x.name||'').trim() }))
      .filter((x) => x.market && x.code && x.name && /^(sh|sz)$/.test(x.market) && /^\d{6}$/.test(x.code));
    await new Promise((resolve) => chrome.storage.local.set({ stockIndex: cleaned, stockIndexUpdatedAt: Date.now() }, resolve));
    stockIndex = cleaned;
    if (indexInfo) indexInfo.textContent = `索引本地缓存，共 ${cleaned.length} 条，更新时间 ${new Date().toLocaleString()}`;
    showStatus(`已刷新索引，共 ${cleaned.length} 条`);
  } catch (e) {
    console.error('刷新索引失败', e);
    showStatus('刷新索引失败，请检查 URL 或网络', 'error');
  }
}

refreshIndexBtn?.addEventListener('click', refreshStockIndex);
