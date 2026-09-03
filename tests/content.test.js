const test = require("node:test");
const assert = require("node:assert/strict");

const { createController, STORAGE_KEY } = require("../src/content/content.js");

function createEvent() {
  const listeners = new Set();
  return {
    addListener(listener) {
      listeners.add(listener);
    },
    removeListener(listener) {
      listeners.delete(listener);
    },
    first() {
      return [...listeners][0];
    },
  };
}

function createHarness() {
  const runtimeMessages = createEvent();
  const storageChanges = createEvent();
  const writes = [];
  const storage = {
    get(_keys, callback) {
      callback({ [STORAGE_KEY]: { enabled: true, bufferViewports: 4, minAnswers: 12 } });
    },
    set(value) {
      writes.push(value);
    },
  };
  const chrome = {
    runtime: { onMessage: runtimeMessages },
    storage: { sync: storage, onChanged: storageChanges },
  };
  const window = {
    location: { href: "https://www.zhihu.com/question/1" },
    history: {},
    addEventListener() {},
    removeEventListener() {},
    setInterval(callback) {
      this.intervalCallback = callback;
      return 41;
    },
    clearInterval(id) {
      this.clearedInterval = id;
    },
    setTimeout(callback) {
      this.timeoutCallback = callback;
      return 42;
    },
    clearTimeout(id) {
      this.clearedTimeout = id;
    },
  };
  const document = {
    defaultView: window,
    hidden: false,
    addEventListener() {},
    removeEventListener() {},
  };
  const pageWidget = {
    visibility: [],
    updates: [],
    repositions: 0,
    destroyed: false,
    setVisible(value) {
      this.visibility.push(value);
    },
    update(stats, config) {
      this.updates.push({ stats: { ...stats }, config: { ...config } });
    },
    reposition() {
      this.repositions += 1;
    },
    destroy() {
      this.destroyed = true;
    },
  };
  const virtualizer = {
    started: true,
    config: { enabled: true, bufferViewports: 4, minAnswers: 12, showPageWidget: true },
    stats: { total: 30, parked: 18, live: 12, enabled: true },
    getStats() {
      return { ...this.stats };
    },
    getConfig() {
      return { ...this.config };
    },
    updateConfig(config) {
      this.config = { ...this.config, ...config };
      this.stats.enabled = this.config.enabled;
      this.started = this.config.enabled;
      return this.getStats();
    },
    stop() {
      this.started = false;
      this.stats = { ...this.stats, parked: 0, live: this.stats.total };
    },
    start() {
      this.started = true;
    },
    rescan() {},
    destroy() {},
  };
  const virtualizerApi = {
    normalizeConfig(value) {
      return {
        enabled: value.enabled !== false,
        bufferViewports: Number(value.bufferViewports) || 4,
        minAnswers: Number(value.minAnswers) || 12,
        showPageWidget: value.showPageWidget !== false,
      };
    },
    createVirtualizer() {
      return virtualizer;
    },
  };

  const controller = createController({
    chrome,
    document,
    window,
    virtualizer,
    virtualizerApi,
    pageWidget,
  });
  return { controller, listener: runtimeMessages.first(), pageWidget, virtualizer, window, writes };
}

function send(listener, message) {
  let response;
  listener(message, {}, (value) => {
    response = value;
  });
  return response;
}

test("GET_STATUS returns the popup response contract", () => {
  const harness = createHarness();
  const response = send(harness.listener, { type: "GET_STATUS" });

  assert.deepEqual(response, {
    ok: true,
    supportedPage: true,
    stats: { total: 30, parked: 18, live: 12, enabled: true },
  });
  harness.controller.destroy();
});

test("RESTORE_ALL pauses only this page and restores every parked answer", () => {
  const harness = createHarness();
  const response = send(harness.listener, { type: "RESTORE_ALL" });

  assert.equal(harness.virtualizer.started, false);
  assert.deepEqual(response.stats, { total: 30, parked: 0, live: 30, enabled: false });
  assert.equal(harness.writes.length, 0);
  harness.controller.destroy();
});

test("UPDATE_CONFIG applies and persists the shared smootherConfig key", () => {
  const harness = createHarness();
  const response = send(harness.listener, {
    type: "UPDATE_CONFIG",
    config: { enabled: false, bufferViewports: 6, minAnswers: 12, showPageWidget: true },
  });

  assert.equal(response.stats.enabled, false);
  assert.deepEqual(harness.writes.at(-1), {
    [STORAGE_KEY]: { enabled: false, bufferViewports: 6, minAnswers: 12, showPageWidget: true },
  });
  harness.controller.destroy();
});

test("page widget visibility follows config and destroy clears its interval", () => {
  const harness = createHarness();

  assert.equal(harness.pageWidget.visibility.at(-1), true);
  assert.equal(harness.pageWidget.updates.length, 1);

  send(harness.listener, {
    type: "UPDATE_CONFIG",
    config: { enabled: true, bufferViewports: 4, minAnswers: 12, showPageWidget: false },
  });
  assert.equal(harness.pageWidget.visibility.at(-1), false);

  harness.controller.destroy();
  assert.equal(harness.pageWidget.destroyed, true);
  assert.equal(harness.window.clearedInterval, 41);
});

test("controller repositions even when the stats snapshot is unchanged", () => {
  const harness = createHarness();
  const initial = harness.pageWidget.repositions;

  harness.window.intervalCallback();
  assert.equal(harness.pageWidget.repositions > initial, true);
  assert.equal(harness.pageWidget.updates.length, 1);
  harness.controller.destroy();
});

test("waits for stored config before starting or scanning a question page", () => {
  let storageCallback;
  let createdWith;
  const updates = [];
  const runtimeMessages = createEvent();
  const storageChanges = createEvent();
  const virtualizer = {
    started: false,
    config: { enabled: false, bufferViewports: 4, minAnswers: 12, showPageWidget: true },
    getStats() {
      return { total: 0, parked: 0, live: 0, enabled: this.config.enabled };
    },
    getConfig() {
      return { ...this.config };
    },
    updateConfig(config) {
      updates.push({ ...config });
      this.config = { ...this.config, ...config };
      this.started = this.config.enabled;
      return this.getStats();
    },
    rescan() {
      throw new Error("must not rescan before stored config is ready");
    },
    destroy() {},
  };
  const virtualizerApi = {
    normalizeConfig(value) {
      return {
        enabled: value.enabled !== false,
        bufferViewports: Number(value.bufferViewports) || 4,
        minAnswers: Number(value.minAnswers) || 12,
        showPageWidget: value.showPageWidget !== false,
      };
    },
    createVirtualizer(options) {
      createdWith = options;
      return virtualizer;
    },
  };
  const window = {
    location: { href: "https://www.zhihu.com/question/slow" },
    history: {},
    addEventListener() {},
    removeEventListener() {},
  };
  const document = { defaultView: window, hidden: false };
  const controller = createController({
    chrome: {
      runtime: { onMessage: runtimeMessages },
      storage: {
        sync: {
          get(_keys, callback) {
            storageCallback = callback;
          },
          set() {},
        },
        onChanged: storageChanges,
      },
    },
    document,
    window,
    virtualizerApi,
  });

  assert.equal(createdWith.autoStart, false);
  assert.equal(createdWith.config.enabled, false);
  assert.equal(virtualizer.started, false);
  assert.equal(updates.length, 0);

  storageCallback({
    [STORAGE_KEY]: { enabled: false, bufferViewports: 6, minAnswers: 12, showPageWidget: false },
  });

  assert.equal(updates.length, 1);
  assert.equal(updates[0].enabled, false);
  assert.equal(virtualizer.started, false);
  controller.destroy();
});
