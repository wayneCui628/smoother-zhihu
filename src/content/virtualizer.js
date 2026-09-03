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
    bufferViewports: 2,
    minAnswers: 5,
    showPageWidget: true,
  });

  const CONFIG_LIMITS = Object.freeze({
    bufferViewports: Object.freeze({ min: 1, max: 20 }),
    minAnswers: Object.freeze({ min: 1, max: 1000 }),
  });

  const ANSWER_CLASS = "zhihu-smoother-answer";
  const PARKED_CLASS = "zhihu-smoother-parked";
  // content-visibility:auto can report a browser supplied intrinsic height
  // (often 640px/672px) for an answer that has never been laid out. New rows
  // use the median of measured rows, with this modest value as a safe seed.
  const DEFAULT_INTRINSIC_HEIGHT = 360;
  const DEFAULT_VIEWPORT_HEIGHT = 800;
  const SUSPICIOUS_INTRINSIC_HEIGHTS = new Set([640, 672]);
  const HEIGHT_POOL_MIN = 120;
  const HEIGHT_POOL_MAX = 1200;
  // A row whose height changed recently (for example a comment section that
  // was just opened) is still settling; parking it right away would freeze a
  // stale height. Keep it live for this grace period instead.
  const PIN_HEIGHT_CHANGE_GRACE_MS = 5000;

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

  function normalizeConfig(config) {
    const value = config && typeof config === "object" ? config : {};
    const parsedMin = Number(value.minAnswers);
    const minCandidate = parsedMin === 12 ? DEFAULT_CONFIG.minAnswers : value.minAnswers;

    return {
      enabled: normalizeBoolean(value.enabled, DEFAULT_CONFIG.enabled),
      bufferViewports: clampNumber(
        value.bufferViewports,
        DEFAULT_CONFIG.bufferViewports,
        CONFIG_LIMITS.bufferViewports,
      ),
      minAnswers: clampNumber(
        minCandidate,
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
        return Boolean(element.matches(selector));
      } catch (_error) {
        // Fall through to the tiny selector matcher below for test doubles.
      }
    }

    // The fallback intentionally handles only selectors used by this module.
    // It makes the implementation usable with small DOM test doubles while
    // keeping the browser path delegated to Element.matches().
    const tagMatch = selector.match(/^[a-zA-Z][\w-]*/);
    if (tagMatch && String(element.tagName || "").toLowerCase() !== tagMatch[0].toLowerCase()) {
      return false;
    }

    for (const classToken of selector.match(/\.[\w-]+/g) || []) {
      if (!hasClass(element, classToken.slice(1))) {
        return false;
      }
    }

    for (const attributeToken of selector.match(/\[([^\]=]+)(?:=["']?([^\]"']+)["']?)?\]/g) || []) {
      const parsed = attributeToken.match(/\[([^\]=]+)(?:=["']?([^\]"']+)["']?)?\]/);
      if (!parsed) {
        continue;
      }
      const actual = getAttribute(element, parsed[1].trim());
      if (actual === null || (parsed[2] !== undefined && String(actual) !== parsed[2])) {
        return false;
      }
    }

    return Boolean(tagMatch || selector.startsWith(".") || selector.startsWith("["));
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

  function directChildren(element) {
    if (!element) {
      return [];
    }
    if (element.children) {
      return Array.from(element.children);
    }
    if (element.childNodes) {
      return Array.from(element.childNodes).filter((child) => child && child.nodeType === 1);
    }
    return [];
  }

  function getAnswerElements(listItem) {
    const answerElements = [];
    if (matchesSelector(listItem, ".AnswerItem")) {
      answerElements.push(listItem);
    }
    for (const answerElement of queryAll(listItem, ".AnswerItem")) {
      if (nearestListItem(answerElement) === listItem && !answerElements.includes(answerElement)) {
        answerElements.push(answerElement);
      }
    }
    return answerElements;
  }

  function parseDataZop(answerElement) {
    const rawData = getAttribute(answerElement, "data-zop");
    if (typeof rawData !== "string" || rawData.trim() === "") {
      return null;
    }

    try {
      const parsed = JSON.parse(rawData);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch (_error) {
      return null;
    }
  }

  function answerClassification(answerElement) {
    if (!matchesSelector(answerElement, ".AnswerItem")) {
      return "not-answer";
    }

    const parsed = parseDataZop(answerElement);
    if (parsed) {
      return parsed.type === "answer" ? "answer" : "not-answer";
    }

    // Some pages briefly expose malformed data-zop while hydrating. The
    // stable AnswerItem class is the safe fallback in that narrow case.
    return "fallback";
  }

  function isAnswerListItem(listItem) {
    if (!matchesSelector(listItem, ".List-item")) {
      return false;
    }

    const answerElements = getAnswerElements(listItem);
    if (answerElements.length === 0) {
      return false;
    }

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

  function isListSentinel(element) {
    return matchesSelector(element, "div[role='listitem']") ||
      (getAttribute(element, "role") === "listitem" && String(element.tagName || "div").toLowerCase() === "div");
  }

  function isEmptyListSentinel(element) {
    if (!isListSentinel(element)) {
      return false;
    }
    return directChildren(element).length === 0;
  }

  function isRelevantDirectChild(element) {
    return isAnswerListItem(element) || hasClass(element, "Pc-word-new") || isListSentinel(element);
  }

  function hasRelevantDirectChildren(element) {
    return directChildren(element).some(isRelevantDirectChild);
  }

  function findQuestionAnswersContainers(root) {
    const containers = [];
    const seen = new Set();
    if (!root) {
      return containers;
    }

    if (matchesSelector(root, ".QuestionAnswers-answers")) {
      uniquePush(containers, seen, root);
    }
    for (const container of queryAll(root, ".QuestionAnswers-answers")) {
      uniquePush(containers, seen, container);
    }
    return containers;
  }

  /**
   * Find the actual direct-child answer list. Zhihu currently gives this
   * node an unstable class (for example css-0), so the empty listitem loading
   * sentinel is the most reliable anchor.
   */
  function findAnswerListRoot(root) {
    if (!root) {
      return null;
    }

    const containers = findQuestionAnswersContainers(root);
    for (const container of containers) {
      for (const sentinel of queryAll(container, "div[role='listitem']")) {
        if (isEmptyListSentinel(sentinel) && parentOf(sentinel)) {
          return parentOf(sentinel);
        }
      }
    }

    // A caller may pass the list root directly (useful for tests and for
    // content scripts that already located the answers region).
    if (hasRelevantDirectChildren(root)) {
      return root;
    }

    for (const container of containers) {
      if (hasRelevantDirectChildren(container)) {
        return container;
      }

      // Fallback for a page snapshot without its trailing loading sentinel.
      const answer = queryAll(container, ".List-item").find(isAnswerListItem);
      const parent = parentOf(answer);
      if (parent && hasRelevantDirectChildren(parent)) {
        return parent;
      }
    }

    return null;
  }

  /**
   * Find answer outer List-item elements inside the actual list root, with a
   * legacy Question-mainColumn fallback for older page snapshots.
   */
  function findAnswerItems(root) {
    const result = [];
    const seen = new Set();
    if (!root) {
      return result;
    }

    const listRoot = findAnswerListRoot(root);
    if (listRoot) {
      for (const listItem of directChildren(listRoot)) {
        if (isAnswerListItem(listItem)) {
          uniquePush(result, seen, listItem);
        }
      }
      if (result.length > 0 || findQuestionAnswersContainers(root).length > 0) {
        return result;
      }
    }

    const columns = [];
    const columnSeen = new Set();
    if (matchesSelector(root, ".Question-mainColumn")) {
      columns.push(root);
      columnSeen.add(root);
    }
    for (const column of queryAll(root, ".Question-mainColumn")) {
      uniquePush(columns, columnSeen, column);
    }

    for (const column of columns) {
      const listItems = [];
      const listItemSeen = new Set();
      if (matchesSelector(column, ".List-item")) {
        listItems.push(column);
        listItemSeen.add(column);
      }
      for (const listItem of queryAll(column, ".List-item")) {
        uniquePush(listItems, listItemSeen, listItem);
      }

      for (const listItem of listItems) {
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

  function measureHeight(element, documentObject, fallback, useDefault = true) {
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

    if (height) {
      return height;
    }
    if (finitePositive(fallback)) {
      return fallback;
    }
    return useDefault ? DEFAULT_INTRINSIC_HEIGHT : 0;
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

  function containsNode(parent, child) {
    if (!parent || !child) {
      return false;
    }
    if (parent === child) {
      return true;
    }
    if (typeof parent.contains === "function") {
      try {
        return parent.contains(child);
      } catch (_error) {
        // Fall through to parent traversal.
      }
    }
    let current = parentOf(child);
    while (current) {
      if (current === parent) {
        return true;
      }
      current = parentOf(current);
    }
    return false;
  }

  class AnswerVirtualizer {
    constructor(options) {
      const value = options && typeof options === "object" ? options : {};
      this.document = getDocument(value);
      this.window = getWindow(value, this.document);
      this.root = value.root || this.document;
      this.config = normalizeConfig(value.config || value);
      // records remains keyed by the current outer element for compatibility
      // with the original public/test surface. recordsById is the identity
      // index that survives React replacing an answer node.
      this.records = new Map();
      this.recordsById = new Map();
      this._anonymousIds = new WeakMap();
      this._nextAnonymousId = 1;
      this._recentHeights = [];
      this._parkedCount = 0;
      this.listRoot = null;
      this.observer = null;
      this.intersectionObserver = null;
      this.resizeObserver = null;
      this.rafId = null;
      this._addedNodeQueue = new Set();
      this._addedNodeRafId = null;
      this._addedNodeQueueVersion = 0;
      this.started = false;
      this.destroyed = false;
      this._boundScroll = () => this.scheduleUpdate();
      this._boundResize = () => this._handleViewportResize();
      this._mutationObserverConstructor = value.MutationObserver ||
        (this.window && this.window.MutationObserver) ||
        (globalObject && globalObject.MutationObserver);
      this._intersectionObserverConstructor = value.IntersectionObserver ||
        (this.window && this.window.IntersectionObserver) ||
        (globalObject && globalObject.IntersectionObserver);
      this._resizeObserverConstructor = value.ResizeObserver ||
        (this.window && this.window.ResizeObserver) ||
        (globalObject && globalObject.ResizeObserver);
      this._raf = value.requestAnimationFrame || (this.window && this.window.requestAnimationFrame);
      this._cancelRaf = value.cancelAnimationFrame || (this.window && this.window.cancelAnimationFrame);
      this._now = typeof value.now === "function" ? value.now : () => Date.now();
      this._setTimeoutFunction = value.setTimeout ||
        (this.window && this.window.setTimeout) ||
        (typeof setTimeout === "function" ? setTimeout : null);
      this._clearTimeoutFunction = value.clearTimeout ||
        (this.window && this.window.clearTimeout) ||
        (typeof clearTimeout === "function" ? clearTimeout : null);
      this._pinRecheckTimer = null;
      this._pinRecheckAt = null;
      this._pinRecheckRecords = new Set();
      this._restoreMeasureQueue = new Map(); // record -> rAF id
      this._verticalBoxCache = null;
    }

    get stats() {
      return this.getStats();
    }

    getStats() {
      const total = this.recordsById.size;
      const parked = this._parkedCount;
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
        this._cancelAddedNodeQueue();
        this.started = false;
        return this;
      }

      if (this.started) {
        this.refresh();
        return this;
      }

      this.started = true;
      this._ensureListRoot();
      this._attachListeners();
      this.scan();
      this._observe();
      this._setupIntersectionObserver();
      this._setupResizeObserver();
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
      this.recordsById.clear();
      this._recentHeights = [];
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
      this._setupIntersectionObserver();
      this.updateWindow();
      return this.getStats();
    }

    setConfig(nextConfig) {
      return this.updateConfig(nextConfig);
    }

    _ensureListRoot() {
      const nextRoot = findAnswerListRoot(this.root);
      if (nextRoot && nextRoot !== this.listRoot) {
        this._cancelAddedNodeQueue();
        this.listRoot = nextRoot;
        if (this.started && this.observer) {
          this._disconnectObserver();
          this._observe();
        }
      }
      return this.listRoot;
    }

    _answerId(element) {
      const answerElement = getAnswerElements(element)[0] || element;
      const parsed = parseDataZop(answerElement);
      const itemId = parsed && parsed.itemId;
      if (itemId !== undefined && itemId !== null && String(itemId).trim() !== "") {
        return `item:${String(itemId)}`;
      }

      const name = getAttribute(answerElement, "name") || answerElement.name;
      if (name !== undefined && name !== null && String(name).trim() !== "") {
        return `name:${String(name)}`;
      }

      if (!this._anonymousIds.has(element)) {
        this._anonymousIds.set(element, `anonymous:${this._nextAnonymousId++}`);
      }
      return this._anonymousIds.get(element);
    }

    _createRecord(element, id) {
      return {
        id,
        element,
        height: 0,
        lastMeasuredHeight: 0,
        lastHeightChangeAt: 0,
        verticalBox: null,
        parked: false,
        parkedInlineStyles: null,
      };
    }

    _registerAnswerElement(element) {
      if (!element || !isAnswerListItem(element)) {
        return null;
      }

      const id = this._answerId(element);
      let record = this.recordsById.get(id);
      if (!record) {
        record = this._createRecord(element, id);
        this.recordsById.set(id, record);
        this.records.set(element, record);
      } else if (record.element !== element) {
        const previousElement = record.element;
        this._unobserveLiveRecord(record);
        this.records.delete(previousElement);

        // React can replace an AnswerItem node while the answer identity stays
        // the same. Release any parking styles on the old node, then rebind
        // the single record to the new node. Never remove either React node:
        // React owns their lifecycle and will reconcile the old one itself.
        if (record.parked) {
          this._restoreParkedStyles(record, previousElement);
          this._setParked(record, false);
          record.parkedInlineStyles = null;
        }
        record.element = element;
        this.records.set(element, record);
      }

      addClass(element, ANSWER_CLASS);
      this._optimizeAnswerImages(element);
      if (!record.parked) {
        this._observeLiveRecord(record);
        // Measure right away: a registered row that knows its height can be
        // parked as soon as it leaves the buffer, which keeps the set of
        // live (fully laid out) rows small. Skipping this measurement made
        // rows stay live much longer and measurably increased native
        // layout/paint work on deep pages.
        this._maybeMeasureRecord(record);
      }
      return record;
    }

    _optimizeAnswerImages(element) {
      if (!element || typeof element.querySelectorAll !== "function") {
        return;
      }
      try {
        const images = element.querySelectorAll("img");
        for (let i = 0; i < images.length; i++) {
          const img = images[i];
          if (img && img.decoding !== "async") {
            img.decoding = "async";
          }
        }
      } catch (_error) {}
    }

    scan() {
      if (!this.config.enabled || !this.root) {
        return this.getStats();
      }

      this._ensureListRoot();
      if (this.listRoot) {
        this._removePromotions(this.listRoot);
      }

      const answerElements = findAnswerItems(this.root);
      const currentIds = new Set();
      for (const answerElement of answerElements) {
        const record = this._registerAnswerElement(answerElement);
        if (record) {
          currentIds.add(record.id);
        }
      }

      // A parked answer remains in the list, so it is normally still present
      // in findAnswerItems. Keep an attached parked row during transient DOM
      // snapshots; discard records whose entire row was actually removed.
      for (const record of Array.from(this.recordsById.values())) {
        if (currentIds.has(record.id)) {
          continue;
        }

        if (record.parked && isAttached(record.element, this.listRoot || this.root, this.document)) {
          continue;
        }

        if (!record.parked && isAttached(record.element, this.listRoot || this.root, this.document)) {
          // A custom/test DOM can temporarily omit querySelector results while
          // retaining the node. Do not delete a live row in that interval.
          continue;
        }

        this._deleteRecord(record);
      }

      return this.getStats();
    }

    refresh() {
      if (!this.config.enabled) {
        return this.getStats();
      }
      this.scan();
      this._setupIntersectionObserver();
      this._setupResizeObserver();
      this.updateWindow();
      return this.getStats();
    }

    rescan() {
      return this.refresh();
    }

    scheduleUpdate() {
      // IntersectionObserver owns scroll-driven work when available. In
      // particular, do not scan or walk every record from a scroll handler.
      if (this.intersectionObserver) {
        return;
      }
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

    _cancelAddedNodeQueue() {
      this._addedNodeQueue.clear();
      this._addedNodeQueueVersion += 1;
      if (this._addedNodeRafId === null) {
        return;
      }

      if (typeof this._cancelRaf === "function") {
        this._cancelRaf.call(this.window, this._addedNodeRafId);
      } else {
        clearTimeout(this._addedNodeRafId);
      }
      this._addedNodeRafId = null;
    }

    _scheduleAddedNodeQueue() {
      if (this._addedNodeRafId !== null || this._addedNodeQueue.size === 0) {
        return;
      }

      const queueVersion = this._addedNodeQueueVersion;
      const callback = () => {
        // cancelAnimationFrame normally prevents this callback, but the
        // version guard also handles a callback that was already dispatched
        // when stop(), destroy(), or a list-root switch invalidated the queue.
        if (queueVersion !== this._addedNodeQueueVersion) {
          return;
        }

        this._addedNodeRafId = null;
        if (this.destroyed || !this.started || !this.config.enabled || !this.listRoot) {
          this._cancelAddedNodeQueue();
          return;
        }

        const next = this._addedNodeQueue.values().next();
        if (next.done) {
          return;
        }
        this._addedNodeQueue.delete(next.value);
        this._handleAddedNode(next.value);

        if (queueVersion !== this._addedNodeQueueVersion) {
          return;
        }
        if (this._addedNodeQueue.size > 0) {
          this._scheduleAddedNodeQueue();
        } else if (this.recordsById.size < this.config.minAnswers) {
          // Preserve the activation threshold after the whole mutation batch
          // has been handled, without restoring once per added node.
          this.restoreAll();
        }
      };

      if (typeof this._raf === "function") {
        this._addedNodeRafId = this._raf.call(this.window, callback);
      } else {
        this._addedNodeRafId = setTimeout(callback, 16);
      }
    }

    _enqueueAddedNode(node) {
      if (!node || !this.listRoot || parentOf(node) !== this.listRoot || isListSentinel(node)) {
        return false;
      }

      this._addedNodeQueue.add(node);
      this._scheduleAddedNodeQueue();
      return true;
    }

    updateWindow() {
      if (!this.config.enabled || this.recordsById.size < this.config.minAnswers) {
        this.restoreAll();
        return this.getStats();
      }

      const viewportHeight = this._viewportHeight();
      const buffer = viewportHeight * this.config.bufferViewports;
      for (const record of Array.from(this.recordsById.values())) {
        this._reconcileRecord(record, viewportHeight, buffer);
      }

      return this.getStats();
    }

    _reconcileRecord(record, viewportHeight, buffer) {
      if (record.parked) {
        const parkedRect = getRect(record.element);
        if (parkedRect && this._isNearViewport(parkedRect, viewportHeight, buffer)) {
          this._restoreRecord(record);
        }
        return;
      }

      if (!isAttached(record.element, this.listRoot || this.root, this.document)) {
        return;
      }

      const graceRemaining = this._pinGraceRemainingMs(record);
      if (graceRemaining > 0) {
        this._deferForGrace(record, graceRemaining);
        return;
      }

      if (this._isPinnedRecord(record)) {
        return;
      }

      const rect = getRect(record.element);
      if (rect && !this._isNearViewport(rect, viewportHeight, buffer)) {
        this._parkRecord(record, rect);
      } else if (rect && this._isNearViewport(rect, viewportHeight, 0)) {
        this._maybeMeasureRecord(record, rect);
      }
    }

    restoreAll() {
      for (const record of Array.from(this.recordsById.values())) {
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

    _computedStyle(element) {
      if (!element || !this.document || !this.document.defaultView || typeof this.document.defaultView.getComputedStyle !== "function") {
        return null;
      }
      try {
        return this.document.defaultView.getComputedStyle(element);
      } catch (_error) {
        return null;
      }
    }

    _hasAutoContentVisibility(element) {
      const style = this._computedStyle(element);
      const contentVisibility = style && style.contentVisibility || (element.style && element.style.contentVisibility);
      return String(contentVisibility || "").toLowerCase() === "auto";
    }

    _isLikelyIntrinsicHeight(element, height, rect) {
      if (!finitePositive(height)) {
        return false;
      }

      const style = this._computedStyle(element);
      const intrinsicSize = style && (style.containIntrinsicSize || style.webkitContentVisibility) ||
        (element && element.style && (element.style.containIntrinsicSize || element.style.containIntrinsicBlockSize));
      if (intrinsicSize && String(intrinsicSize).includes(String(Math.round(height)))) {
        return true;
      }

      if (this._hasAutoContentVisibility(element) && rect) {
        const viewportHeight = this._viewportHeight();
        if (!this._isNearViewport(rect, viewportHeight, 0)) {
          return true;
        }
      }

      // Small DOM doubles often cannot expose computed style. Keep the known
      // browser intrinsic values out of the measurement pool when offscreen.
      return Boolean(rect && !this._isNearViewport(rect, this._viewportHeight(), 0) &&
        SUSPICIOUS_INTRINSIC_HEIGHTS.has(Math.round(height)));
    }

    _isUsableMeasurement(element, height, rect) {
      if (!finitePositive(height)) {
        return false;
      }
      return !this._isLikelyIntrinsicHeight(element, height, rect || getRect(element));
    }

    _rememberHeight(height) {
      if (!finitePositive(height) || height < HEIGHT_POOL_MIN || height > HEIGHT_POOL_MAX) {
        return;
      }
      this._recentHeights.push(height);
      if (this._recentHeights.length > 31) {
        this._recentHeights.shift();
      }
    }

    _medianHeight() {
      if (this._recentHeights.length === 0) {
        return DEFAULT_INTRINSIC_HEIGHT;
      }
      const sorted = [...this._recentHeights].sort((left, right) => left - right);
      const middle = Math.floor(sorted.length / 2);
      return sorted.length % 2 === 0
        ? (sorted[middle - 1] + sorted[middle]) / 2
        : sorted[middle];
    }

    _setMeasuredHeight(record, height) {
      if (!finitePositive(height)) {
        return false;
      }
      const rounded = Math.max(1, height);
      const previous = record.lastMeasuredHeight;
      const changed = !finitePositive(previous) || Math.abs(previous - rounded) > 0.5;
      record.height = rounded;
      record.lastMeasuredHeight = rounded;
      if (changed) {
        this._rememberHeight(rounded);
        // Only a change against an already known height counts as recent
        // activity: the first trustworthy measurement of a row is not one.
        if (finitePositive(previous)) {
          record.lastHeightChangeAt = this._now();
        }
      }
      return true;
    }

    _maybeMeasureRecord(record, rect) {
      if (!record || record.parked || !record.element) {
        return false;
      }
      const measuredRect = rect || getRect(record.element);
      const height = measuredRect && measuredRect.height || measureHeight(record.element, this.document, 0, false);
      if (!this._isUsableMeasurement(record.element, height, measuredRect)) {
        return false;
      }
      return this._setMeasuredHeight(record, height);
    }

    _parkingHeight(record, rect) {
      if (finitePositive(record.lastMeasuredHeight)) {
        return { height: record.lastMeasuredHeight, trusted: true };
      }

      const rectHeight = rect && rect.height;
      if (finitePositive(rectHeight) && this._isUsableMeasurement(record.element, rectHeight, rect)) {
        this._setMeasuredHeight(record, rectHeight);
        return { height: rectHeight, trusted: true };
      }

      // Never collapse a row to a guessed median. Zhihu answers can be tens of
      // thousands of pixels tall; restoring a guessed slot later would create
      // a large layout shift and can pull the user back to an earlier anchor.
      // Keep the answer live until it has been rendered close enough to the
      // viewport for a trustworthy outer-box measurement.
      return null;
    }

    _contentBoxHeight(record, element, outerHeight) {
      const height = finitePositive(outerHeight) ? outerHeight : DEFAULT_INTRINSIC_HEIGHT;
      // Padding and borders barely change once an answer is rendered, while each
      // getComputedStyle property read can force a full-document style recalc.
      // Answer rows share one component structure, so one measured inset serves
      // every record: a single style read per page keeps parking a pure write
      // and keeps the frozen slot exactly as tall as the natural outer box.
      if (!finitePositive(record.verticalBox)) {
        if (this._verticalBoxCache === null) {
          const computed = this._computedStyle(element);
          this._verticalBoxCache = computed
            ? [computed.paddingTop, computed.paddingBottom, computed.borderTopWidth, computed.borderBottomWidth]
              .reduce((sum, value) => sum + parsePixels(value), 0)
            : 0;
        }
        record.verticalBox = this._verticalBoxCache;
      }
      return Math.max(1, height - record.verticalBox);
    }

    _hasActiveMedia(element) {
      if (!element) {
        return false;
      }
      const videos = queryAll(element, "video");
      if (videos.some((video) => video && !video.paused && !video.ended)) {
        return true;
      }
      const audios = queryAll(element, "audio");
      if (audios.some((audio) => audio && !audio.paused && !audio.ended)) {
        return true;
      }
      const iframes = queryAll(element, "iframe");
      if (
        iframes.some((iframe) => {
          const src = (getAttribute(iframe, "src") || iframe.src || "").toLowerCase();
          return src.includes("bilibili.com") || src.includes("v.qq.com") || src.includes("youku.com");
        })
      ) {
        return true;
      }
      return false;
    }

    _isPinnedRecord(record) {
      const activeElement = this.document && this.document.activeElement;
      if (activeElement && containsNode(record.element, activeElement)) {
        return true;
      }
      return this._hasActiveMedia(record.element);
    }

    _pinGraceRemainingMs(record) {
      const changedAt = record && record.lastHeightChangeAt;
      if (typeof changedAt !== "number" || !Number.isFinite(changedAt) || changedAt <= 0) {
        return 0;
      }
      return Math.max(0, PIN_HEIGHT_CHANGE_GRACE_MS - (this._now() - changedAt));
    }

    _deferForGrace(record, delayMs) {
      this._pinRecheckRecords.add(record);
      this._schedulePinRecheck(delayMs);
    }

    _schedulePinRecheck(delayMs) {
      if (this.destroyed || !this.started || !this.config.enabled || delayMs <= 0) {
        return;
      }
      const fireDelay = delayMs + 40;
      const targetAt = this._now() + fireDelay;
      if (this._pinRecheckTimer !== null && targetAt >= this._pinRecheckAt) {
        return;
      }
      if (typeof this._setTimeoutFunction !== "function") {
        return;
      }
      if (this._pinRecheckTimer !== null && typeof this._clearTimeoutFunction === "function") {
        this._clearTimeoutFunction.call(this.window, this._pinRecheckTimer);
      }
      this._pinRecheckAt = targetAt;
      this._pinRecheckTimer = this._setTimeoutFunction.call(this.window, () => {
        this._pinRecheckTimer = null;
        this._pinRecheckAt = null;
        if (this.destroyed || !this.started || !this.config.enabled) {
          return;
        }
        // Reconcile only the records that were actually deferred: a full
        // updateWindow() sweep reads geometry for every managed answer after
        // each grace expiry and re-creates the layout storm.
        const viewportHeight = this._viewportHeight();
        const buffer = viewportHeight * this.config.bufferViewports;
        for (const record of Array.from(this._pinRecheckRecords)) {
          this._pinRecheckRecords.delete(record);
          this._reconcileRecord(record, viewportHeight, buffer);
        }
      }, fireDelay);
    }

    _clearPinRecheck() {
      if (this._pinRecheckTimer !== null && typeof this._clearTimeoutFunction === "function") {
        this._clearTimeoutFunction.call(this.window, this._pinRecheckTimer);
      }
      this._pinRecheckTimer = null;
      this._pinRecheckAt = null;
      this._pinRecheckRecords.clear();
    }

    _saveParkedStyles(element) {
      const style = element && element.style;
      if (!style) {
        return null;
      }
      return {
        contentVisibility: style.contentVisibility || "",
        containIntrinsicSize: style.containIntrinsicSize || "",
        containIntrinsicInlineSize: style.containIntrinsicInlineSize || "",
        containIntrinsicBlockSize: style.containIntrinsicBlockSize || "",
      };
    }

    _restoreParkedStyles(record, element = record && record.element) {
      const style = element && element.style;
      const saved = record && record.parkedInlineStyles;
      if (style && saved) {
        style.contentVisibility = saved.contentVisibility;
        style.containIntrinsicSize = saved.containIntrinsicSize;
        style.containIntrinsicInlineSize = saved.containIntrinsicInlineSize;
        style.containIntrinsicBlockSize = saved.containIntrinsicBlockSize;
      }
      if (element) {
        removeClass(element, PARKED_CLASS);
      }
    }

    _parkRecord(record, rect) {
      if (record.parked || !record.element || !parentOf(record.element)) {
        return false;
      }

      const graceRemaining = this._pinGraceRemainingMs(record);
      if (graceRemaining > 0) {
        this._deferForGrace(record, graceRemaining);
        return false;
      }

      if (this._isPinnedRecord(record)) {
        return false;
      }

      const parking = this._parkingHeight(record, rect);
      if (!parking || !parking.trusted) {
        return false;
      }
      const oldHeight = parking.height;
      const element = record.element;
      const style = element.style;
      const savedStyles = this._saveParkedStyles(element);

      // Keep the original React-owned row in the list. Hiding its rendering
      // preserves its layout slot and avoids replacing/removing nodes that
      // React may still hold references to.
      if (style) {
        style.contentVisibility = "hidden";
        const contentHeight = this._contentBoxHeight(record, element, oldHeight);
        style.containIntrinsicSize = "";
        style.containIntrinsicInlineSize = "none";
        style.containIntrinsicBlockSize = `${contentHeight}px`;
      }
      addClass(element, PARKED_CLASS);
      record.parkedInlineStyles = savedStyles;
      record.height = oldHeight;
      this._setParked(record, true);
      this._pinRecheckRecords.delete(record);

      return true;
    }

    _restoreRecord(record) {
      if (!record.parked || !record.element) {
        return false;
      }

      const element = record.element;
      this._restoreParkedStyles(record, element);
      record.parkedInlineStyles = null;
      this._setParked(record, false);
      addClass(element, ANSWER_CLASS);
      this._observeLiveRecord(record);

      // The restore just wrote styles; reading the box now would force a layout
      // in the same task. The record is live again either way, so let the
      // deferred two-frame callback refresh the cached height instead.
      this._scheduleRestoreMeasure(record);
      return true;
    }

    _scheduleRestoreMeasure(record) {
      if (this._restoreMeasureQueue.has(record)) {
        return;
      }
      const schedule = (depth) => {
        const callback = () => {
          // Two frames: the first lets the browser finish its own layout after
          // the restore's style writes, so the second reads a clean layout
          // instead of forcing a full-document reflow.
          if (depth > 0) {
            schedule(depth - 1);
            return;
          }
          this._restoreMeasureQueue.delete(record);
          if (this.destroyed || !this.started || !this.config.enabled || record.parked || !record.element) {
            return;
          }
          const rect = getRect(record.element);
          if (rect && this._isUsableMeasurement(record.element, rect.height, rect)) {
            this._setMeasuredHeight(record, rect.height);
          }
        };
        let rafId;
        if (typeof this._raf === "function") {
          rafId = this._raf.call(this.window, callback);
        } else {
          rafId = setTimeout(callback, 16);
        }
        this._restoreMeasureQueue.set(record, rafId);
      };
      schedule(1);
    }

    _cancelRestoreMeasures() {
      for (const rafId of this._restoreMeasureQueue.values()) {
        if (typeof this._cancelRaf === "function") {
          this._cancelRaf.call(this.window, rafId);
        } else {
          clearTimeout(rafId);
        }
      }
      this._restoreMeasureQueue.clear();
    }

    _cancelRestoreMeasure(record) {
      const rafId = this._restoreMeasureQueue.get(record);
      if (rafId === undefined) {
        return;
      }
      if (typeof this._cancelRaf === "function") {
        this._cancelRaf.call(this.window, rafId);
      } else {
        clearTimeout(rafId);
      }
      this._restoreMeasureQueue.delete(record);
    }

    _setParked(record, parked) {
      if (record.parked === parked) {
        return;
      }
      record.parked = parked;
      this._parkedCount += parked ? 1 : -1;
    }

    _deleteRecord(record) {
      if (!record) {
        return;
      }
      this._cancelRestoreMeasure(record);
      this._pinRecheckRecords.delete(record);
      this._unobserveLiveRecord(record);
      if (record.parked) {
        this._restoreParkedStyles(record);
        record.parkedInlineStyles = null;
      }
      removeClass(record.element, ANSWER_CLASS);
      this.records.delete(record.element);
      this.recordsById.delete(record.id);
      if (record.parked) {
        this._setParked(record, false);
      }
      // Every record-removal path must preserve the activation invariant, not
      // only MutationObserver batches. Zhihu can also make records disappear
      // during a route rescan or React node replacement.
      if (this.config.enabled && this.recordsById.size < this.config.minAnswers && this._parkedCount > 0) {
        this.restoreAll();
      }
    }

    _observeLiveRecord(record) {
      if (this.intersectionObserver && record.element && typeof this.intersectionObserver.observe === "function") {
        try {
          this.intersectionObserver.observe(record.element);
        } catch (_error) {
          // An element can be replaced between registration and observation.
        }
      }
      if (this.resizeObserver && record.element && typeof this.resizeObserver.observe === "function") {
        try {
          this.resizeObserver.observe(record.element);
        } catch (_error) {
          // Resize observation is an optional optimization.
        }
      }
    }

    _unobserveLiveRecord(record) {
      if (this.intersectionObserver && record && record.element && typeof this.intersectionObserver.unobserve === "function") {
        try {
          this.intersectionObserver.unobserve(record.element);
        } catch (_error) {
          // Ignore stale observer targets.
        }
      }
      if (this.resizeObserver && record && record.element && typeof this.resizeObserver.unobserve === "function") {
        try {
          this.resizeObserver.unobserve(record.element);
        } catch (_error) {
          // Ignore stale observer targets.
        }
      }
    }

    _attachListeners() {
      if (!this.window || typeof this.window.addEventListener !== "function") {
        return;
      }
      this.window.addEventListener("scroll", this._boundScroll, { passive: true });
      this.window.addEventListener("resize", this._boundResize, { passive: true });
    }

    _detachListeners() {
      if (!this.window || typeof this.window.removeEventListener !== "function") {
        return;
      }
      this.window.removeEventListener("scroll", this._boundScroll, { passive: true });
      this.window.removeEventListener("resize", this._boundResize, { passive: true });
    }

    _observe() {
      if (!this._mutationObserverConstructor || !this.started) {
        return;
      }

      const target = this.listRoot || this._ensureListRoot();
      if (!target || typeof this._mutationObserverConstructor !== "function") {
        return;
      }

      try {
        this.observer = new this._mutationObserverConstructor((mutationRecords) => {
          this._handleMutations(mutationRecords);
        });
        // Deliberately omit subtree: only direct list children can add/remove
        // an answer, promotion, or the loading sentinel.
        this.observer.observe(target, { childList: true });
      } catch (_error) {
        this.observer = null;
      }
    }

    _handleMutations(mutationRecords) {
      if (!this.config.enabled || !this.started || !this.listRoot) {
        return;
      }

      for (const mutation of Array.from(mutationRecords || [])) {
        if (!mutation || mutation.type !== "childList" || mutation.target !== this.listRoot) {
          continue;
        }
        for (const node of Array.from(mutation.removedNodes || [])) {
          this._handleRemovedNode(node);
        }
        for (const node of Array.from(mutation.addedNodes || [])) {
          this._enqueueAddedNode(node);
        }
      }

      // A list can briefly fall below the activation threshold while Zhihu
      // replaces a batch of answers. Because parked rows remain in the DOM,
      // restoring the existing records is enough; no full rescan is needed.
      if (this._addedNodeQueue.size === 0 && this.recordsById.size < this.config.minAnswers) {
        this.restoreAll();
      }
    }

    _handleRemovedNode(node) {
      if (!node || parentOf(node) === this.listRoot) {
        return;
      }
      const record = this.records.get(node);
      // Only remove a record when the exact tracked answer node is gone. A
      // remove+insert reorder in the same parent leaves parentOf(node) at the
      // list root when this callback runs and therefore does not delete it.
      if (record && record.element === node && parentOf(node) !== this.listRoot) {
        this._deleteRecord(record);
      }
    }

    _handleAddedNode(node) {
      if (!node || parentOf(node) !== this.listRoot) {
        return;
      }
      // The loading sentinel is owned by Zhihu and must remain the last child.
      if (isListSentinel(node)) {
        return;
      }
      if (hasClass(node, "Pc-word-new")) {
        this._removePromotion(node);
        return;
      }
      if (isAnswerListItem(node)) {
        const record = this._registerAnswerElement(node);
        if (record && this.recordsById.size < this.config.minAnswers && record.parked) {
          this._restoreRecord(record);
        }
      }
    }

    _removePromotions(listRoot) {
      for (const child of directChildren(listRoot)) {
        if (hasClass(child, "Pc-word-new") && !isListSentinel(child)) {
          this._removePromotion(child);
        }
      }
    }

    _removePromotion(element) {
      if (!element || !this.listRoot || parentOf(element) !== this.listRoot || isListSentinel(element)) {
        return false;
      }
      // Zhihu owns these React nodes. Suppress their rendering/accessibility
      // exposure in place and let React perform any eventual removal itself.
      // In particular, never call removeChild/remove()/replaceWith() here.
      if (typeof element.setAttribute === "function") {
        element.setAttribute("aria-hidden", "true");
        element.setAttribute("data-zhihu-smoother-suppressed", "true");
      } else {
        element.ariaHidden = "true";
        element.dataset = element.dataset || {};
        element.dataset.zhihuSmootherSuppressed = "true";
      }
      if (element.style && element.style.display !== "none") {
        // The stylesheet is the primary suppression mechanism. This inline
        // fallback keeps lightweight DOM/test environments consistent without
        // touching child nodes or their React-owned lifecycle.
        element.style.display = "none";
      }
      return true;
    }

    _setupIntersectionObserver() {
      if (!this.started) {
        return;
      }

      if (this.intersectionObserver && typeof this.intersectionObserver.disconnect === "function") {
        this.intersectionObserver.disconnect();
      }
      this.intersectionObserver = null;

      if (typeof this._intersectionObserverConstructor !== "function") {
        return;
      }

      const rootMargin = `${this._viewportHeight() * this.config.bufferViewports}px 0px`;
      try {
        this.intersectionObserver = new this._intersectionObserverConstructor((entries) => {
          this._handleIntersections(entries);
        }, { root: null, rootMargin, threshold: 0 });
      } catch (_error) {
        this.intersectionObserver = null;
        return;
      }

      for (const record of this.recordsById.values()) {
        this._observeLiveRecord(record);
      }
    }

    _handleIntersections(entries) {
      if (!this.config.enabled || this.recordsById.size < this.config.minAnswers) {
        this.restoreAll();
        return;
      }

      // Phase 1 — decide from the observer-supplied rects without touching the
      // DOM beyond the fallback rect read.
      const parks = [];
      const restores = [];
      const measures = [];
      for (const entry of Array.from(entries || [])) {
        const target = entry && entry.target;
        const record = this._recordForElement(target);
        if (!record) {
          continue;
        }
        const rect = entry.boundingClientRect && Number.isFinite(Number(entry.boundingClientRect.top))
          ? {
            top: Number(entry.boundingClientRect.top),
            bottom: Number(entry.boundingClientRect.bottom),
            height: parsePixels(entry.boundingClientRect.height),
          }
          : getRect(target);
        const intersecting = entry.isIntersecting !== undefined
          ? Boolean(entry.isIntersecting)
          : Boolean(rect && this._isNearViewport(rect, this._viewportHeight(), this._viewportHeight() * this.config.bufferViewports));

        if (record.parked && target === record.element && intersecting) {
          restores.push(record);
        } else if (!record.parked && target === record.element && !intersecting && rect) {
          parks.push([record, rect]);
        } else if (target === record.element && intersecting) {
          measures.push([record, rect]);
        }
      }

      // Phase 2 — apply every style write before the deferred measurement reads,
      // so one observer batch costs at most a couple of forced layouts instead
      // of one per interleaved read/write pair.
      for (const [record, rect] of parks) {
        this._parkRecord(record, rect);
      }
      for (const record of restores) {
        this._restoreRecord(record);
      }
      for (const [record, rect] of measures) {
        this._maybeMeasureRecord(record, rect);
      }
    }

    _recordForElement(element) {
      if (!element) {
        return null;
      }
      const direct = this.records.get(element);
      return direct || null;
    }

    _setupResizeObserver() {
      if (this.resizeObserver && typeof this.resizeObserver.disconnect === "function") {
        this.resizeObserver.disconnect();
      }
      this.resizeObserver = null;

      if (!this.started || typeof this._resizeObserverConstructor !== "function") {
        return;
      }

      try {
        this.resizeObserver = new this._resizeObserverConstructor((entries) => {
          this._handleResizes(entries);
        });
      } catch (_error) {
        this.resizeObserver = null;
        return;
      }

      for (const record of this.recordsById.values()) {
        if (!record.parked) {
          this._observeLiveRecord(record);
        }
      }
    }

    _handleResizes(entries) {
      for (const entry of Array.from(entries || [])) {
        const target = entry && entry.target;
        const record = this._recordForElement(target);
        if (!record || record.parked || target !== record.element || !isAttached(target, this.listRoot || this.root, this.document)) {
          continue;
        }
        const rect = getRect(target);
        // ResizeObserver.contentRect is content-box sized, while every other
        // virtualizer measurement is the element's outer border box. Mixing
        // the two makes the frozen slot too short by padding and borders.
        const height = rect && rect.height;
        if (this._isUsableMeasurement(target, height, rect)) {
          this._setMeasuredHeight(record, height);
        }
      }
    }

    _handleViewportResize() {
      if (this.intersectionObserver) {
        this._setupIntersectionObserver();
      } else {
        this.scheduleUpdate();
      }
    }

    _disconnectObserver() {
      if (this.observer && typeof this.observer.disconnect === "function") {
        this.observer.disconnect();
      }
      this.observer = null;
    }

    _disconnectIntersectionObserver() {
      if (this.intersectionObserver && typeof this.intersectionObserver.disconnect === "function") {
        this.intersectionObserver.disconnect();
      }
      this.intersectionObserver = null;
    }

    _disconnectResizeObserver() {
      if (this.resizeObserver && typeof this.resizeObserver.disconnect === "function") {
        this.resizeObserver.disconnect();
      }
      this.resizeObserver = null;
    }

    _deactivate() {
      this._cancelAddedNodeQueue();
      this.cancelScheduledUpdate();
      this._clearPinRecheck();
      this._cancelRestoreMeasures();
      this._disconnectObserver();
      this._disconnectIntersectionObserver();
      this._disconnectResizeObserver();
      this._detachListeners();
      this.restoreAll();
      for (const record of this.recordsById.values()) {
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
    AnswerVirtualizer,
    Virtualizer: AnswerVirtualizer,
    createVirtualizer,
    findAnswerItems,
    isAnswerListItem,
    normalizeConfig,
  };
});
