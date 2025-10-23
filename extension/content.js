const DEFAULT_BUBBLE_STATE = {
  collapsed: false,
  hidden: false,
  bubblePosition: { x: 24, y: 24 },
  bubbleSize: { width: 120, height: 120 }
};

let bubbleState = { ...DEFAULT_BUBBLE_STATE };
let config = null;
let quote = null;
let bubbleEl = null;
let reopenButton = null;
let priceEl = null;
let changeEl = null;
let nameEl = null;
let timeEl = null;
let bodyEl = null;
let storageListenerAttached = false;
let prefersDarkMedia = null;
let prefersDarkListener = null;
let changeCycleTimer = null;
let showPercent = false;

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function formatNumber(value, digits = 2) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return '--';
  }
  return value.toFixed(digits);
}

function formatChange(change, percent) {
  if (typeof change !== 'number' || Number.isNaN(change)) {
    return '--';
  }
  const sign = change > 0 ? '+' : '';
  const percentText = typeof percent === 'number' && !Number.isNaN(percent)
    ? ` (${sign}${percent.toFixed(2)}%)`
    : '';
  return `${sign}${change.toFixed(2)}${percentText}`;
}

function applyBubblePosition() {
  if (!bubbleEl) return;
  const { x, y } = bubbleState.bubblePosition;
  bubbleEl.style.left = `${x}px`;
  bubbleEl.style.top = `${y}px`;
}

function applyBubbleSize() {
  if (!bubbleEl) return;
  const { width, height } = bubbleState.bubbleSize;
  bubbleEl.style.width = `${width}px`;
  if (bubbleEl.classList.contains('tos-round')) {
    // enforce circle by making height = width
    bubbleEl.style.height = `${width}px`;
    updateAdaptiveFontSize(width);
  } else {
    bubbleEl.style.height = bubbleState.collapsed ? '' : `${height}px`;
    updateAdaptiveFontSize(height);
  }
}

function applyCollapsedState() {
  if (!bubbleEl || !bodyEl) return;
  if (bubbleState.collapsed) {
    bubbleEl.classList.add('tos-collapsed');
    bodyEl.style.display = 'none';
  } else {
    bubbleEl.classList.remove('tos-collapsed');
    bodyEl.style.display = '';
  }
  applyBubbleSize();
}

function applyHiddenState() {
  if (!bubbleEl) return;
  bubbleEl.style.display = bubbleState.hidden ? 'none' : 'flex';
}

function updateTheme() {
  if (!bubbleEl) return;
  if (config?.theme === 'dark') {
    bubbleEl.classList.add('tos-dark');
  } else if (config?.theme === 'light') {
    bubbleEl.classList.remove('tos-dark');
  } else {
    const prefersDark = prefersDarkMedia ? prefersDarkMedia.matches : window.matchMedia('(prefers-color-scheme: dark)').matches;
    bubbleEl.classList.toggle('tos-dark', prefersDark);
  }
}

function forceRoundMode() {
  if (!bubbleEl) return;
  bubbleEl.classList.add('tos-round');
  applyBubbleSize();
}

function updateOpacity() {
  if (!bubbleEl) return;
  bubbleEl.style.opacity = config?.bubbleOpacity ?? 0.95;
}

function updateQuoteDisplay() {
  if (!quote || !bubbleEl) {
    return;
  }
  if (nameEl) {
    nameEl.textContent = `${quote.name || quote.symbol}`;
  }
  // Price is not displayed anymore
  if (changeEl) {
    // Always cycle between absolute change and percent (numbers only, no sign, no %)
    const absVal = (typeof quote.change === 'number' && !Number.isNaN(quote.change))
      ? Math.abs(quote.change).toFixed(2)
      : '--';
    const pctVal = (typeof quote.changePercent === 'number' && !Number.isNaN(quote.changePercent))
      ? Math.abs(quote.changePercent).toFixed(2)
      : '--';
    changeEl.textContent = showPercent ? pctVal : absVal;
    changeEl.style.color = quote.color || '';
  }
  const providerEl = bubbleEl.querySelector('.tos-provider');
  if (providerEl && quote?.provider) {
    providerEl.textContent = `数据源：${quote.provider}`;
  }
  if (timeEl) {
    const date = new Date(quote.updatedAt || Date.now());
    if (quote.time && !Number.isNaN(Date.parse(quote.time.replace(/-/g, '/')))) {
      timeEl.textContent = quote.time;
    } else {
      timeEl.textContent = `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`;
    }
  }
  bubbleEl.dataset.direction = quote.direction || 'flat';
}

function setupChangeCycle() {
  // Clear any existing timer
  if (changeCycleTimer) {
    clearInterval(changeCycleTimer);
    changeCycleTimer = null;
  }
  // Always cycle every 3s
  changeCycleTimer = setInterval(() => {
    showPercent = !showPercent;
    updateQuoteDisplay();
  }, 3000);
}

function updateAdaptiveFontSize(diameter) {
  if (!changeEl) return;
  const d = Math.max(20, Number(diameter) || 120);
  // Scale roughly with diameter; clamp for readability
  const px = Math.max(12, Math.min(32, Math.round(d * 0.2)));
  changeEl.style.fontSize = `${px}px`;
  changeEl.style.lineHeight = '1.05';
}

function persistBubbleState(updates) {
  bubbleState = { ...bubbleState, ...updates };
  chrome.runtime.sendMessage({ type: 'SAVE_BUBBLE_STATE', payload: bubbleState });
}

function persistPosition(x, y) {
  const bounded = {
    x: clamp(x, 0, Math.max(0, window.innerWidth - bubbleEl.offsetWidth)),
    y: clamp(y, 0, Math.max(0, window.innerHeight - bubbleEl.offsetHeight))
  };
  persistBubbleState({ bubblePosition: bounded });
  applyBubblePosition();
}

function createReopenButton() {
  // 按钮已移除：通过浏览器图标或快捷键切换显示
  return;
}

function setupDrag(handleEl) {
  let dragging = false;
  let offsetX = 0;
  let offsetY = 0;

  handleEl.addEventListener('mousedown', (event) => {
    if (event.button !== 0) return;
    if (event.target.closest('.tos-actions')) return;
    dragging = true;
    offsetX = event.clientX - bubbleEl.offsetLeft;
    offsetY = event.clientY - bubbleEl.offsetTop;
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  });

  function onMouseMove(event) {
    if (!dragging) return;
    const newX = event.clientX - offsetX;
    const newY = event.clientY - offsetY;
    bubbleEl.style.left = `${newX}px`;
    bubbleEl.style.top = `${newY}px`;
  }

  function onMouseUp(event) {
    if (!dragging) return;
    dragging = false;
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
    persistPosition(event.clientX - offsetX, event.clientY - offsetY);
  }
}

function createBubble() {
  if (bubbleEl) return;

  bubbleEl = document.createElement('div');
  bubbleEl.className = 'tos-bubble';
  bubbleEl.dataset.direction = 'flat';
  updateOpacity();

  const header = document.createElement('div');
  header.className = 'tos-header';

  nameEl = document.createElement('div');
  nameEl.className = 'tos-name';
  nameEl.textContent = config?.symbol || '---';

  timeEl = document.createElement('div');
  timeEl.className = 'tos-time';

  const actionsEl = document.createElement('div');
  actionsEl.className = 'tos-actions';

  const collapseBtn = document.createElement('button');
  collapseBtn.type = 'button';
  collapseBtn.className = 'tos-action-btn';
  collapseBtn.title = '折叠/展开';
  collapseBtn.innerHTML = '&#8211;';
  collapseBtn.addEventListener('click', () => {
    bubbleState.collapsed = !bubbleState.collapsed;
    applyCollapsedState();
    persistBubbleState({ collapsed: bubbleState.collapsed });
  });

  const refreshBtn = document.createElement('button');
  refreshBtn.type = 'button';
  refreshBtn.className = 'tos-action-btn';
  refreshBtn.title = '立即刷新';
  refreshBtn.innerHTML = '&#x21bb;';
  refreshBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'REQUEST_REFRESH' });
  });

  const hideBtn = document.createElement('button');
  hideBtn.type = 'button';
  hideBtn.className = 'tos-action-btn';
  hideBtn.title = '隐藏气泡';
  hideBtn.innerHTML = '&#10005;';
  hideBtn.addEventListener('click', () => {
    bubbleState.hidden = true;
    applyHiddenState();
    persistBubbleState({ hidden: true });
  });

  actionsEl.append(collapseBtn, refreshBtn, hideBtn);
  header.append(nameEl, timeEl, actionsEl);

  bodyEl = document.createElement('div');
  bodyEl.className = 'tos-body';

  priceEl = document.createElement('div');
  priceEl.className = 'tos-price';
  priceEl.textContent = '--';

  changeEl = document.createElement('div');
  changeEl.className = 'tos-change';
  changeEl.textContent = '--';

  const footer = document.createElement('div');
  footer.className = 'tos-footer';

  const providerEl = document.createElement('span');
  providerEl.className = 'tos-provider';
  footer.appendChild(providerEl);

  bodyEl.append(priceEl, changeEl, footer);
  bubbleEl.append(header, bodyEl);
  (document.body || document.documentElement).appendChild(bubbleEl);

  setupDrag(header);
  // allow dragging from the whole bubble (useful when round style hides header)
  setupDrag(bubbleEl);
  createReopenButton();
  applyBubblePosition();
  applyBubbleSize();
  applyCollapsedState();
  applyHiddenState();
  updateTheme();
  forceRoundMode();
  updateOpacity();
  updateQuoteDisplay();
  setupChangeCycle();
  updateAdaptiveFontSize(bubbleState.bubbleSize.width);

  if (quote?.provider && providerEl) {
    providerEl.textContent = `数据源：${quote.provider}`;
  }
}

function handleQuoteUpdate(message) {
  if (message.type !== 'QUOTE_UPDATE') return;
  quote = message.payload;
  if (bubbleEl) {
    const providerEl = bubbleEl.querySelector('.tos-provider');
    if (providerEl && quote?.provider) {
      providerEl.textContent = `数据源：${quote.provider}`;
    }
  }
  updateQuoteDisplay();
}

function attachMessageListener() {
  chrome.runtime.onMessage.addListener((message) => {
    handleQuoteUpdate(message);
    if (message && message.type === 'SET_ENABLED') {
      const enabled = !!message.payload?.enabled;
      bubbleState.hidden = !enabled;
      applyHiddenState();
      persistBubbleState({ hidden: bubbleState.hidden });
    }
  });
}

function attachStorageListener() {
  if (storageListenerAttached) return;
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'sync') {
      let shouldUpdateDisplay = false;
      let shouldUpdateOpacity = false;
      let shouldUpdateTheme = false;
      for (const [key, change] of Object.entries(changes)) {
        if (!change || typeof change.newValue === 'undefined') continue;
        if (key === 'bubbleOpacity') {
          config = { ...config, bubbleOpacity: change.newValue };
          shouldUpdateOpacity = true;
        } else if (key === 'bubbleSize') {
          const newSize = change.newValue || {};
          const width = Number(newSize.width) || bubbleState.bubbleSize.width;
          config = { ...config, bubbleSize: { width } };
          bubbleState = { ...bubbleState, bubbleSize: { width, height: width } };
          applyBubbleSize();
          persistBubbleState({ bubbleSize: bubbleState.bubbleSize });
        } else if (key === 'theme') {
          config = { ...config, theme: change.newValue };
          shouldUpdateTheme = true;
        } else if (key === 'symbol') {
          config = { ...config, symbol: change.newValue };
          if (nameEl) nameEl.textContent = change.newValue;
        }
      }
      if (shouldUpdateOpacity) {
        updateOpacity();
      }
      if (shouldUpdateTheme) {
        updateTheme();
      }
    }
    if (areaName === 'local' && changes.bubbleState?.newValue) {
      bubbleState = { ...bubbleState, ...changes.bubbleState.newValue };
      applyBubblePosition();
      applyBubbleSize();
      applyCollapsedState();
      applyHiddenState();
    }
    if (areaName === 'local' && changes.lastQuote?.newValue) {
      quote = changes.lastQuote.newValue;
      updateQuoteDisplay();
    }
  });
  storageListenerAttached = true;
}

async function bootstrap() {
  const [localState, initial] = await Promise.all([
    chrome.storage.local.get(['bubbleState', 'lastQuote']),
    new Promise((resolve) => chrome.runtime.sendMessage({ type: 'GET_INITIAL_STATE' }, resolve))
  ]);

  config = initial?.config || {};
  quote = initial?.quote || localState.lastQuote || null;
  bubbleState = {
    ...DEFAULT_BUBBLE_STATE,
    ...(localState.bubbleState || {})
  };

  createBubble();
  if (quote) {
    updateQuoteDisplay();
  }
  // 根据后台开关，控制是否显示
  if (typeof initial?.enabled === 'boolean') {
    bubbleState.hidden = !initial.enabled;
    applyHiddenState();
  }

  if (!prefersDarkMedia) {
    prefersDarkMedia = window.matchMedia('(prefers-color-scheme: dark)');
  }
  if (!prefersDarkListener) {
    prefersDarkListener = () => {
      if (config?.theme === 'auto') {
        updateTheme();
      }
    };
    prefersDarkMedia.addEventListener('change', prefersDarkListener);
  }

  attachMessageListener();
  attachStorageListener();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrap);
} else {
  bootstrap();
}
