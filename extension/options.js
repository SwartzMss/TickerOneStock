const DEFAULT_CONFIG = {
  symbol: 'sh000300',
  bubbleOpacity: 1,
  bubbleSize: { width: 60, height: 60 },
  bubblePosition: { x: 24, y: 24 },
  theme: 'auto'
};

const form = document.getElementById('options-form');
const statusEl = document.getElementById('status');
const detectBtn = document.getElementById('detect-symbol');
const searchBtn = document.getElementById('search-symbol');
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

detectBtn?.addEventListener('click', doDetect);
searchBtn?.addEventListener('click', doSearch);
form.symbol.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    doDetect();
  }
});
