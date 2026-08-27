/*
 * Dependency-free performance receipt for a Zhihu question page.
 *
 * It is loaded as a classic MV3 content script and also exposes CommonJS
 * exports for node:test. It only renders the supplied counters; it never
 * reads, stores, or transmits answer content.
 */
(function attachPageWidget(globalObject, factory) {
  const api = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else if (globalObject) {
    globalObject.ZhihuSmootherPageWidget = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function createPageWidgetApi() {
  "use strict";

  const WIDGET_ID = "zhihu-smoother-widget";
  const ROOT_CLASS = "zhihu-smoother-page-widget";
  const DETAILS_ID = "zhihu-smoother-widget-details";
  const DEFAULT_MIN_ANSWERS = 12;
  const STATE_KEY = "__zhihuSmootherPageWidgetState";
  const DEFAULT_EDGE_OFFSET = 18;
  const CORNER_GAP = 11;
  const COLLAPSED_WIDTH = 150;
  const EXPANDED_WIDTH = 230;
  const EXPANDED_HEIGHT_FALLBACK = 260;

  function toCount(value) {
    const count = Number(value);
    return Number.isFinite(count) && count >= 0 ? Math.floor(count) : 0;
  }

  function toBoolean(value, fallback = true) {
    if (typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value !== 0;
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (["false", "0", "off", "no", "disabled"].includes(normalized)) return false;
      if (["true", "1", "on", "yes", "enabled"].includes(normalized)) return true;
    }
    return fallback;
  }

  function getDocument(options) {
    if (options && options.document) return options.document;
    if (typeof document !== "undefined") return document;
    return null;
  }

  function getWindow(options, documentObject) {
    if (options && options.window) return options.window;
    if (documentObject && documentObject.defaultView) return documentObject.defaultView;
    if (typeof window !== "undefined") return window;
    return null;
  }

  function readRect(element) {
    if (!element || typeof element.getBoundingClientRect !== "function") return null;
    try {
      const rect = element.getBoundingClientRect();
      const left = Number(rect.left);
      const right = Number(rect.right);
      const top = Number(rect.top);
      const bottom = Number(rect.bottom);
      const width = Number(rect.width) || right - left;
      const height = Number(rect.height) || bottom - top;
      if (![left, right, top, bottom].every(Number.isFinite)) return null;
      return { left, right, top, bottom, width, height };
    } catch (_error) {
      return null;
    }
  }

  function readDimension(element, dimension, fallback) {
    const property = dimension === "width" ? "offsetWidth" : "offsetHeight";
    const value = element && Number(element[property]);
    if (Number.isFinite(value) && value > 0) return value;
    const rect = readRect(element);
    if (rect && Number.isFinite(rect[dimension]) && rect[dimension] > 0) return rect[dimension];
    return fallback;
  }

  function getViewportSize(windowObject, documentObject) {
    const documentElement = documentObject && documentObject.documentElement;
    const width = Number(windowObject && windowObject.innerWidth) || Number(documentElement && documentElement.clientWidth) || 0;
    const height = Number(windowObject && windowObject.innerHeight) || Number(documentElement && documentElement.clientHeight) || 0;
    return { width, height };
  }

  function findCornerButtonGroup(documentObject, ignoredRoot) {
    if (!documentObject || typeof documentObject.querySelectorAll !== "function") return null;
    const selectors = [".CornerButtons", ".CornerButtons--kanshan"];
    for (const selector of selectors) {
      let candidates = [];
      try {
        candidates = Array.from(documentObject.querySelectorAll(selector));
      } catch (_error) {
        candidates = [];
      }
      for (const candidate of candidates) {
        if (!candidate || candidate === ignoredRoot) continue;
        if (typeof candidate.closest === "function" && candidate.closest(".zhihu-smoother-page-widget")) continue;
        const rect = readRect(candidate);
        if (rect && rect.width > 0 && rect.height > 0) return { element: candidate, rect };
      }
    }
    return null;
  }

  function getMountRoot(documentObject, options) {
    if (options && options.root) return options.root;
    if (!documentObject) return null;
    return documentObject.body || documentObject.documentElement || null;
  }

  function findExistingRoot(documentObject, id) {
    if (!documentObject) return null;
    if (typeof documentObject.getElementById === "function") {
      const existing = documentObject.getElementById(id);
      if (existing) return existing;
    }
    if (typeof documentObject.querySelector === "function") {
      try {
        return documentObject.querySelector(`#${id}`);
      } catch (_error) {
        return null;
      }
    }
    return null;
  }

  function setText(element, value) {
    if (element) element.textContent = String(value);
  }

  function setAttribute(element, name, value) {
    if (element && typeof element.setAttribute === "function") {
      element.setAttribute(name, String(value));
    }
  }

  function appendElement(documentObject, parent, tagName, className, text) {
    if (!documentObject || typeof documentObject.createElement !== "function" || !parent) {
      return null;
    }
    const element = documentObject.createElement(tagName);
    if (className) element.className = className;
    if (text !== undefined) setText(element, text);
    parent.appendChild(element);
    return element;
  }

  function queryAllByClass(root, className) {
    if (!root || typeof root.querySelectorAll !== "function") return [];
    try {
      return Array.from(root.querySelectorAll(`.${className}`));
    } catch (_error) {
      return [];
    }
  }

  function locateRefs(root) {
    if (!root || typeof root.querySelector !== "function") return {};
    const query = (selector) => root.querySelector(selector);
    const values = queryAllByClass(root, "zhihu-smoother-widget__value");
    return {
      toggle: query(".zhihu-smoother-widget__toggle"),
      summaryMetric: query(".zhihu-smoother-widget__summary-metric"),
      summaryLabel: query(".zhihu-smoother-widget__summary-label"),
      state: query(".zhihu-smoother-widget__state"),
      stateNote: query(".zhihu-smoother-widget__state-note"),
      ratio: query(".zhihu-smoother-widget__ratio"),
      ratioLabel: query(".zhihu-smoother-widget__ratio-label"),
      progress: query(".zhihu-smoother-widget__progress"),
      parkedValue: values[0] || null,
      totalValue: values[1] || null,
      liveValue: values[2] || null,
      details: query(`#${DETAILS_ID}`) || query(".zhihu-smoother-widget__details"),
      liveStatus: query(".zhihu-smoother-widget__live-status"),
    };
  }

  function ensureElement(documentObject, options) {
    const id = (options && options.id) || WIDGET_ID;
    const existing = findExistingRoot(documentObject, id);
    if (existing) {
      return { root: existing, created: false, refs: locateRefs(existing), state: existing[STATE_KEY] || null };
    }

    const mountRoot = getMountRoot(documentObject, options);
    if (!mountRoot || !documentObject || typeof documentObject.createElement !== "function") {
      return { root: null, created: false, refs: {}, state: null };
    }

    const root = documentObject.createElement("aside");
    root.id = id;
    root.className = ROOT_CLASS;
    setAttribute(root, "id", id);
    setAttribute(root, "role", "region");
    setAttribute(root, "aria-label", "知乎顺滑器优化状态");
    setAttribute(root, "data-zhihu-smoother-widget", "true");
    setAttribute(root, "data-expanded", "false");

    const toggle = appendElement(documentObject, root, "button", "zhihu-smoother-widget__toggle");
    if (toggle) {
      setAttribute(toggle, "type", "button");
      setAttribute(toggle, "aria-expanded", "false");
      setAttribute(toggle, "aria-controls", DETAILS_ID);
      setAttribute(toggle, "aria-label", "展开优化详情");
    }
    appendElement(documentObject, toggle, "span", "zhihu-smoother-widget__title", "知乎顺滑器");
    const summary = appendElement(documentObject, toggle, "span", "zhihu-smoother-widget__summary");
    appendElement(documentObject, summary, "strong", "zhihu-smoother-widget__summary-metric", "0 / 0");
    appendElement(documentObject, summary, "span", "zhihu-smoother-widget__summary-label", "已暂存");
    appendElement(documentObject, summary, "span", "zhihu-smoother-widget__status-dot");

    const details = appendElement(documentObject, root, "section", "zhihu-smoother-widget__details");
    if (details) {
      details.id = DETAILS_ID;
      setAttribute(details, "id", DETAILS_ID);
      if ("hidden" in details) details.hidden = true;
    }

    // The live region is independent of the interactive button, so its role
    // remains valid while the details panel is collapsed or expanded.
    const liveStatus = appendElement(documentObject, details, "div", "zhihu-smoother-widget__live-status", "正在观察");
    setAttribute(liveStatus, "role", "status");
    setAttribute(liveStatus, "aria-live", "polite");
    setAttribute(liveStatus, "aria-atomic", "true");

    appendElement(documentObject, details, "p", "zhihu-smoother-widget__eyebrow", "性能票据");
    appendElement(documentObject, details, "h2", "zhihu-smoother-widget__heading", "知乎顺滑器");
    const stateLine = appendElement(documentObject, details, "p", "zhihu-smoother-widget__state-line");
    appendElement(documentObject, stateLine, "span", "zhihu-smoother-widget__state", "正在观察");
    appendElement(documentObject, stateLine, "span", "zhihu-smoother-widget__state-note", "回答窗口");

    const meter = appendElement(documentObject, details, "div", "zhihu-smoother-widget__meter");
    appendElement(documentObject, meter, "strong", "zhihu-smoother-widget__ratio", "0 / 0");
    appendElement(documentObject, meter, "span", "zhihu-smoother-widget__ratio-label", "已暂存 / 已管理");

    const progress = appendElement(documentObject, details, "progress", "zhihu-smoother-widget__progress");
    setAttribute(progress, "max", "1");
    setAttribute(progress, "value", "0");
    setAttribute(progress, "aria-label", "回答暂存进度");

    const stats = appendElement(documentObject, details, "dl", "zhihu-smoother-widget__stats");
    appendElement(documentObject, stats, "dt", "zhihu-smoother-widget__label", "已暂存");
    const parkedValue = appendElement(documentObject, stats, "dd", "zhihu-smoother-widget__value", "0");
    appendElement(documentObject, stats, "dt", "zhihu-smoother-widget__label", "已管理");
    const totalValue = appendElement(documentObject, stats, "dd", "zhihu-smoother-widget__value", "0");
    appendElement(documentObject, stats, "dt", "zhihu-smoother-widget__label", "当前可见");
    const liveValue = appendElement(documentObject, stats, "dd", "zhihu-smoother-widget__value", "0");

    const refs = {
      toggle,
      summaryMetric: summary && summary.children[0],
      summaryLabel: summary && summary.children[1],
      state: stateLine && stateLine.children[0],
      stateNote: stateLine && stateLine.children[1],
      ratio: meter && meter.children[0],
      ratioLabel: meter && meter.children[1],
      progress,
      parkedValue,
      totalValue,
      liveValue,
      details,
      liveStatus,
    };
    setAttribute(root, "data-zhihu-smoother-ready", "true");
    mountRoot.appendChild(root);
    return { root, created: true, refs, state: null };
  }

  function normalizeStats(stats) {
    const value = stats && typeof stats === "object" ? stats : {};
    const total = toCount(value.total);
    const parked = Math.min(total, toCount(value.parked));
    const liveInput = Object.prototype.hasOwnProperty.call(value, "live") ? value.live : total - parked;
    const live = Math.min(total, toCount(liveInput));
    return { total, parked, live, enabled: value.enabled !== false };
  }

  function normalizeConfig(config) {
    const value = config && typeof config === "object" ? config : {};
    const minAnswers = Number(value.minAnswers);
    return {
      enabled: toBoolean(value.enabled, true),
      showPageWidget: toBoolean(value.showPageWidget, true),
      minAnswers: Number.isFinite(minAnswers) && minAnswers > 0 ? Math.floor(minAnswers) : DEFAULT_MIN_ANSWERS,
    };
  }

  function applyExpandedState(root, refs, state, expanded) {
    if (!root) return;
    const nextExpanded = Boolean(expanded);
    if (state) state.expanded = nextExpanded;
    setAttribute(root, "data-expanded", nextExpanded ? "true" : "false");
    if (root.classList && typeof root.classList.toggle === "function") {
      root.classList.toggle("is-expanded", nextExpanded);
    }
    const toggle = refs && refs.toggle;
    if (toggle) {
      setAttribute(toggle, "aria-expanded", nextExpanded ? "true" : "false");
      setAttribute(toggle, "aria-controls", DETAILS_ID);
      setAttribute(toggle, "aria-label", nextExpanded ? "收起优化详情" : "展开优化详情");
    }
    if (refs && refs.details) refs.details.hidden = !nextExpanded;
  }

  class PageWidget {
    constructor(options) {
      const value = options && typeof options === "object" ? options : {};
      this.document = getDocument(value);
      this.window = getWindow(value, this.document);
      this.id = value.id || WIDGET_ID;
      const ensured = ensureElement(this.document, { ...value, id: this.id });
      this.root = ensured.root;
      this.created = ensured.created;
      this.refs = ensured.refs || locateRefs(this.root);
      this.destroyed = false;
      this.position = null;
      this.visible = this.root
        ? !(this.root.hidden === true ||
          (typeof this.root.getAttribute === "function" && this.root.getAttribute("aria-hidden") === "true"))
        : null;

      let state = ensured.state || (this.root && this.root[STATE_KEY]);
      if (!state && this.root) {
        state = { instances: 0, owners: [], expanded: false, lastKey: null, onToggle: null, reposition: null };
        this.root[STATE_KEY] = state;
      }
      this._state = state;
      if (this._state) {
        if (!Array.isArray(this._state.owners)) this._state.owners = [];
        this._state.instances += 1;
        this._state.owners.push(this);
        this._state.reposition = () => this.reposition();
        if (!this._state.onToggle && this.refs.toggle && typeof this.refs.toggle.addEventListener === "function") {
          const sharedRoot = this.root;
          const sharedRefs = this.refs;
          const sharedState = this._state;
          this._state.onToggle = () => {
            applyExpandedState(sharedRoot, sharedRefs, sharedState, !sharedState.expanded);
            if (typeof sharedState.reposition === "function") sharedState.reposition();
          };
          this.refs.toggle.addEventListener("click", this._state.onToggle);
        }
      }

      if (this.root) {
        this.setExpanded(Boolean(this._state && this._state.expanded));
        this.setVisible(true);
        this.reposition();
      }
    }

    get expanded() {
      if (this._state) return Boolean(this._state.expanded);
      return Boolean(this.root && this.root.getAttribute && this.root.getAttribute("data-expanded") === "true");
    }

    setExpanded(expanded) {
      if (this.destroyed || !this.root) return this;
      applyExpandedState(this.root, this.refs, this._state, expanded);
      this.reposition();
      return this;
    }

    toggleExpanded() {
      return this.setExpanded(!this.expanded);
    }

    /**
     * Keep the receipt clear of Zhihu's fixed corner controls. This performs
     * one small DOM query and two geometry reads; callers decide the cadence.
     */
    reposition() {
      if (this.destroyed || !this.root || !this.root.style) return this;

      const viewport = getViewportSize(this.window, this.document);
      const edge = viewport.width > 0 && viewport.width <= 700 ? 12 : DEFAULT_EDGE_OFFSET;
      // Width transitions report the previous rendered width during the first
      // frame. Use the target state width so expanding on a narrow viewport
      // immediately chooses the safe above-corner position instead of briefly
      // overflowing off-screen.
      const targetWidth = this.expanded ? EXPANDED_WIDTH : COLLAPSED_WIDTH;
      const viewportMaxWidth = viewport.width > 0 ? Math.max(0, viewport.width - 20) : targetWidth;
      const widgetWidth = Math.min(targetWidth, viewportMaxWidth || targetWidth);
      const widgetHeight = readDimension(this.root, "height", this.expanded ? EXPANDED_HEIGHT_FALLBACK : 44);
      const corner = findCornerButtonGroup(this.document, this.root);
      let right = edge;
      let bottom = edge;
      let mode = "fallback";

      if (corner) {
        const viewportWidth = viewport.width || Math.max(corner.rect.right + edge, widgetWidth + edge);
        const viewportHeight = viewport.height || Math.max(corner.rect.bottom + edge, widgetHeight + edge);
        const fitsLeft = corner.rect.left - CORNER_GAP - widgetWidth >= edge;
        if (fitsLeft) {
          // Align the right edge to the corner group's left edge minus the gap.
          right = Math.max(edge, viewportWidth - corner.rect.left + CORNER_GAP);
          bottom = edge;
          mode = "left-of-corner";
        } else {
          // A narrow viewport gets the receipt above the corner group.
          right = Math.max(edge, viewportWidth - corner.rect.right);
          bottom = Math.max(edge, viewportHeight - corner.rect.top + CORNER_GAP);
          mode = "above-corner";
        }
      }

      const next = { right, bottom, mode };
      if (!this.position || this.position.right !== right || this.position.bottom !== bottom || this.position.mode !== mode) {
        if (typeof this.root.style.setProperty === "function") {
          this.root.style.setProperty("--zhihu-smoother-right", `${right}px`);
          this.root.style.setProperty("--zhihu-smoother-bottom", `${bottom}px`);
        } else {
          this.root.style["--zhihu-smoother-right"] = `${right}px`;
          this.root.style["--zhihu-smoother-bottom"] = `${bottom}px`;
        }
        this.position = next;
      }
      return this;
    }

    avoidCornerButtons() {
      return this.reposition();
    }

    setVisible(visible) {
      const nextVisible = Boolean(visible);
      if (this.visible === nextVisible && this.root) return this;
      this.visible = nextVisible;
      if (!this.root) return this;
      this.root.hidden = !nextVisible;
      setAttribute(this.root, "aria-hidden", nextVisible ? "false" : "true");
      if (!nextVisible) {
        setAttribute(this.root, "data-zhihu-smoother-hidden", "true");
      } else if (typeof this.root.removeAttribute === "function") {
        this.root.removeAttribute("data-zhihu-smoother-hidden");
      }
      if (nextVisible) this.reposition();
      return this;
    }

    update(stats, config) {
      if (this.destroyed || !this.root) return this;
      const suppliedStats = stats && typeof stats === "object" ? stats : {};
      const normalizedStats = normalizeStats(suppliedStats);
      const normalizedConfig = normalizeConfig(config);
      const enabled = normalizedConfig.enabled && normalizedStats.enabled;
      const observing = enabled && normalizedStats.total < normalizedConfig.minAnswers;
      const state = !enabled ? "paused" : observing ? "observing" : "active";
      const key = [state, normalizedStats.total, normalizedStats.parked, normalizedStats.live, normalizedConfig.minAnswers].join("|");

      if (this._state && key === this._state.lastKey) return this;
      if (this._state) this._state.lastKey = key;

      const stateText = state === "active" ? "优化中" : state === "observing" ? "正在观察" : "已暂停";
      const summaryMetric = state === "observing"
        ? `${normalizedStats.total} / ${normalizedConfig.minAnswers}`
        : state === "paused"
          ? "已暂停"
          : `${normalizedStats.parked} / ${normalizedStats.total}`;
      const summaryLabel = state === "observing"
        ? "待触发"
        : state === "paused"
          ? `${normalizedStats.total} 条`
          : "已暂存";

      setText(this.refs.summaryMetric, summaryMetric);
      setText(this.refs.summaryLabel, summaryLabel);
      setText(this.refs.state, stateText);
      setText(this.refs.stateNote, state === "observing" ? `达到 ${normalizedConfig.minAnswers} 个回答后暂存` : "回答窗口");
      setText(this.refs.liveStatus, `${stateText}，已暂存 ${normalizedStats.parked} / 已管理 ${normalizedStats.total}，当前可见 ${normalizedStats.live}`);
      setText(this.refs.ratio, `${normalizedStats.parked} / ${normalizedStats.total}`);
      setText(this.refs.ratioLabel, "已暂存 / 已管理");
      setText(this.refs.parkedValue, normalizedStats.parked);
      setText(this.refs.totalValue, normalizedStats.total);
      setText(this.refs.liveValue, normalizedStats.live);

      if (this.refs.progress) {
        const max = Math.max(normalizedStats.total, 1);
        setAttribute(this.refs.progress, "max", max);
        setAttribute(this.refs.progress, "value", normalizedStats.parked);
        this.refs.progress.max = max;
        this.refs.progress.value = normalizedStats.parked;
      }
      if (this.root.classList && typeof this.root.classList.remove === "function") {
        this.root.classList.remove("is-active", "is-observing", "is-paused");
        if (typeof this.root.classList.add === "function") this.root.classList.add(`is-${state}`);
      }
      setAttribute(this.root, "data-state", state);
      return this;
    }

    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      if (this._state) {
        if (Array.isArray(this._state.owners)) {
          this._state.owners = this._state.owners.filter((owner) => owner !== this);
        }
        this._state.instances = Math.max(0, this._state.instances - 1);
        if (this._state.instances === 0) {
          if (this.refs.toggle && this._state.onToggle && typeof this.refs.toggle.removeEventListener === "function") {
            this.refs.toggle.removeEventListener("click", this._state.onToggle);
          }
          this._state.onToggle = null;
          if (this.root) {
            try { delete this.root[STATE_KEY]; } catch (_error) { this.root[STATE_KEY] = null; }
          }
          if (this.root && this.root.parentNode && typeof this.root.parentNode.removeChild === "function") {
            this.root.parentNode.removeChild(this.root);
          } else if (this.root && typeof this.root.remove === "function") {
            this.root.remove();
          }
        } else {
          const owner = this._state.owners && this._state.owners[this._state.owners.length - 1];
          this._state.reposition = owner ? () => owner.reposition() : null;
        }
      } else if (this.root && this.root.parentNode && typeof this.root.parentNode.removeChild === "function") {
        this.root.parentNode.removeChild(this.root);
      }
      this.root = null;
      this.refs = {};
    }
  }

  function createPageWidget(options) {
    return new PageWidget(options);
  }

  return {
    DEFAULT_MIN_ANSWERS,
    PageWidget,
    WIDGET_ID,
    createPageWidget,
  };
});
