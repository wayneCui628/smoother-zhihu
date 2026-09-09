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

test("onRouteChange schedules retry timers if new answer list root is not yet rendered", () => {
  const runtimeMessages = createEvent();
  const storageChanges = createEvent();
  const timeouts = [];
  const window = {
    location: { href: "https://www.zhihu.com/question/1" },
    addEventListener(type, listener) {
      if (type === "popstate") {
        this.popstateListener = listener;
      }
    },
    removeEventListener() {},
    setTimeout(callback, delay) {
      timeouts.push({ callback, delay });
      return timeouts.length;
    },
    clearTimeout() {},
  };
  const document = { defaultView: window, hidden: false };
  let rescans = 0;
  const virtualizer = {
    started: true,
    listRoot: null,
    config: { enabled: true, bufferViewports: 4, minAnswers: 12, showPageWidget: true },
    getStats() {
      return { total: 0, parked: 0, live: 0, enabled: true };
    },
    getConfig() {
      return { ...this.config };
    },
    updateConfig() {},
    rescan() {
      rescans += 1;
    },
    destroy() {},
  };
  const controller = createController({
    chrome: {
      runtime: { onMessage: runtimeMessages },
      storage: {
        sync: {
          get(_keys, callback) {
            callback({ [STORAGE_KEY]: { enabled: true, bufferViewports: 4, minAnswers: 12 } });
          },
          set() {},
        },
        onChanged: storageChanges,
      },
    },
    document,
    window,
    virtualizerApi: {
      normalizeConfig(value) {
        return value;
      },
      createVirtualizer() {
        return virtualizer;
      },
    },
  });

  window.location.href = "https://www.zhihu.com/question/2";
  window.popstateListener();

  assert.equal(rescans, 1, "immediately tries once");
  assert.equal(timeouts.length, 4, "schedules 4 backoff retries when listRoot is missing");
  assert.deepEqual(timeouts.map((item) => item.delay), [150, 400, 900, 1800]);

  virtualizer.listRoot = {};
  timeouts[0].callback();

  controller.destroy();
});

function createWidgetGateHarness() {
  let storageCallback;
  const runtimeMessages = createEvent();
  const storageChanges = createEvent();
  const window = {
    location: { href: "https://www.zhihu.com/question/slow-widget" },
    addEventListener() {},
    removeEventListener() {},
    setInterval(callback) {
      this.intervalCallback = callback;
      return 51;
    },
    clearInterval(id) {
      this.clearedInterval = id;
    },
    setTimeout(callback) {
      this.timeoutCallback = callback;
      return 52;
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
    setVisible(value) {
      this.visibility.push(value);
    },
    update(stats, config) {
      this.updates.push({ stats: { ...stats }, config: { ...config } });
    },
    reposition() {},
    destroy() {},
  };
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
      this.config = { ...this.config, ...config };
      this.started = this.config.enabled;
      return this.getStats();
    },
    rescan() {},
    destroy() {},
  };
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
    // The virtualizer is created through the API (not injected), so the
    // controller starts with configReady === false just like a real page.
    virtualizerApi: {
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
    },
    pageWidget,
  });
  return {
    controller,
    pageWidget,
    window,
    fireStoredConfig(config) {
      storageCallback({ [STORAGE_KEY]: config });
    },
  };
}

test("page widget stays hidden until the stored config arrives, then follows it", () => {
  const harness = createWidgetGateHarness();

  // Before the async storage read resolves, the controller must not touch
  // widget visibility at all: the widget boots hidden, so a saved "hide
  // widget" setting can never flash it on page load.
  harness.window.intervalCallback();
  assert.deepEqual(harness.pageWidget.visibility, []);
  assert.equal(harness.pageWidget.updates.length, 0);

  harness.fireStoredConfig({
    enabled: true,
    bufferViewports: 4,
    minAnswers: 12,
    showPageWidget: true,
  });
  assert.equal(harness.pageWidget.visibility.at(-1), true);
  assert.equal(harness.pageWidget.updates.length, 1);

  harness.window.intervalCallback();
  assert.equal(harness.pageWidget.visibility.at(-1), true, "stays visible on later ticks");

  harness.controller.destroy();
});

test("page widget never becomes visible when the stored config hides it", () => {
  const harness = createWidgetGateHarness();

  harness.window.intervalCallback();
  assert.deepEqual(harness.pageWidget.visibility, []);

  harness.fireStoredConfig({
    enabled: true,
    bufferViewports: 4,
    minAnswers: 12,
    showPageWidget: false,
  });
  assert.deepEqual(harness.pageWidget.visibility, [false]);
  assert.equal(harness.pageWidget.updates.length, 0, "hidden widget is not rendered");

  harness.window.intervalCallback();
  assert.equal(harness.pageWidget.visibility.includes(true), false, "never flashes visible");

  harness.controller.destroy();
});

function createRouteHarness() {
  const runtimeMessages = createEvent();
  const storageChanges = createEvent();
  const timeouts = [];
  const clearedTimeouts = [];
  const window = {
    location: { href: "https://www.zhihu.com/question/1" },
    addEventListener(type, listener) {
      if (type === "popstate") {
        this.popstateListener = listener;
      }
    },
    removeEventListener() {},
    setTimeout(callback, delay) {
      timeouts.push({ callback, delay });
      return timeouts.length;
    },
    clearTimeout(id) {
      clearedTimeouts.push(id);
    },
  };
  const document = {
    defaultView: window,
    hidden: false,
    answersContainer: null,
    querySelector(selector) {
      return selector === ".QuestionAnswers-answers" ? this.answersContainer : null;
    },
  };
  let rescans = 0;
  const virtualizer = {
    started: true,
    listRoot: null,
    config: { enabled: true, bufferViewports: 4, minAnswers: 12, showPageWidget: true },
    getStats() {
      return { total: 0, parked: 0, live: 0, enabled: true };
    },
    getConfig() {
      return { ...this.config };
    },
    updateConfig() {},
    rescan() {
      rescans += 1;
      // Mirror the real virtualizer: a rescan re-attaches the list root only
      // when the answers structure exists in the DOM.
      if (document.answersContainer) {
        this.listRoot = document.answersContainer;
      }
    },
    destroy() {},
  };
  const controller = createController({
    chrome: {
      runtime: { onMessage: runtimeMessages },
      storage: {
        sync: {
          get(_keys, callback) {
            callback({ [STORAGE_KEY]: { enabled: true, bufferViewports: 4, minAnswers: 12 } });
          },
          set() {},
        },
        onChanged: storageChanges,
      },
    },
    document,
    window,
    virtualizerApi: {
      normalizeConfig(value) {
        return value;
      },
      createVirtualizer() {
        return virtualizer;
      },
    },
  });
  return {
    controller,
    window,
    document,
    virtualizer,
    timeouts,
    clearedTimeouts,
    rescanCount: () => rescans,
  };
}

test("deep-link route retries skip full rescans while the answers container is absent", () => {
  const harness = createRouteHarness();
  harness.window.location.href = "https://www.zhihu.com/question/1/answer/9";
  harness.window.popstateListener();

  assert.equal(harness.rescanCount(), 1, "initial sync performs exactly one full rescan");
  assert.equal(harness.timeouts.length, 4);
  assert.deepEqual(harness.timeouts.map((item) => item.delay), [150, 400, 900, 1800]);

  for (const item of harness.timeouts) {
    item.callback();
  }
  assert.equal(
    harness.rescanCount(),
    1,
    "container-less deep-link view must not pay for retry rescans",
  );

  harness.controller.destroy();
});

test("route retries resume full rescans once the answers container appears", () => {
  const harness = createRouteHarness();
  harness.window.location.href = "https://www.zhihu.com/question/1/answer/9";
  harness.window.popstateListener();

  assert.equal(harness.rescanCount(), 1);
  assert.equal(harness.timeouts.length, 4);

  // The user switches to the full answer list ("view all answers") and the
  // container mounts before the first retry fires.
  harness.document.answersContainer = {};
  harness.timeouts[0].callback();

  assert.equal(harness.rescanCount(), 2, "the retry performs a full rescan and recovers");
  assert.equal(
    harness.virtualizer.listRoot,
    harness.document.answersContainer,
    "virtualization re-attaches to the list root",
  );
  assert.deepEqual(
    harness.clearedTimeouts,
    [1, 2, 3, 4],
    "remaining retries are cleared after recovery",
  );

  harness.controller.destroy();
});
