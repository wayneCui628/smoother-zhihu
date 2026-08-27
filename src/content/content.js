/*
 * Runtime bridge for the dependency-free virtualizer. The concise message
 * protocol is:
 *   { type: "GET_STATUS" } -> { ok: true, supportedPage: true, stats: { total, parked, live, enabled } }
 *   { type: "UPDATE_CONFIG", config: { enabled?, bufferViewports?, minAnswers?, showPageWidget? } }
 *   { type: "RESTORE_ALL" } -> { ok: true, supportedPage: true, stats: { ... } }
 *
 * Config is stored under chrome.storage.sync["smootherConfig"]. For
 * compatibility with hand-edited settings, the reader also accepts a legacy
 * "virtualizerConfig"/"config" object or direct enabled/bufferViewports/
 * minAnswers keys.
 */
(function attachContentBridge(globalObject, factory) {
  let runtimeApi = globalObject && globalObject.ZhihuAnswerVirtualizer;
  // CommonJS is only used by node:test; Chromium executes this file as a
  // classic content script where require is unavailable.
  if (!runtimeApi && typeof module === "object" && module.exports && typeof require === "function") {
    try {
      runtimeApi = require("./virtualizer.js");
    } catch (_error) {
      runtimeApi = null;
    }
  }
  let pageWidgetApi = globalObject && globalObject.ZhihuSmootherPageWidget;
  if (!pageWidgetApi && typeof module === "object" && module.exports && typeof require === "function") {
    try {
      pageWidgetApi = require("./page-widget.js");
    } catch (_error) {
      pageWidgetApi = null;
    }
  }
  const api = factory(globalObject, runtimeApi, pageWidgetApi);

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function createContentBridge(globalObject, virtualizerApi, pageWidgetApi) {
  "use strict";

  const STORAGE_KEY = "smootherConfig";
  const LEGACY_STORAGE_KEY = "virtualizerConfig";
  const SECONDARY_LEGACY_STORAGE_KEY = "config";

  function getChrome(options) {
    return (options && options.chrome) || (globalObject && globalObject.chrome) || null;
  }

  function copyConfig(value, normalize) {
    if (!value || typeof value !== "object") {
      return normalize({});
    }
    return normalize(value);
  }

  function readStoredConfig(storage, normalize, onConfig) {
    if (!storage || typeof storage.get !== "function") {
      return;
    }

    const keys = [
      STORAGE_KEY,
      LEGACY_STORAGE_KEY,
      SECONDARY_LEGACY_STORAGE_KEY,
      "enabled",
      "bufferViewports",
      "minAnswers",
    ];
    let handled = false;
    const finish = (result) => {
      if (handled) {
        return;
      }
      handled = true;
      const values = result && typeof result === "object" ? result : {};
      const stored = values[STORAGE_KEY] ?? values[LEGACY_STORAGE_KEY] ?? values[SECONDARY_LEGACY_STORAGE_KEY];
      const candidate = stored && typeof stored === "object"
        ? stored
        : {
            enabled: values.enabled,
            bufferViewports: values.bufferViewports,
            minAnswers: values.minAnswers,
          };
      onConfig(copyConfig(candidate, normalize));
    };

    try {
      const maybePromise = storage.get(keys, finish);
      if (maybePromise && typeof maybePromise.then === "function") {
        maybePromise.then(finish).catch(() => undefined);
      }
    } catch (_error) {
      // Storage is optional at runtime; defaults remain active if unavailable.
    }
  }

  function persistConfig(storage, config) {
    if (!storage || typeof storage.set !== "function") {
      return;
    }

    try {
      const maybePromise = storage.set({ [STORAGE_KEY]: config });
      if (maybePromise && typeof maybePromise.catch === "function") {
        maybePromise.catch(() => undefined);
      }
    } catch (_error) {
      // A private/incognito context can reject sync storage. Keep memory state.
    }
  }

  function statusWithConfig(virtualizer) {
    const status = virtualizer && typeof virtualizer.getStats === "function"
      ? virtualizer.getStats()
      : { total: 0, parked: 0, live: 0, enabled: false };
    return {
      ...status,
      config: virtualizer && typeof virtualizer.getConfig === "function"
        ? virtualizer.getConfig()
        : undefined,
    };
  }

  function statusResponse(virtualizer) {
    const status = virtualizer && typeof virtualizer.getStats === "function"
      ? virtualizer.getStats()
      : { total: 0, parked: 0, live: 0, enabled: false };
    const active = Boolean(status.enabled && virtualizer && virtualizer.started);
    return {
      ok: true,
      supportedPage: true,
      stats: { ...status, enabled: active },
    };
  }

  function getMessageType(message) {
    if (!message || typeof message !== "object") {
      return "";
    }
    return message.type || message.action || "";
  }

  function unwrapConfig(message) {
    if (!message || typeof message !== "object") {
      return {};
    }
    if (message.config && typeof message.config === "object") {
      return message.config;
    }
    if (message.payload && typeof message.payload === "object") {
      return message.payload;
    }
    return message;
  }

  function attachRouteListeners(windowObject, onRouteChange) {
    const cleanups = [];
    if (!windowObject || typeof windowObject.addEventListener !== "function") {
      return cleanups;
    }

    for (const eventName of ["popstate", "hashchange"]) {
      windowObject.addEventListener(eventName, onRouteChange);
      cleanups.push(() => {
        if (typeof windowObject.removeEventListener === "function") {
          windowObject.removeEventListener(eventName, onRouteChange);
        }
      });
    }

    const history = windowObject.history;
    if (!history) {
      return cleanups;
    }

    for (const methodName of ["pushState", "replaceState"]) {
      if (typeof history[methodName] !== "function") {
        continue;
      }

      const original = history[methodName];
      const wrapped = function wrappedHistoryMethod(...args) {
        const result = original.apply(this, args);
        onRouteChange();
        return result;
      };

      try {
        history[methodName] = wrapped;
        cleanups.push(() => {
          if (history[methodName] === wrapped) {
            history[methodName] = original;
          }
        });
      } catch (_error) {
        // Some page contexts expose a non-writable History method.
      }
    }

    return cleanups;
  }

  function createController(options) {
    const value = options && typeof options === "object" ? options : {};
    const api = value.virtualizerApi || virtualizerApi;
    const widgetApi = value.pageWidgetApi || pageWidgetApi;
    const documentObject = value.document || (globalObject && globalObject.document);
    const windowObject = value.window || (documentObject && documentObject.defaultView) || globalObject;
    const chromeObject = getChrome(value);
    const normalize = api && api.normalizeConfig
      ? api.normalizeConfig
      : (input) => input || {};

    if (!api || typeof api.createVirtualizer !== "function" || !documentObject) {
      return null;
    }

    const virtualizer = value.virtualizer || api.createVirtualizer({
      document: documentObject,
      window: windowObject,
      root: value.root || documentObject,
      config: value.config || normalize({}),
    });
    const pageWidget = value.pageWidget || (
      widgetApi && typeof widgetApi.createPageWidget === "function"
        ? widgetApi.createPageWidget({ document: documentObject, window: windowObject })
        : null
    );
    const storage = chromeObject && chromeObject.storage && chromeObject.storage.sync;
    const cleanups = [];
    let destroyed = false;
    let lastHref = windowObject && windowObject.location ? windowObject.location.href : "";
    let widgetRenderAt = null;
    let widgetRenderKey = null;
    let widgetRefreshTimer = null;
    let widgetInterval = null;

    function getWidgetSnapshot() {
      const rawStats = virtualizer && typeof virtualizer.getStats === "function"
        ? virtualizer.getStats()
        : { total: 0, parked: 0, live: 0, enabled: false };
      const rawConfig = virtualizer && typeof virtualizer.getConfig === "function"
        ? virtualizer.getConfig()
        : {};
      const started = virtualizer && virtualizer.started !== false;
      const enabled = Boolean(rawConfig.enabled !== false && rawStats.enabled !== false && started);
      const config = {
        ...rawConfig,
        enabled,
        showPageWidget: rawConfig.showPageWidget !== false,
      };
      const stats = {
        ...rawStats,
        enabled,
      };
      return { stats, config };
    }

    function scheduleWidgetRefresh() {
      if (widgetRefreshTimer !== null || destroyed || !pageWidget || (documentObject && documentObject.hidden)) {
        return;
      }

      const setTimeoutFunction = (windowObject && windowObject.setTimeout) ||
        (globalObject && globalObject.setTimeout) ||
        (typeof setTimeout === "function" ? setTimeout : null);
      if (typeof setTimeoutFunction !== "function") {
        return;
      }

      const elapsed = widgetRenderAt === null ? 1000 : Date.now() - widgetRenderAt;
      const delay = Math.max(0, 1000 - elapsed);
      widgetRefreshTimer = setTimeoutFunction.call(windowObject, () => {
        widgetRefreshTimer = null;
        refreshPageWidget();
      }, delay);
    }

    function refreshPageWidget() {
      if (destroyed || !pageWidget) {
        return;
      }

      const snapshot = getWidgetSnapshot();
      const shouldShow = snapshot.config.showPageWidget;
      if (typeof pageWidget.setVisible === "function") {
        pageWidget.setVisible(shouldShow);
      }
      if (!shouldShow || (documentObject && documentObject.hidden)) {
        return;
      }

      // Repositioning is deliberately independent of the stats key: Zhihu's
      // fixed controls can mount, unmount, or resize while counts stay equal.
      if (typeof pageWidget.reposition === "function") {
        pageWidget.reposition();
      }

      const key = [
        snapshot.stats.total,
        snapshot.stats.parked,
        snapshot.stats.live,
        snapshot.stats.enabled,
        snapshot.config.minAnswers,
      ].join("|");
      if (key === widgetRenderKey) {
        return;
      }

      const now = Date.now();
      if (widgetRenderAt !== null && now - widgetRenderAt < 1000) {
        scheduleWidgetRefresh();
        return;
      }

      if (typeof pageWidget.update === "function") {
        pageWidget.update(snapshot.stats, snapshot.config);
      }
      widgetRenderAt = now;
      widgetRenderKey = key;
    }

    function clearWidgetTimers() {
      const clearTimeoutFunction = (windowObject && windowObject.clearTimeout) ||
        (globalObject && globalObject.clearTimeout) ||
        (typeof clearTimeout === "function" ? clearTimeout : null);
      if (widgetRefreshTimer !== null && typeof clearTimeoutFunction === "function") {
        clearTimeoutFunction.call(windowObject, widgetRefreshTimer);
      }
      widgetRefreshTimer = null;

      const clearIntervalFunction = (windowObject && windowObject.clearInterval) ||
        (globalObject && globalObject.clearInterval) ||
        (typeof clearInterval === "function" ? clearInterval : null);
      if (widgetInterval !== null && typeof clearIntervalFunction === "function") {
        clearIntervalFunction.call(windowObject, widgetInterval);
      }
      widgetInterval = null;
    }

    function installWidgetUpdates() {
      if (!pageWidget) {
        return;
      }

      const setIntervalFunction = (windowObject && windowObject.setInterval) ||
        (globalObject && globalObject.setInterval) ||
        (typeof setInterval === "function" ? setInterval : null);
      if (typeof setIntervalFunction === "function") {
        widgetInterval = setIntervalFunction.call(windowObject, refreshPageWidget, 1000);
      }

      if (documentObject && typeof documentObject.addEventListener === "function") {
        const onVisibilityChange = () => {
          if (!documentObject.hidden) {
            refreshPageWidget();
          }
        };
        documentObject.addEventListener("visibilitychange", onVisibilityChange);
        cleanups.push(() => {
          if (typeof documentObject.removeEventListener === "function") {
            documentObject.removeEventListener("visibilitychange", onVisibilityChange);
          }
        });
      }

      if (windowObject && typeof windowObject.addEventListener === "function") {
        const onResize = () => {
          if (documentObject && documentObject.hidden) return;
          if (typeof pageWidget.reposition === "function") pageWidget.reposition();
          refreshPageWidget();
        };
        windowObject.addEventListener("resize", onResize);
        cleanups.push(() => {
          if (typeof windowObject.removeEventListener === "function") {
            windowObject.removeEventListener("resize", onResize);
          }
        });
      }
    }

    installWidgetUpdates();
    refreshPageWidget();

    const onRouteChange = () => {
      if (destroyed) {
        return;
      }
      const href = windowObject && windowObject.location ? windowObject.location.href : "";
      if (href === lastHref) {
        // pushState can be called with the same URL while the page is loading;
        // a rescan is still useful for newly mounted answer nodes.
      }
      lastHref = href;
      const config = typeof virtualizer.getConfig === "function" ? virtualizer.getConfig() : null;
      if (config && config.enabled && !virtualizer.started && typeof virtualizer.start === "function") {
        virtualizer.start();
      } else if (typeof virtualizer.rescan === "function") {
        virtualizer.rescan();
      } else if (typeof virtualizer.refresh === "function") {
        virtualizer.refresh();
      }
      refreshPageWidget();
    };

    cleanups.push(...attachRouteListeners(windowObject, onRouteChange));

    readStoredConfig(storage, normalize, (config) => {
      if (!destroyed && virtualizer && typeof virtualizer.updateConfig === "function") {
        virtualizer.updateConfig(config);
        refreshPageWidget();
      }
    });

    const storageChanged = chromeObject && chromeObject.storage && chromeObject.storage.onChanged;
    if (storageChanged && typeof storageChanged.addListener === "function") {
      const onStorageChanged = (changes, areaName) => {
        if (areaName && areaName !== "sync") {
          return;
        }

        const allChanges = changes && typeof changes === "object" ? changes : {};
        const storedChange = allChanges[STORAGE_KEY] ||
          allChanges[LEGACY_STORAGE_KEY] ||
          allChanges[SECONDARY_LEGACY_STORAGE_KEY];
        const hasDirectConfigChange = ["enabled", "bufferViewports", "minAnswers", "showPageWidget"]
          .some((key) => Object.prototype.hasOwnProperty.call(allChanges, key));
        if (!storedChange && !hasDirectConfigChange) {
          return;
        }
        let config = storedChange && storedChange.newValue;
        if (!config || typeof config !== "object") {
          const direct = {};
          for (const key of ["enabled", "bufferViewports", "minAnswers", "showPageWidget"]) {
            if (allChanges[key]) {
              direct[key] = allChanges[key].newValue;
            }
          }
          config = direct;
        }
        if (virtualizer && typeof virtualizer.updateConfig === "function") {
          virtualizer.updateConfig(copyConfig(config, normalize));
          refreshPageWidget();
        }
      };
      storageChanged.addListener(onStorageChanged);
      cleanups.push(() => {
        if (typeof storageChanged.removeListener === "function") {
          storageChanged.removeListener(onStorageChanged);
        }
      });
    }

    const runtimeMessages = chromeObject && chromeObject.runtime && chromeObject.runtime.onMessage;
    if (runtimeMessages && typeof runtimeMessages.addListener === "function") {
      const onMessage = (message, _sender, sendResponse) => {
        const type = getMessageType(message);
        if (type === "GET_STATUS") {
          if (typeof sendResponse === "function") {
            sendResponse(statusResponse(virtualizer));
          }
          return false;
        }

        if (type === "RESTORE_ALL") {
          if (virtualizer && typeof virtualizer.stop === "function") {
            virtualizer.stop();
          } else if (virtualizer && typeof virtualizer.restoreAll === "function") {
            virtualizer.restoreAll();
          }
          refreshPageWidget();
          if (typeof sendResponse === "function") {
            sendResponse(statusResponse(virtualizer));
          }
          return false;
        }

        if (type === "UPDATE_CONFIG") {
          const config = unwrapConfig(message);
          const status = virtualizer && typeof virtualizer.updateConfig === "function"
            ? virtualizer.updateConfig(config)
            : statusWithConfig(virtualizer);
          if (storage && virtualizer && typeof virtualizer.getConfig === "function") {
            persistConfig(storage, virtualizer.getConfig());
          }
          refreshPageWidget();
          if (typeof sendResponse === "function") {
            sendResponse(statusResponse(virtualizer));
          }
          return false;
        }

        return false;
      };
      runtimeMessages.addListener(onMessage);
      cleanups.push(() => {
        if (typeof runtimeMessages.removeListener === "function") {
          runtimeMessages.removeListener(onMessage);
        }
      });
    }

    return {
      virtualizer,
      getStats: () => statusWithConfig(virtualizer),
      updateConfig: (config) => {
        const status = virtualizer.updateConfig(config);
        persistConfig(storage, virtualizer.getConfig());
        refreshPageWidget();
        return statusWithConfig(virtualizer) || status;
      },
      destroy: () => {
        if (destroyed) {
          return;
        }
        destroyed = true;
        clearWidgetTimers();
        for (const cleanup of cleanups.splice(0)) {
          cleanup();
        }
        if (virtualizer && typeof virtualizer.destroy === "function") {
          virtualizer.destroy();
        }
        if (pageWidget && typeof pageWidget.destroy === "function") {
          pageWidget.destroy();
        }
      },
    };
  }

  function boot(options) {
    if (!virtualizerApi || !globalObject || !globalObject.document) {
      return null;
    }

    const existing = globalObject.__ZHihuAnswerVirtualizerController;
    if (existing && typeof existing.getStats === "function") {
      return existing;
    }

    const controller = createController(options);
    if (controller) {
      globalObject.__ZHihuAnswerVirtualizerController = controller;
    }
    return controller;
  }

  const exported = {
    LEGACY_STORAGE_KEY,
    STORAGE_KEY,
    boot,
    createController,
  };

  // run_at=document_idle provides a document in the browser. Keeping this
  // guard makes the same file safe to require from node:test.
  if (globalObject && globalObject.document && virtualizerApi) {
    boot();
  }

  return exported;
});
