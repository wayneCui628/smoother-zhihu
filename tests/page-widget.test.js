const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { createPageWidget, WIDGET_ID } = require("../src/content/page-widget.js");

class FakeClassList {
  constructor(owner) {
    this.owner = owner;
  }

  values() {
    return new Set(String(this.owner.className || "").split(/\s+/).filter(Boolean));
  }

  add(...names) {
    const values = this.values();
    names.forEach((name) => values.add(name));
    this.owner.className = [...values].join(" ");
  }

  remove(...names) {
    const values = this.values();
    names.forEach((name) => values.delete(name));
    this.owner.className = [...values].join(" ");
  }

  toggle(name, force) {
    const shouldHave = force === undefined ? !this.contains(name) : Boolean(force);
    if (shouldHave) this.add(name);
    else this.remove(name);
    return shouldHave;
  }

  contains(name) {
    return this.values().has(name);
  }
}

class FakeElement {
  constructor(tagName) {
    this.tagName = String(tagName).toUpperCase();
    this.id = "";
    this.className = "";
    this.classList = new FakeClassList(this);
    this.children = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.style = {
      values: new Map(),
      setProperty: (name, value) => this.style.values.set(name, String(value)),
      getPropertyValue: (name) => this.style.values.get(name) || "",
    };
    this.hidden = false;
    this.textContent = "";
    this.listeners = new Map();
    this._rect = { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 };
  }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  removeChild(child) {
    this.children = this.children.filter((candidate) => candidate !== child);
    child.parentNode = null;
    return child;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  dispatchEvent(event) {
    for (const listener of this.listeners.get(event.type) || []) listener.call(this, event);
    return true;
  }

  getBoundingClientRect() {
    return { ...this._rect };
  }

  matches(selector) {
    if (selector.startsWith("#")) return this.id === selector.slice(1);
    if (selector.startsWith(".")) return this.classList.contains(selector.slice(1));
    return false;
  }

  descendants() {
    return this.children.flatMap((child) => [child, ...child.descendants()]);
  }

  querySelector(selector) {
    return this.descendants().find((node) => node.matches(selector)) || null;
  }

  querySelectorAll(selector) {
    return this.descendants().filter((node) => node.matches(selector));
  }
}

function createDocument() {
  const documentElement = new FakeElement("html");
  const body = new FakeElement("body");
  documentElement.appendChild(body);
  return {
    body,
    documentElement,
    createElement(tagName) {
      return new FakeElement(tagName);
    },
    getElementById(id) {
      return [documentElement, ...documentElement.descendants()]
        .find((node) => node.id === id) || null;
    },
    querySelector(selector) {
      return documentElement.matches(selector) ? documentElement : documentElement.querySelector(selector);
    },
    querySelectorAll(selector) {
      return [documentElement, ...documentElement.descendants()]
        .filter((node) => node.matches(selector));
    },
  };
}

test("renders observing, active, and paused states from supplied counts", () => {
  const document = createDocument();
  const widget = createPageWidget({ document });
  const root = document.getElementById(WIDGET_ID);

  widget.update(
    { total: 8, parked: 0, live: 8, enabled: true },
    { enabled: true, showPageWidget: true, minAnswers: 12 },
  );
  assert.equal(root.getAttribute("data-state"), "observing");
  assert.equal(root.querySelector(".zhihu-smoother-widget__state").textContent, "正在观察");

  widget.update(
    { total: 35, parked: 22, live: 13, enabled: true },
    { enabled: true, showPageWidget: true, minAnswers: 12 },
  );
  assert.equal(root.getAttribute("data-state"), "active");
  assert.equal(root.querySelector(".zhihu-smoother-widget__ratio").textContent, "22 / 35");
  assert.equal(root.querySelector(".zhihu-smoother-widget__progress").value, 22);

  widget.update(
    { total: 35, parked: 0, live: 35, enabled: false },
    { enabled: false, showPageWidget: true, minAnswers: 12 },
  );
  assert.equal(root.getAttribute("data-state"), "paused");
  assert.equal(root.querySelector(".zhihu-smoother-widget__state").textContent, "已暂停");
});

test("visibility is reversible and duplicate construction reuses one root", () => {
  const document = createDocument();
  const first = createPageWidget({ document });
  const second = createPageWidget({ document });

  assert.equal(first.root, second.root);
  assert.equal(document.body.children.length, 1);

  first.setVisible(false);
  assert.equal(first.root.hidden, true);
  assert.equal(first.root.getAttribute("aria-hidden"), "true");

  first.setVisible(true);
  assert.equal(first.root.hidden, false);
  assert.equal(first.root.getAttribute("aria-hidden"), "false");

  first.destroy();
  assert.notEqual(document.getElementById(WIDGET_ID), null);
  second.destroy();
  assert.equal(document.getElementById(WIDGET_ID), null);
});

test("toggle is native, updates aria state, and survives duplicate instance teardown", () => {
  const document = createDocument();
  const first = createPageWidget({ document });
  const second = createPageWidget({ document });
  const root = first.root;
  const toggle = root.querySelector(".zhihu-smoother-widget__toggle");

  assert.equal(first.expanded, false);
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  assert.equal(toggle.getAttribute("aria-label"), "展开优化详情");
  assert.equal(toggle.getAttribute("aria-controls"), "zhihu-smoother-widget-details");

  first.destroy();
  toggle.dispatchEvent({ type: "click" });
  assert.equal(second.expanded, true);
  assert.equal(root.getAttribute("data-expanded"), "true");
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  assert.equal(toggle.getAttribute("aria-label"), "收起优化详情");

  second.setExpanded(false);
  assert.equal(second.expanded, false);
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  second.setExpanded(true);
  second.update(
    { total: 35, parked: 22, live: 13, enabled: true },
    { enabled: true, showPageWidget: true, minAnswers: 12 },
  );
  assert.equal(second.expanded, true, "data updates must not change the user's expansion state");
  second.destroy();
  assert.equal(document.getElementById(WIDGET_ID), null);
  assert.equal(toggle.listeners.get("click")?.size || 0, 0);
});

test("collapsed receipt CSS stays compact and avoids the corner controls", () => {
  const css = fs.readFileSync(path.join(__dirname, "../src/content/content.css"), "utf8");
  assert.match(css, /\.zhihu-smoother-page-widget\s*\{[\s\S]*right:\s*var\(--zhihu-smoother-right,\s*18px\);/);
  assert.match(css, /\.zhihu-smoother-page-widget\[data-expanded="false"\]\s*\{[\s\S]*width:\s*150px;[\s\S]*height:\s*44px;/);
  assert.match(css, /\.zhihu-smoother-page-widget\[data-expanded="true"\]\s*\{[\s\S]*max-height:\s*calc\(100vh\s*-\s*var\(--zhihu-smoother-bottom,\s*18px\)\s*-\s*12px\);/);
  assert.match(css, /\.zhihu-smoother-widget__details\s*\{[\s\S]*display:\s*none;/);
  assert.match(css, /\.zhihu-smoother-page-widget\s*\{[\s\S]*pointer-events:\s*auto;/);
});

test("reposition avoids official corner controls and falls back without them", () => {
  const document = createDocument();
  const corner = new FakeElement("div");
  corner.className = "CornerButtons CornerButtons--kanshan";
  corner._rect = { left: 1809, right: 1869, top: 745, bottom: 905, width: 60, height: 160 };
  document.body.appendChild(corner);
  const widget = createPageWidget({
    document,
    window: { innerWidth: 1912, innerHeight: 909 },
  });

  assert.equal(widget.position.mode, "left-of-corner");
  assert.equal(widget.root.style.getPropertyValue("--zhihu-smoother-right"), "114px");
  assert.equal(widget.root.style.getPropertyValue("--zhihu-smoother-bottom"), "18px");

  corner._rect = { left: 160, right: 220, top: 220, bottom: 308, width: 60, height: 88 };
  const narrowWidget = createPageWidget({
    document: createDocument(),
    window: { innerWidth: 320, innerHeight: 320 },
  });
  const narrowCorner = new FakeElement("div");
  narrowCorner.className = "CornerButtons";
  narrowCorner._rect = { left: 160, right: 220, top: 220, bottom: 308, width: 60, height: 88 };
  narrowWidget.document.body.appendChild(narrowCorner);
  narrowWidget.reposition();
  assert.equal(narrowWidget.position.mode, "above-corner");
  assert.equal(narrowWidget.root.style.getPropertyValue("--zhihu-smoother-bottom"), "111px");

  const transitionDocument = createDocument();
  const transitionCorner = new FakeElement("div");
  transitionCorner.className = "CornerButtons";
  transitionCorner._rect = { left: 202, right: 262, top: 412, bottom: 500, width: 60, height: 88 };
  transitionDocument.body.appendChild(transitionCorner);
  const transitionWidget = createPageWidget({
    document: transitionDocument,
    window: { innerWidth: 320, innerHeight: 500 },
  });
  assert.equal(transitionWidget.position.mode, "left-of-corner", "collapsed receipt still fits beside the controls");
  transitionWidget.setExpanded(true);
  assert.equal(transitionWidget.position.mode, "above-corner", "expanded target width must be used before its CSS transition settles");
  assert.equal(transitionWidget.root.style.getPropertyValue("--zhihu-smoother-bottom"), "99px");

  const fallbackDocument = createDocument();
  const fallback = createPageWidget({ document: fallbackDocument, window: { innerWidth: 1000, innerHeight: 800 } });
  assert.equal(fallback.position.mode, "fallback");
  assert.equal(fallback.root.style.getPropertyValue("--zhihu-smoother-right"), "18px");
  assert.equal(fallback.root.style.getPropertyValue("--zhihu-smoother-bottom"), "18px");
  widget.destroy();
  narrowWidget.destroy();
  transitionWidget.destroy();
  fallback.destroy();
});
