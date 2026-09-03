'use strict';

const STORAGE_KEY = 'smootherConfig';
const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  showPageWidget: true,
  bufferViewports: 4,
  minAnswers: 12,
});
const BUFFER_LABELS = Object.freeze({
  2: '精简',
  4: '均衡',
  6: '稳妥',
});

let currentConfig = { ...DEFAULT_CONFIG };
let activeTab = null;
let statusRequestId = 0;
let lastStats = null;

const elements = {};

document.addEventListener('DOMContentLoaded', initialize);

function initialize() {
  elements.enabledToggle = document.getElementById('enabled-toggle');
  elements.toggleHint = document.getElementById('toggle-hint');
  elements.widgetToggle = document.getElementById('show-page-widget-toggle');
  elements.widgetToggleHint = document.getElementById('widget-toggle-hint');
  elements.bufferValue = document.getElementById('buffer-value');
  elements.bufferInputs = Array.from(document.querySelectorAll('input[name="bufferViewports"]'));
  elements.statusDot = document.getElementById('status-dot');
  elements.statusTitle = document.getElementById('status-title');
  elements.statusRule = document.getElementById('status-rule');
  elements.statsText = document.getElementById('stats-text');
  elements.totalAnswers = document.getElementById('total-answers');
  elements.parkedAnswers = document.getElementById('parked-answers');
  elements.liveAnswers = document.getElementById('live-answers');
  elements.restoreButton = document.getElementById('restore-button');
  elements.feedback = document.getElementById('feedback');

  elements.enabledToggle.addEventListener('change', handleEnabledChange);
  elements.widgetToggle.addEventListener('change', handleWidgetChange);
  elements.bufferInputs.forEach((input) => input.addEventListener('change', handleBufferChange));
  elements.restoreButton.addEventListener('click', restoreAllAnswers);

  loadConfig(() => {
    renderConfig();
    findActiveTab(requestStatus);
  });
}

function loadConfig(done) {
  try {
    chrome.storage.sync.get(STORAGE_KEY, (result) => {
      const error = getRuntimeError();
      if (!error && result && result[STORAGE_KEY]) {
        currentConfig = normalizeConfig(result[STORAGE_KEY]);
      }
      done();
    });
  } catch (error) {
    done();
  }
}

function normalizeConfig(value) {
  const raw = value && typeof value === 'object' ? value : {};
  const parsedBuffer = Number(raw.bufferViewports);
  return {
    enabled: raw.enabled !== false,
    showPageWidget: raw.showPageWidget !== false,
    bufferViewports: BUFFER_LABELS[parsedBuffer] ? parsedBuffer : DEFAULT_CONFIG.bufferViewports,
    minAnswers: DEFAULT_CONFIG.minAnswers,
  };
}

function renderConfig() {
  elements.enabledToggle.checked = currentConfig.enabled;
  elements.toggleHint.textContent = currentConfig.enabled
    ? '在知乎回答页启用流畅加载'
    : '已暂停优化，不影响知乎原本加载';
  elements.widgetToggle.checked = currentConfig.showPageWidget;

  elements.bufferInputs.forEach((input) => {
    input.checked = Number(input.value) === currentConfig.bufferViewports;
  });
  elements.bufferValue.textContent = `${BUFFER_LABELS[currentConfig.bufferViewports]} · 上下各 ${currentConfig.bufferViewports} 屏`;
}

function handleEnabledChange() {
  saveConfig({ ...currentConfig, enabled: elements.enabledToggle.checked });
}

function handleWidgetChange() {
  saveConfig({ ...currentConfig, showPageWidget: elements.widgetToggle.checked });
}

function handleBufferChange(event) {
  const bufferViewports = Number(event.target.value);
  if (BUFFER_LABELS[bufferViewports]) {
    saveConfig({ ...currentConfig, bufferViewports });
  }
}

function saveConfig(nextConfig) {
  currentConfig = normalizeConfig(nextConfig);
  renderConfig();
  clearFeedback();

  try {
    chrome.storage.sync.set({ [STORAGE_KEY]: currentConfig }, () => {
      const error = getRuntimeError();
      if (error) {
        showFeedback('设置暂时无法保存');
        return;
      }
      sendToActiveTab(
        { type: 'UPDATE_CONFIG', config: { ...currentConfig } },
        requestStatus,
      );
    });
  } catch (error) {
    showFeedback('设置暂时无法保存');
  }
}

function findActiveTab(done) {
  try {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (getRuntimeError() || !Array.isArray(tabs) || !tabs[0]) {
        activeTab = null;
      } else {
        activeTab = tabs[0];
      }
      done();
    });
  } catch (error) {
    activeTab = null;
    done();
  }
}

function requestStatus() {
  const requestId = ++statusRequestId;
  lastStats = null;
  elements.restoreButton.disabled = true;

  if (!activeTab || typeof activeTab.id !== 'number') {
    renderWaitingState();
    return;
  }

  sendToActiveTab({ type: 'GET_STATUS' }, (response) => {
    if (requestId !== statusRequestId) return;
    if (response && response.ok === true && response.supportedPage === true) {
      renderSupportedState(response.stats);
    } else {
      renderWaitingState();
    }
  });
}

function renderSupportedState(stats) {
  const safeStats = stats && typeof stats === 'object' ? stats : {};
  lastStats = safeStats;
  const enabled = typeof safeStats.enabled === 'boolean' ? safeStats.enabled : currentConfig.enabled;
  const total = toCount(safeStats.total);
  const parked = toCount(safeStats.parked);
  const live = toCount(safeStats.live);

  elements.enabledToggle.checked = enabled;
  if (!enabled && currentConfig.enabled) {
    elements.toggleHint.textContent = '本页已恢复；重新开启即可继续优化';
  }
  elements.statusTitle.textContent = enabled ? '此页已优化' : '已暂停';
  elements.statusRule.textContent = enabled ? '运行中' : '已关闭';
  elements.statusDot.classList.toggle('is-ready', enabled);
  elements.statusDot.classList.toggle('is-paused', !enabled);
  elements.statsText.textContent = `${total} 个回答 · 冻结 ${parked}`;
  elements.totalAnswers.textContent = total;
  elements.parkedAnswers.textContent = parked;
  elements.liveAnswers.textContent = live;
  elements.restoreButton.disabled = !enabled || parked === 0;
}

function renderWaitingState() {
  elements.statusTitle.textContent = '正在等待知乎回答页';
  elements.statusRule.textContent = '待机';
  elements.statusDot.classList.remove('is-ready', 'is-paused');
  elements.statsText.textContent = '仅在知乎长回答页工作';
  elements.totalAnswers.textContent = '—';
  elements.parkedAnswers.textContent = '—';
  elements.liveAnswers.textContent = '—';
  elements.restoreButton.disabled = true;
}

function restoreAllAnswers() {
  if (!activeTab || typeof activeTab.id !== 'number') return;
  elements.restoreButton.disabled = true;
  elements.restoreButton.textContent = '正在恢复…';
  clearFeedback();
  sendToActiveTab({ type: 'RESTORE_ALL' }, () => {
    elements.restoreButton.textContent = '恢复本页全部回答';
    requestStatus();
  });
}

function sendToActiveTab(message, done) {
  if (!activeTab || typeof activeTab.id !== 'number') {
    if (done) done(null);
    return;
  }

  try {
    chrome.tabs.sendMessage(activeTab.id, message, (response) => {
      const error = getRuntimeError();
      if (done) done(error ? null : response);
    });
  } catch (error) {
    if (done) done(null);
  }
}

function toCount(value) {
  const count = Number(value);
  return Number.isFinite(count) && count >= 0 ? Math.floor(count) : 0;
}

function getRuntimeError() {
  try {
    return chrome.runtime && chrome.runtime.lastError;
  } catch (error) {
    return null;
  }
}

function clearFeedback() {
  elements.feedback.textContent = '';
}

function showFeedback(message) {
  elements.feedback.textContent = message;
}
