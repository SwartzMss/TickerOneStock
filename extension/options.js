const DEFAULT_CONFIG = {
  symbol: 'sh000300',
  refreshInterval: 10,
  quoteProvider: 'tencent',
  bubbleOpacity: 0.95,
  bubbleSize: { width: 120, height: 120 },
  bubblePosition: { x: 24, y: 24 },
  theme: 'auto'
};

const form = document.getElementById('options-form');
const statusEl = document.getElementById('status');
const opacityInput = document.getElementById('bubbleOpacity');
const opacityValue = document.getElementById('opacityValue');
const resetBubbleBtn = document.getElementById('reset-bubble');
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
  form.refreshInterval.value = config.refreshInterval;
  form.quoteProvider.value = config.quoteProvider;
  form.bubbleWidth.value = config.bubbleSize?.width ?? DEFAULT_CONFIG.bubbleSize.width;
  form.bubbleHeight.value = config.bubbleSize?.height ?? DEFAULT_CONFIG.bubbleSize.height;
  form.theme.value = config.theme || 'auto';
  opacityInput.value = config.bubbleOpacity;
  opacityValue.textContent = Number(config.bubbleOpacity).toFixed(2);
}

function serializeForm() {
  const bubbleWidth = Number(form.bubbleWidth.value) || DEFAULT_CONFIG.bubbleSize.width;
  const bubbleHeight = Number(form.bubbleHeight.value) || DEFAULT_CONFIG.bubbleSize.height;
  return {
    symbol: form.symbol.value.trim(),
    refreshInterval: Math.max(3, Number(form.refreshInterval.value) || DEFAULT_CONFIG.refreshInterval),
    quoteProvider: form.quoteProvider.value,
    bubbleOpacity: Number(opacityInput.value),
    bubbleSize: { width: bubbleWidth, height: bubbleHeight },
    theme: form.theme.value
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

opacityInput.addEventListener('input', () => {
  opacityValue.textContent = Number(opacityInput.value).toFixed(2);
});

resetBubbleBtn.addEventListener('click', async () => {
  if (!hasChrome) {
    showStatus('当前页面未在扩展环境中运行，无法重置气泡。', 'error');
    return;
  }
  const defaultState = {
    collapsed: false,
    hidden: false,
    bubblePosition: { ...DEFAULT_CONFIG.bubblePosition },
    bubbleSize: { ...DEFAULT_CONFIG.bubbleSize }
  };
  await storageSet('local', { bubbleState: defaultState });
  chrome.runtime.sendMessage({ type: 'SAVE_BUBBLE_STATE', payload: defaultState });
  showStatus('已重置气泡位置与状态。');
});

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
