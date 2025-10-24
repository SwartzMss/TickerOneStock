// Local-only suggest; no default remote index URL

const DEFAULT_CONFIG = {
  symbol: 'sh000300',
  bubbleOpacity: 1,
  bubbleSize: { width: 60, height: 60 },
  bubblePosition: { x: 24, y: 24 },
  theme: 'auto'
};

const form = document.getElementById('options-form');
const btnSave = document.getElementById('btn-save');
const statusEl = document.getElementById('status');
const searchResults = document.getElementById('search-results');
const btnRefreshEastmoney = document.getElementById('btn-refresh-eastmoney');
const eastmoneyStatusEl = document.getElementById('eastmoney-status');
const btnExportIndex = document.getElementById('btn-export-index');
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
  const keys = [...Object.keys(DEFAULT_CONFIG), 'symbolName'];
  const syncValues = await storageGet('sync', keys);
  const config = { ...DEFAULT_CONFIG, ...syncValues };
  if (DEBUG) console.log('[options] loadConfig syncValues=', syncValues);

  // Display as "Name  shxxxxxx" if we can resolve a name from local index or stored symbolName
  if (config.symbol && /^(sh|sz)\d{6}$/i.test(config.symbol)) {
    if (syncValues.symbolName) {
      form.symbol.value = `${syncValues.symbolName}  ${config.symbol}`;
    } else {
      try {
        const nm = await resolveNameForSymbol(config.symbol);
        form.symbol.value = nm ? `${nm}  ${config.symbol}` : (config.symbol || '');
        // Lightweight migration: persist symbolName if we could resolve it
        if (nm && hasChrome) {
          try { await storageSet('sync', { symbolName: nm }); } catch (_) {}
        }
      } catch (_) {
        form.symbol.value = config.symbol || '';
      }
    }
  } else {
    form.symbol.value = config.symbol || '';
  }
  form.bubbleWidth.value = config.bubbleSize?.width ?? DEFAULT_CONFIG.bubbleSize.width;
  // eastmoney status
  if (hasChrome && eastmoneyStatusEl) {
    const local = await new Promise((resolve) => chrome.storage.local.get(['stockIndexUpdatedAt', 'stockIndexLastStatus', 'stockIndexLastError', 'stockIndex'], resolve));
    const cnt = Array.isArray(local.stockIndex) ? local.stockIndex.length : 0;
    const when = local.stockIndexUpdatedAt ? new Date(local.stockIndexUpdatedAt).toLocaleString() : '从未';
    const status = local.stockIndexLastStatus || (cnt > 0 ? 'success' : 'unknown');
    if (status === 'success') {
      eastmoneyStatusEl.textContent = `成功，${when}，共 ${cnt} 条`;
      eastmoneyStatusEl.style.color = '';
      eastmoneyStatusEl.dataset.status = 'success';
    } else if (status === 'fail') {
      // 不展示英文错误详情，保持简洁
      eastmoneyStatusEl.textContent = `失败，${when}`;
      eastmoneyStatusEl.style.color = '';
      eastmoneyStatusEl.dataset.status = 'fail';
    } else {
      eastmoneyStatusEl.textContent = `未知，${when}`;
      eastmoneyStatusEl.style.color = '';
      eastmoneyStatusEl.dataset.status = 'unknown';
    }
    // 导出按钮：只有在至少一次成功获取并且有数据时才可用
    if (btnExportIndex) {
      btnExportIndex.disabled = !(status === 'success' && cnt > 0);
      btnExportIndex.title = btnExportIndex.disabled ? '需先成功获取一次全量索引' : '';
    }
  }
}

// removed legacy parse/serialize helpers

async function handleSubmit(event) {
  event.preventDefault();
  if (!hasChrome) {
    showStatus('当前页面未在扩展环境中运行，无法保存配置。', 'error');
    return;
  }
  if (btnSave?.getAttribute('aria-busy') === 'true') {
    return; // 防抖：保存进行中
  }
  // 进入加载态
  if (btnSave) {
    btnSave.disabled = true;
    btnSave.classList.add('is-loading');
    btnSave.setAttribute('aria-busy', 'true');
    btnSave.textContent = '保存中…';
  }
  // Ensure we save a normalized symbol (sh/sz+code)
  try {
    const { symbol: normalized, name: resolvedName } = await ensureNormalizedBeforeSave();
    form.symbol.value = resolvedName ? `${resolvedName}  ${normalized}` : normalized;
    if (DEBUG) console.log('[options] normalized before save =', { normalized, resolvedName });
    // Save normalized symbol + optional symbolName for fast display
    const bubbleWidth = Number(form.bubbleWidth.value) || DEFAULT_CONFIG.bubbleSize.width;
    await storageSet('sync', { symbol: normalized, symbolName: resolvedName, bubbleSize: { width: bubbleWidth } });
    showStatus('已保存，后台将在下个周期使用新配置刷新。');
    return;
  } catch (e) {
    showStatus('无法识别该标的，请更换关键词', 'error');
    if (DEBUG) console.log('[options] normalize failed', e);
    return;
  } finally {
    if (btnSave) {
      btnSave.disabled = false;
      btnSave.classList.remove('is-loading');
      btnSave.removeAttribute('aria-busy');
      btnSave.textContent = '保存配置';
    }
  }
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
      return stockIndex;
    }
  }
  // 2) Fallback to packaged stocks.json
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
    .map((s) => `<div class="search-item" role="option" data-sym="${s.market}${s.code}" data-name="${s.name}"><span class="search-item__name">${s.name}</span><span class="search-item__meta">${s.market}${s.code}</span></div>`) 
    .join('');
  searchResults.style.display = 'block';
}

async function doSearch() {
  const raw = form.symbol.value.trim();
  if (raw.length < 1) {
    searchResults.style.display = 'none';
    searchResults.innerHTML = '';
    return;
  }
  // Local-only suggest using cached full index
  const idx = await ensureStockIndex();
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
    showStatus(`已选择 ${nm || sym}`);
  }
  searchResults.style.display = 'none';
});

form.symbol.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    // On Enter, do not auto-select the first suggestion to avoid mismatches.
    // Let the form submit naturally and rely on handleSubmit normalization.
    searchResults.style.display = 'none';
  }
});

// Online suggest removed

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
  // 1) If input contains a standard code anywhere (e.g., "名称  sh600519"), trust that selection
  const m = val.match(/(sh|sz)\d{6}/i);
  if (m) {
    const sym = m[0].toLowerCase();
    const name = await resolveNameForSymbol(sym).catch(() => undefined);
    return { symbol: sym, name };
  }
  // 2) Pure standard code
  if (/^(sh|sz)\d{6}$/i.test(val)) {
    return { symbol: val.toLowerCase(), name: undefined };
  }
  // 3) Exact match by name or exact 6-digit code
  const idx = await ensureStockIndex();
  const key = val.toLowerCase();
  const match = idx.find((s) => s.name.toLowerCase() === key || s.code === val);
  if (match) {
    const sym = `${match.market}${match.code}`.toLowerCase();
    return { symbol: sym, name: match.name };
  }
  // 4) Heuristic: 6-digit code without market prefix
  const sym2 = normalizeCodeToSymbol(val);
  if (sym2) {
    return { symbol: sym2, name: undefined };
  }
  throw new Error('no-match');
}

async function resolveNameForSymbol(sym) {
  const idx = await ensureStockIndex();
  const item = idx.find((s) => `${s.market}${s.code}`.toLowerCase() === sym.toLowerCase());
  return item?.name;
}

// Legacy external refresh removed

// legacy refresh button removed

// Manual refresh via Eastmoney
// duplicate handler removed

// Export local index as JSON
btnExportIndex?.addEventListener('click', async () => {
  if (!hasChrome) { showStatus('仅在扩展环境中可用', 'error'); return; }
  const local = await new Promise((resolve) => chrome.storage.local.get(['stockIndex', 'stockIndexLastStatus'], resolve));
  const list = Array.isArray(local.stockIndex) ? local.stockIndex : [];
  const ok = local.stockIndexLastStatus === 'success' && list.length > 0;
  if (!ok) { showStatus('尚未成功获取，无法导出', 'error'); return; }
  const blob = new Blob([JSON.stringify(list, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const now = new Date();
  const y = String(now.getFullYear());
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const filename = `stocks-${y}${m}${d}.json`;
  try {
    await chrome.downloads.download({ url, filename, saveAs: true });
    showStatus('已导出 JSON 文件');
  } catch (e) {
    showStatus('导出失败，请检查下载权限', 'error');
  } finally {
    URL.revokeObjectURL(url);
  }
});
// Manual refresh via Eastmoney
btnRefreshEastmoney?.addEventListener('click', () => {
  if (!hasChrome) { showStatus('仅在扩展环境中可用', 'error'); return; }
  btnRefreshEastmoney.disabled = true;
  btnRefreshEastmoney.classList.add('is-loading');
  btnRefreshEastmoney.setAttribute('aria-busy', 'true');
  btnRefreshEastmoney.textContent = '获取中…';
  chrome.runtime.sendMessage({ type: 'REFRESH_STOCK_INDEX' }, (res) => {
    btnRefreshEastmoney.disabled = false;
    btnRefreshEastmoney.classList.remove('is-loading');
    btnRefreshEastmoney.removeAttribute('aria-busy');
    btnRefreshEastmoney.textContent = '手动获取/更新';
    if (res && res.ok) {
      showStatus(`已更新 ${res.size || 0} 条`);
    } else {
      // fallback: try fetching in options page context
      btnRefreshEastmoney.disabled = true;
      btnRefreshEastmoney.classList.add('is-loading');
      btnRefreshEastmoney.setAttribute('aria-busy', 'true');
      refreshIndexFromEastmoneyInPage().then((ok) => {
        if (ok) showStatus('已更新（页内拉取）');
        else {
          // 不展示英文错误详情
          showStatus('获取失败，请稍后重试', 'error');
          if (DEBUG) console.warn('[options] refresh failed:', res && res.error);
        }
        loadConfig();
      }).finally(() => {
        btnRefreshEastmoney.disabled = false;
        btnRefreshEastmoney.classList.remove('is-loading');
        btnRefreshEastmoney.removeAttribute('aria-busy');
        btnRefreshEastmoney.textContent = '手动获取/更新';
      });
      return;
    }
    // refresh status line
    loadConfig();
  });
});

// Fallback Eastmoney fetch in options page context
async function refreshIndexFromEastmoneyInPage() {
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
          if (/^\d{6}$/.test(code) && name) all.push({ code, name });
        }
        pn += 1;
      }
    }
    const cleaned = all
      .filter((x) => /^\d{6}$/.test(x.code) && x.name)
      .map((x) => ({ market: x.code.startsWith('6') ? 'sh' : 'sz', code: x.code, name: x.name }));
    const uniqMap = new Map();
    for (const it of cleaned) uniqMap.set(`${it.market}${it.code}`, it);
    const finalList = Array.from(uniqMap.values());
    await new Promise((resolve) => chrome.storage.local.set({ stockIndex: finalList, stockIndexUpdatedAt: Date.now(), stockIndexLastStatus: 'success', stockIndexLastError: '' }, resolve));
    return true;
  } catch (e) {
    await new Promise((resolve) => chrome.storage.local.set({ stockIndexUpdatedAt: Date.now(), stockIndexLastStatus: 'fail', stockIndexLastError: String(e && e.message ? e.message : e) }, resolve));
    return false;
  }
}
