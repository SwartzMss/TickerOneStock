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
const hasChrome = typeof chrome !== 'undefined' && !!chrome.storage;

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
  const syncValues = await storageGet('sync', Object.keys(DEFAULT_CONFIG));
  const config = { ...DEFAULT_CONFIG, ...syncValues };

  form.symbol.value = config.symbol;
  form.bubbleWidth.value = config.bubbleSize?.width ?? DEFAULT_CONFIG.bubbleSize.width;
}

function serializeForm() {
  const bubbleWidth = Number(form.bubbleWidth.value) || DEFAULT_CONFIG.bubbleSize.width;
  return {
    symbol: form.symbol.value.trim(),
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
    const normalized = await ensureNormalizedBeforeSave();
    form.symbol.value = normalized;
  } catch (e) {
    showStatus('无法识别该标的，请更换关键词', 'error');
    return;
  }
  const config = serializeForm();
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
  try {
    const url = chrome.runtime.getURL('stocks.json');
    const resp = await fetch(url, { cache: 'no-store' });
    stockIndex = await resp.json();
  } catch (_) {
    stockIndex = [];
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
    .map((s) => `<div class="search-item" role="option" data-sym="${s.market}${s.code}"><span class="search-item__name">${s.name}</span><span class="search-item__meta">${s.market}${s.code}</span></div>`) 
    .join('');
  searchResults.style.display = 'block';
}

async function doSearch() {
  const raw = form.symbol.value.trim();
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
  if (sym) {
    form.symbol.value = sym;
    showStatus(`已选择 ${sym}`);
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
        if (sym) {
          form.symbol.value = sym;
          searchResults.style.display = 'none';
          showStatus(`已选择 ${sym}`);
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

async function ensureNormalizedBeforeSave() {
  const val = form.symbol.value.trim();
  if (/^(sh|sz)\d{6}$/i.test(val)) return val.toLowerCase();
  const first = searchResults.querySelector('.search-item');
  if (first) {
    const sym = first.getAttribute('data-sym');
    if (sym) return sym;
  }
  const idx = await ensureStockIndex();
  const key = val.toLowerCase();
  const match = idx.find((s) => s.name.toLowerCase() === key || s.code === val);
  if (match) return `${match.market}${match.code}`;
  const sym2 = normalizeCodeToSymbol(val);
  if (sym2) return sym2;
  const api = await fetchSinaSuggest(val).catch(() => []);
  if (api && api.length) return `${api[0].market}${api[0].code}`;
  const api2 = await fetchTencentSuggest(val).catch(() => []);
  if (api2 && api2.length) return `${api2[0].market}${api2[0].code}`;
  throw new Error('no-match');
}
