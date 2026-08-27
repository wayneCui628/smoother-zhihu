/*
 * Lightweight answer-list virtualizer for Zhihu question pages.
 *
 * This file deliberately has no build-time dependencies. It is loaded before
 * content.js in the MV3 content-script bundle and also exposes CommonJS
 * exports so the state machine can be tested with node:test.
 */
(function attachVirtualizer(globalObject, factory) {
  const api = factory(globalObject);

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else if (globalObject) {
    globalObject.ZhihuAnswerVirtualizer = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function createApi(globalObject) {
  "use strict";

  const DEFAULT_CONFIG = Object.freeze({
    enabled: true,
    bufferViewports: 4,
    minAnswers: 12,
    showPageWidget: true,
  });

  // These bounds keep malformed sync-storage values from creating an
  // effectively disabled (or unreasonably eager) virtualizer.
  const CONFIG_LIMITS = Object.freeze({
    bufferViewports: Object.freeze({ min: 1, max: 20 }),
    minAnswers: Object.freeze({ min: 1, max: 1000 }),
  });

  const ANSWER_CLASS = "zhihu-smoother-answer";
  const PLACEHOLDER_CLASS = "zhihu-smoother-placeholder";
  const DEFAULT_INTRINSIC_HEIGHT = 640;
  const DEFAULT_VIEWPORT_HEIGHT = 800;

  function clampNumber(value, fallback, limits) {
    const number = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(number)) {
      return fallback;
    }

    return Math.min(limits.max, Math.max(limits.min, Math.round(number)));
  }

  function normalizeBoolean(value, fallback) {
    if (typeof value === "boolean") {
      return value;
    }

    if (typeof value === "number" && Number.isFinite(value)) {
      return value !== 0;
    }

    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (["false", "0", "off", "no", "disabled"].includes(normalized)) {
        return false;
      }
      if (["true", "1", "on", "yes", "enabled"].includes(normalized)) {
        return true;
      }
    }

    return fallback;
  }

  /**
   * Normalize an extension config object. Unknown keys are intentionally
   * ignored so storage values can safely contain future settings.
   */
  function normalizeConfig(config) {
    const value = config && typeof config === "object" ? config : {};

    return {
      enabled: normalizeBoolean(value.enabled, DEFAULT_CONFIG.enabled),
      bufferViewports: clampNumber(
        value.bufferViewports,
        DEFAULT_CONFIG.bufferViewports,
        CONFIG_LIMITS.bufferViewports,
      ),
      minAnswers: clampNumber(
        value.minAnswers,
        DEFAULT_CONFIG.minAnswers,
        CONFIG_LIMITS.minAnswers,
      ),
      showPageWidget: normalizeBoolean(value.showPageWidget, DEFAULT_CONFIG.showPageWidget),
    };
  }

  function getClassList(element) {
    return element && element.classList ? element.classList : null;
  }

  function hasClass(element, className) {
    const classList = getClassList(element);
    if (classList && typeof classList.contains === "function") {
      return classList.contains(className);
    }

    if (!element || typeof element.className !== "string") {
      return false;
    }

    return (` ${element.className} `).includes(` ${className} `);
  }

  function addClass(element, className) {
    const classList = getClassList(element);
    if (classList && typeof classList.add === "function") {
      classList.add(className);
      return;
    }

    if (element && typeof element.className === "string" && !hasClass(element, className)) {
      element.className = `${element.className} ${className}`.trim();
    }
  }

  function removeClass(element, className) {
    const classList = getClassList(element);
    if (classList && typeof classList.remove === "function") {
      classList.remove(className);
      return;
    }

    if (element && typeof element.className === "string") {
      element.className = element.className
        .split(/\s+/)
        .filter((name) => name && name !== className)
        .join(" ");
    }
  }

  function matchesSelector(element, selector) {
    if (!element) {
      return false;
    }

    if (typeof element.matches === "function") {
      try {
        return element.matches(selector);
      } catch (_error) {
        // Fall through to the tiny selector matcher below for test doubles.
      }
    }

    if (selector.startsWith(".")) {
      return hasClass(element, selector.slice(1));
    }

    return false;
  }

  function queryAll(root, selector) {
    if (!root || typeof root.querySelectorAll !== "function") {
      return [];
    }

    try {
      return Array.from(root.querySelectorAll(selector));
    } catch (_error) {
      return [];
    }
  }

  function getAttribute(element, name) {
    if (!element) {
      return null;
    }

    if (typeof element.getAttribute === "function") {
      return element.getAttribute(name);
    }

    if (element.dataset && name.startsWith("data-")) {
      const datasetName = name
        .slice(5)
        .replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
      return element.dataset[datasetName] ?? null;
    }

    return null;
  }

  function parentOf(node) {
    return node && (node.parentElement || node.parentNode) ? node.parentElement || node.parentNode : null;
  }

  function nearestAncestor(node, predicate) {
    let current = node;
    while (current) {
      if (predicate(current)) {
        return current;
      }
      current = parentOf(current);
    }
    return null;
  }

  function nearestListItem(node) {
    return nearestAncestor(node, (candidate) => matchesSelector(candidate, ".List-item"));
  }

  function nearestQuestionColumn(node) {
    return nearestAncestor(node, (candidate) => matchesSelector(candidate, ".Question-mainColumn"));
  }

  function answerClassification(answerElement) {
    if (!matchesSelector(answerElement, ".AnswerItem")) {
      return "not-answer";
    }

    const rawData = getAttribute(answerElement, "data-zop");
    if (typeof rawData === "string" && rawData.trim() !== "") {
      try {
        const parsed = JSON.parse(rawData);
        return parsed && parsed.type === "answer" ? "answer" : "not-answer";
      } catch (_error) {
        // Some pages briefly expose malformed data-zop while hydrating. The
        // stable AnswerItem class is the safe fallback in that narrow case.
        return "fallback";
      }
    }

    // A missing data-zop is treated like a hydrating answer only when the
    // stable AnswerItem class is present. This still excludes ordinary
    // comment List-item nodes.
    return "fallback";
  }

  /**
   * Return true when an element is a main-answer outer List-item.
   * Valid data-zop type=answer wins; malformed/missing data-zop falls back to
   * the AnswerItem class. The nearest List-item guard prevents nested comment
   * rows from being mistaken for an answer row.
   */
  function isAnswerListItem(listItem) {
    if (!matchesSelector(listItem, ".List-item")) {
      return false;
    }

    const answerElements = [];
    if (matchesSelector(listItem, ".AnswerItem")) {
      answerElements.push(listItem);
    }
    for (const answerElement of queryAll(listItem, ".AnswerItem")) {
      if (nearestListItem(answerElement) === listItem) {
        answerElements.push(answerElement);
      }
    }

    if (answerElements.length === 0) {
      return false;
    }

    // Prefer a positive data-zop answer if multiple AnswerItem descendants
    // exist. Only use the fallback after all valid payloads have been checked.
    const classifications = answerElements.map(answerClassification);
    if (classifications.includes("answer")) {
      return true;
    }

    // A parseable non-answer payload is authoritative, even if another
    // descendant happens to be hydrating and has malformed data-zop.
    if (classifications.includes("not-answer")) {
      return false;
    }

    return classifications.includes("fallback");
  }

  function uniquePush(list, seen, element) {
    if (!seen.has(element)) {
      seen.add(element);
      list.push(element);
    }
  }

  /**
   * Find answer outer List-item elements inside one or more
   * .Question-mainColumn containers.
   */
  function findAnswerItems(root) {
    const result = [];
    const seen = new Set();
    if (!root) {
      return result;
    }

    const columns = [];
    if (matchesSelector(root, ".Question-mainColumn")) {
      columns.push(root);
    }
    for (const column of queryAll(root, ".Question-mainColumn")) {
      uniquePush(columns, new Set(columns), column);
    }

    for (const column of columns) {
      const listItems = [];
      if (matchesSelector(column, ".List-item")) {
        listItems.push(column);
      }
      for (const listItem of queryAll(column, ".List-item")) {
        uniquePush(listItems, new Set(listItems), listItem);
      }

      for (const listItem of listItems) {
        // A nested Question-mainColumn belongs to its own scan. This guard is
        // also what keeps unrelated sidebars/comments out of the result.
        if (nearestQuestionColumn(listItem) !== column) {
          continue;
        }

        if (isAnswerListItem(listItem)) {
          uniquePush(result, seen, listItem);
        }
      }
    }

    return result;
  }

  function getDocument(options) {
    if (options && options.document) {
      return options.document;
    }
    if (options && options.root && options.root.nodeType === 9) {
      return options.root;
    }
    if (options && options.root && options.root.ownerDocument) {
      return options.root.ownerDocument;
    }
    return globalObject && globalObject.document ? globalObject.document : null;
  }

  function getWindow(options, documentObject) {
    if (options && options.window) {
      return options.window;
    }
    if (documentObject && documentObject.defaultView) {
      return documentObject.defaultView;
    }
    return globalObject && typeof globalObject.addEventListener === "function"
      ? globalObject
      : null;
  }

  function finitePositive(value) {
    return typeof value === "number" && Number.isFinite(value) && value > 0;
  }

  function parsePixels(value) {
    if (typeof value === "number") {
      return finitePositive(value) ? value : 0;
    }
    if (typeof value !== "string") {
      return 0;
    }
    const parsed = Number.parseFloat(value);
    return finitePositive(parsed) ? parsed : 0;
  }

  function measureHeight(element, documentObject, fallback) {
    let height = 0;
    if (element && typeof element.getBoundingClientRect === "function") {
      try {
        height = parsePixels(element.getBoundingClientRect().height);
      } catch (_error) {
        height = 0;
      }
    }

    if (!height && element) {
      height = parsePixels(element.offsetHeight);
    }

    if (!height && element && element.style) {
      height = parsePixels(element.style.height);
    }

    if (!height && documentObject && documentObject.defaultView && typeof documentObject.defaultView.getComputedStyle === "function") {
      try {
        height = parsePixels(documentObject.defaultView.getComputedStyle(element).height);
      } catch (_error) {
        height = 0;
      }
    }

    return height || (finitePositive(fallback) ? fallback : DEFAULT_INTRINSIC_HEIGHT);
  }

  function getRect(element) {
    if (!element || typeof element.getBoundingClientRect !== "function") {
      return null;
    }

    try {
      const rect = element.getBoundingClientRect();
      if (!rect) {
        return null;
      }

      const top = Number(rect.top);
      const bottom = Number(rect.bottom);
      const height = parsePixels(rect.height);
      if (!Number.isFinite(top) || !Number.isFinite(bottom)) {
        return null;
      }

      return {
        top,
        bottom: bottom >= top ? bottom : top + (height || 0),
        height,
      };
    } catch (_error) {
      return null;
    }
  }

  function readScrollTop(windowObject, documentObject) {
    if (windowObject && typeof windowObject.scrollY === "number" && Number.isFinite(windowObject.scrollY)) {
      return windowObject.scrollY;
    }

    const scrollingElement = documentObject && (documentObject.scrollingElement || documentObject.documentElement || documentObject.body);
    return scrollingElement && typeof scrollingElement.scrollTop === "number" ? scrollingElement.scrollTop : 0;
  }

  function setScrollTop(windowObject, documentObject, value) {
    if (!Number.isFinite(value)) {
      return;
    }

    if (windowObject && typeof windowObject.scrollTo === "function") {
      try {
        windowObject.scrollTo(windowObject.scrollX || 0, value);
        return;
      } catch (_error) {
        // Fall through to the scrolling element for small test doubles.
      }
    }

    const scrollingElement = documentObject && (documentObject.scrollingElement || documentObject.documentElement || documentObject.body);
    if (scrollingElement && typeof scrollingElement.scrollTop === "number") {
      scrollingElement.scrollTop = value;
    }
  }

  function replaceElement(oldElement, newElement) {
    if (!oldElement || !newElement) {
      return false;
    }

    if (typeof oldElement.replaceWith === "function") {
      oldElement.replaceWith(newElement);
      return true;
    }

    if (oldElement.parentNode && typeof oldElement.parentNode.replaceChild === "function") {
      oldElement.parentNode.replaceChild(newElement, oldElement);
      return true;
    }

    return false;
  }

  function isAttached(node, root, documentObject) {
    if (!node) {
      return false;
    }
    if (typeof node.isConnected === "boolean") {
      return node.isConnected;
    }
    if (node.parentNode) {
      return true;
    }
    return node === root || node === documentObject;
  }

  class AnswerVirtualizer {
    constructor(options) {
      const value = options && typeof options === "object" ? options : {};
      this.document = getDocument(value);
      this.window = getWindow(value, this.document);
      this.root = value.root || this.document;
      this.config = normalizeConfig(value.config || value);
      this.records = new Map();
      this.observer = null;
      this.rafId = null;
      this.started = false;
      this.destroyed = false;
      this._boundSchedule = () => this.scheduleUpdate();
      this._mutationObserverConstructor = value.MutationObserver ||
        (this.window && this.window.MutationObserver) ||
        (globalObject && globalObject.MutationObserver);
      this._raf = value.requestAnimationFrame || (this.window && this.window.requestAnimationFrame);
      this._cancelRaf = value.cancelAnimationFrame || (this.window && this.window.cancelAnimationFrame);
    }

    get stats() {
      return this.getStats();
    }

    getStats() {
      let parked = 0;
      for (const record of this.records.values()) {
        if (record.parked) {
          parked += 1;
        }
      }

      const total = this.records.size;
      return {
        total,
        parked,
        live: total - parked,
        enabled: this.config.enabled,
      };
    }

    getConfig() {
      return { ...this.config };
    }

    start() {
      if (this.destroyed) {
        return this;
      }

      if (!this.config.enabled) {
        this.started = false;
        return this;
      }

      if (this.started) {
        this.refresh();
        return this;
      }

      this.started = true;
      this._attachListeners();
      this._observe();
      this.scan();
      this.updateWindow();
      return this;
    }

    stop() {
      this._deactivate();
      return this;
    }

    destroy() {
      if (this.destroyed) {
        return;
      }

      this._deactivate();
      this.records.clear();
      this.destroyed = true;
    }

    updateConfig(nextConfig) {
      const previous = this.config;
      this.config = normalizeConfig({ ...previous, ...(nextConfig && typeof nextConfig === "object" ? nextConfig : {}) });

      if (!this.config.enabled) {
        this._deactivate();
        return this.getStats();
      }

      if (!this.started) {
        this.start();
        return this.getStats();
      }

      this.scan();
      this.updateWindow();
      return this.getStats();
    }

    setConfig(nextConfig) {
      return this.updateConfig(nextConfig);
    }

    scan() {
      if (!this.config.enabled || !this.root) {
        return this.getStats();
      }

      const answerElements = findAnswerItems(this.root);
      const current = new Set(answerElements);

      for (const answerElement of answerElements) {
        let record = this.records.get(answerElement);
        if (!record) {
          record = {
            element: answerElement,
            placeholder: null,
            height: 0,
            parked: false,
          };
          this.records.set(answerElement, record);
        }
        addClass(answerElement, ANSWER_CLASS);
      }

      // A parked answer is intentionally absent from findAnswerItems because
      // its placeholder is in the document. Keep it until that placeholder is
      // removed; discard records whose entire row was actually removed.
      for (const [element, record] of this.records) {
        if (current.has(element)) {
          continue;
        }

        if (record.parked && isAttached(record.placeholder, this.root, this.document)) {
          continue;
        }

        if (!record.parked && isAttached(element, this.root, this.document)) {
          // A custom/test DOM can temporarily omit querySelector results while
          // retaining the node. Do not delete a live row in that interval.
          continue;
        }

        removeClass(element, ANSWER_CLASS);
        this.records.delete(element);
      }

      return this.getStats();
    }

    refresh() {
      if (!this.config.enabled) {
        return this.getStats();
      }
      this.scan();
      this.updateWindow();
      return this.getStats();
    }

    rescan() {
      return this.refresh();
    }

    scheduleUpdate() {
      if (!this.config.enabled || !this.started || this.rafId !== null) {
        return;
      }

      const callback = () => {
        this.rafId = null;
        if (!this.destroyed && this.started && this.config.enabled) {
          this.scan();
          this.updateWindow();
        }
      };

      if (typeof this._raf === "function") {
        this.rafId = this._raf.call(this.window, callback);
      } else {
        this.rafId = setTimeout(callback, 16);
      }
    }

    cancelScheduledUpdate() {
      if (this.rafId === null) {
        return;
      }

      if (typeof this._cancelRaf === "function") {
        this._cancelRaf.call(this.window, this.rafId);
      } else {
        clearTimeout(this.rafId);
      }
      this.rafId = null;
    }

    updateWindow() {
      if (!this.config.enabled || this.records.size < this.config.minAnswers) {
        this.restoreAll();
        return this.getStats();
      }

      const viewportHeight = this._viewportHeight();
      const buffer = viewportHeight * this.config.bufferViewports;

      for (const record of Array.from(this.records.values())) {
        if (record.parked) {
          const placeholderRect = getRect(record.placeholder);
          if (placeholderRect && this._isNearViewport(placeholderRect, viewportHeight, buffer)) {
            this._restoreRecord(record);
          }
          continue;
        }

        if (!isAttached(record.element, this.root, this.document)) {
          continue;
        }

        const rect = getRect(record.element);
        // If a test double/browser reports no geometry, preserving the live
        // answer is safer than removing it from the page.
        if (rect && !this._isNearViewport(rect, viewportHeight, buffer)) {
          this._parkRecord(record, rect);
        }
      }

      return this.getStats();
    }

    restoreAll() {
      for (const record of Array.from(this.records.values())) {
        if (record.parked) {
          this._restoreRecord(record);
        }
      }
      return this.getStats();
    }

    _viewportHeight() {
      const viewportHeight = this.window && Number(this.window.innerHeight);
      if (Number.isFinite(viewportHeight) && viewportHeight > 0) {
        return viewportHeight;
      }

      const documentHeight = this.document && this.document.documentElement && Number(this.document.documentElement.clientHeight);
      return Number.isFinite(documentHeight) && documentHeight > 0 ? documentHeight : DEFAULT_VIEWPORT_HEIGHT;
    }

    _isNearViewport(rect, viewportHeight, buffer) {
      return rect.bottom >= -buffer && rect.top <= viewportHeight + buffer;
    }

    _parkRecord(record, rect) {
      if (record.parked || !record.element || !record.element.parentNode || !this.document || typeof this.document.createElement !== "function") {
        return false;
      }

      const oldHeight = measureHeight(record.element, this.document, rect && rect.height);
      record.height = oldHeight;
      const placeholder = this.document.createElement("div");
      addClass(placeholder, PLACEHOLDER_CLASS);
      if (typeof placeholder.setAttribute === "function") {
        placeholder.setAttribute("aria-hidden", "true");
        placeholder.setAttribute("data-zhihu-virtualizer-placeholder", "true");
      }
      if (placeholder.style) {
        placeholder.style.height = `${oldHeight}px`;
        placeholder.style.minHeight = `${oldHeight}px`;
        placeholder.style.width = "100%";
        placeholder.style.boxSizing = "border-box";

        if (this.document.defaultView && typeof this.document.defaultView.getComputedStyle === "function") {
          try {
            const computed = this.document.defaultView.getComputedStyle(record.element);
            for (const property of ["marginTop", "marginRight", "marginBottom", "marginLeft"]) {
              if (computed && computed[property]) {
                placeholder.style[property] = computed[property];
              }
            }
          } catch (_error) {
            // Styles are an optional layout refinement; height is sufficient.
          }
        }
      }

      const beforeScrollTop = readScrollTop(this.window, this.document);
      const wasAboveViewport = Boolean(rect && rect.bottom <= 0);
      if (!replaceElement(record.element, placeholder)) {
        return false;
      }

      record.placeholder = placeholder;
      record.parked = true;

      // A placeholder normally has exactly the measured height. If page CSS
      // changes its footprint, compensate only for rows fully above the
      // viewport so the user's reading position remains anchored.
      if (wasAboveViewport) {
        const actualHeight = measureHeight(placeholder, this.document, oldHeight);
        const delta = actualHeight - oldHeight;
        if (Math.abs(delta) > 0.5) {
          setScrollTop(this.window, this.document, beforeScrollTop + delta);
        }
      }

      return true;
    }

    _restoreRecord(record) {
      if (!record.parked) {
        return false;
      }

      const placeholder = record.placeholder;
      if (!placeholder || !record.element) {
        record.placeholder = null;
        record.parked = false;
        return false;
      }

      const placeholderRect = getRect(placeholder);
      const beforeScrollTop = readScrollTop(this.window, this.document);
      const wasAboveViewport = Boolean(placeholderRect && placeholderRect.bottom <= 0);
      const placeholderHeight = measureHeight(placeholder, this.document, record.height);
      if (replaceElement(placeholder, record.element)) {
        record.placeholder = null;
        record.parked = false;
        addClass(record.element, ANSWER_CLASS);

        if (wasAboveViewport) {
          const actualHeight = measureHeight(record.element, this.document, record.height || placeholderHeight);
          const delta = actualHeight - placeholderHeight;
          if (Math.abs(delta) > 0.5) {
            setScrollTop(this.window, this.document, beforeScrollTop + delta);
          }
        }
        return true;
      }

      return false;
    }

    _attachListeners() {
      if (!this.window || typeof this.window.addEventListener !== "function") {
        return;
      }
      this.window.addEventListener("scroll", this._boundSchedule, { passive: true });
      this.window.addEventListener("resize", this._boundSchedule, { passive: true });
    }

    _detachListeners() {
      if (!this.window || typeof this.window.removeEventListener !== "function") {
        return;
      }
      this.window.removeEventListener("scroll", this._boundSchedule, { passive: true });
      this.window.removeEventListener("resize", this._boundSchedule, { passive: true });
    }

    _observe() {
      if (!this._mutationObserverConstructor || !this.root || typeof this.root !== "object") {
        return;
      }

      const observeTarget = this.root.nodeType === 9 && this.root.documentElement ? this.root.documentElement : this.root;
      if (!observeTarget || typeof this._mutationObserverConstructor !== "function") {
        return;
      }

      try {
        this.observer = new this._mutationObserverConstructor(() => {
          this.scan();
          this.scheduleUpdate();
        });
        this.observer.observe(observeTarget, { childList: true, subtree: true });
      } catch (_error) {
        this.observer = null;
      }
    }

    _disconnectObserver() {
      if (this.observer && typeof this.observer.disconnect === "function") {
        this.observer.disconnect();
      }
      this.observer = null;
    }

    _deactivate() {
      this.cancelScheduledUpdate();
      this._disconnectObserver();
      this._detachListeners();
      this.restoreAll();
      for (const record of this.records.values()) {
        removeClass(record.element, ANSWER_CLASS);
      }
      this.started = false;
    }
  }

  function createVirtualizer(options) {
    const instance = new AnswerVirtualizer(options);
    if (!options || options.autoStart !== false) {
      instance.start();
    }
    return instance;
  }

  return {
    ANSWER_CLASS,
    ANSWER_SELECTOR: ".AnswerItem",
    CONFIG_LIMITS,
    DEFAULT_CONFIG,
    PLACEHOLDER_CLASS,
    AnswerVirtualizer,
    Virtualizer: AnswerVirtualizer,
    createVirtualizer,
    findAnswerItems,
    isAnswerListItem,
    normalizeConfig,
  };
});
