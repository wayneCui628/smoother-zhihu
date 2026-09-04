const test = require("node:test");
const assert = require("node:assert/strict");

const {
  AnswerVirtualizer,
  findAnswerItems,
  normalizeConfig,
} = require("../src/content/virtualizer.js");

class FakeClassList {
  constructor(value = "") {
    this.values = new Set(value.split(/\s+/).filter(Boolean));
  }

  add(...names) {
    names.forEach((name) => this.values.add(name));
  }

  remove(...names) {
    names.forEach((name) => this.values.delete(name));
  }

  contains(name) {
    return this.values.has(name);
  }

  toString() {
    return [...this.values].join(" ");
  }
}

class FakeElement {
  constructor(className = "", attributes = {}, rect = { top: 0, bottom: 0, height: 0 }, tagName = "div") {
    this.classList = new FakeClassList(className);
    this.attributes = { ...attributes };
    this.children = [];
    this.parentNode = null;
    this.ownerDocument = null;
    this.tagName = tagName.toUpperCase();
    this.nodeType = 1;
    this.hidden = false;
    this.style = {};
    this._rect = { ...rect };
  }

  get parentElement() {
    return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null;
  }

  // Mirrors the real DOM: attached means reachable from the document root.
  // The virtualizer's isAttached() relies on this instead of falling back to
  // a parentNode truthiness check, which misreports a detached subtree.
  get isConnected() {
    let current = this;
    while (current) {
      if (current.nodeType === 9) {
        return true;
      }
      current = current.parentNode;
    }
    return false;
  }

  get className() {
    return this.classList.toString();
  }

  set className(value) {
    this.classList = new FakeClassList(value);
  }

  appendChild(child) {
    child.parentNode = this;
    child.ownerDocument = this.ownerDocument || (this.nodeType === 9 ? this : null);
    this.children.push(child);
    return child;
  }

  insertBefore(child, reference) {
    child.parentNode = this;
    child.ownerDocument = this.ownerDocument || (this.nodeType === 9 ? this : null);
    const index = this.children.indexOf(reference);
    if (index < 0) return this.appendChild(child);
    this.children.splice(index, 0, child);
    return child;
  }

  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index < 0) throw new Error("child not found");
    this.children.splice(index, 1);
    child.parentNode = null;
    return child;
  }

  replaceChild(next, previous) {
    const index = this.children.indexOf(previous);
    if (index < 0) throw new Error("child not found");
    next.parentNode = this;
    next.ownerDocument = this.ownerDocument;
    next._rect = { ...previous._rect };
    previous.parentNode = null;
    this.children[index] = next;
    return previous;
  }

  replaceWith(next) {
    if (!this.parentNode) throw new Error("detached element");
    this.parentNode.replaceChild(next, this);
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name)
      ? this.attributes[name]
      : null;
  }

  matches(selector) {
    const tag = selector.match(/^[a-zA-Z][\w-]*/);
    if (tag && this.tagName.toLowerCase() !== tag[0].toLowerCase()) return false;
    for (const className of selector.match(/\.[\w-]+/g) || []) {
      if (!this.classList.contains(className.slice(1))) return false;
    }
    for (const token of selector.match(/\[([^\]=]+)(?:=["']?([^\]"']+)["']?)?\]/g) || []) {
      const parsed = token.match(/\[([^\]=]+)(?:=["']?([^\]"']+)["']?)?\]/);
      const actual = this.getAttribute(parsed[1].trim());
      if (actual === null || (parsed[2] !== undefined && actual !== parsed[2])) return false;
    }
    return Boolean(tag || selector.startsWith(".") || selector.startsWith("["));
  }

  querySelectorAll(selector) {
    const result = [];
    const visit = (node) => {
      for (const child of node.children) {
        if (child.matches(selector)) result.push(child);
        visit(child);
      }
    };
    visit(this);
    return result;
  }

  getBoundingClientRect() {
    return { ...this._rect };
  }

  contains(node) {
    if (node === this) return true;
    return this.children.some((child) => child.contains(node));
  }
}

class FakeDocument extends FakeElement {
  constructor() {
    super("", {}, { top: 0, bottom: 0, height: 0 }, "html");
    this.nodeType = 9;
    this.documentElement = new FakeElement();
    this.documentElement.tagName = "HTML";
    this.documentElement.ownerDocument = this;
    this.scrollingElement = this.documentElement;
    this.appendChild(this.documentElement);
    this.activeElement = null;
  }

  createElement(tagName = "div") {
    const element = new FakeElement("", {}, { top: 0, bottom: 0, height: 0 }, tagName);
    element.ownerDocument = this;
    return element;
  }
}

function makeAnswer(rect, dataZop = JSON.stringify({ type: "answer" }), options = {}) {
  const outer = new FakeElement("List-item", {}, rect);
  const answer = new FakeElement("ContentItem AnswerItem", { "data-zop": dataZop, ...(options.name ? { name: options.name } : {}) });
  outer.appendChild(answer);
  if (options.contentVisibility) outer.style.contentVisibility = options.contentVisibility;
  return outer;
}

function makeQuestionColumn(rows) {
  const documentObject = new FakeDocument();
  const column = new FakeElement("Question-mainColumn");
  rows.forEach((row) => column.appendChild(row));
  documentObject.documentElement.appendChild(column);
  return { documentObject, column };
}

function fakeWindow() {
  const listeners = new Map();
  const animationFrames = new Map();
  let nextAnimationFrameId = 1;
  return {
    innerHeight: 100,
    scrollY: 0,
    scrollX: 0,
    scrollCalls: [],
    listeners,
    addEventListener(type, callback) {
      listeners.set(type, callback);
    },
    removeEventListener(type) {
      listeners.delete(type);
    },
    trigger(type) {
      const callback = listeners.get(type);
      if (callback) callback();
    },
    scrollTo(_x, y) {
      this.scrollCalls.push(y);
      this.scrollY = y;
    },
    requestAnimationFrame(callback) {
      const id = nextAnimationFrameId++;
      animationFrames.set(id, callback);
      return id;
    },
    cancelAnimationFrame(id) {
      animationFrames.delete(id);
    },
    flushAnimationFrame() {
      const frame = [...animationFrames.entries()];
      animationFrames.clear();
      for (const [, callback] of frame) {
        callback(0);
      }
    },
    pendingAnimationFrameCount() {
      return animationFrames.size;
    },
    getComputedStyle(element) {
      return {
        height: element.style.height || "",
        contentVisibility: element.style.contentVisibility || "",
        containIntrinsicSize: element.style.containIntrinsicSize || "",
        paddingTop: element.style.paddingTop || "",
        paddingBottom: element.style.paddingBottom || "",
        borderTopWidth: element.style.borderTopWidth || "",
        borderBottomWidth: element.style.borderBottomWidth || "",
        display: element.style.display || "",
        visibility: element.style.visibility || "",
      };
    },
  };
}

function createFakeTimers() {
  const timers = new Map();
  let nextId = 1;
  return {
    setTimeout(callback, delay) {
      const id = nextId++;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    pendingCount() {
      return timers.size;
    },
    runAll() {
      const pending = [...timers.values()];
      timers.clear();
      for (const { callback } of pending) callback();
    },
    nextDelay() {
      const first = timers.values().next().value;
      return first ? first.delay : null;
    },
  };
}

function makeQuestionPage(rows, extras = {}) {
  const documentObject = new FakeDocument();
  const windowObject = fakeWindow();
  documentObject.defaultView = windowObject;
  const answers = new FakeElement("QuestionAnswers-answers");
  const listRoot = new FakeElement("css-0");
  answers.appendChild(listRoot);
  documentObject.documentElement.appendChild(answers);
  rows.forEach((row) => listRoot.appendChild(row));
  (extras.promotions || []).forEach((promotion) => listRoot.appendChild(promotion));
  const sentinel = new FakeElement("", { role: "listitem" }, { top: 0, bottom: 0, height: 0 });
  listRoot.appendChild(sentinel);
  return { documentObject, windowObject, answers, listRoot, sentinel };
}

class FakeMutationObserver {
  static instances = [];

  constructor(callback) {
    this.callback = callback;
    this.target = null;
    this.options = null;
    FakeMutationObserver.instances.push(this);
  }

  observe(target, options) {
    this.target = target;
    this.options = options;
  }

  disconnect() {
    this.disconnected = true;
  }

  trigger(records) {
    this.callback(records);
  }
}

class FakeIntersectionObserver {
  static instances = [];

  constructor(callback, options) {
    this.callback = callback;
    this.options = options;
    this.targets = new Set();
    FakeIntersectionObserver.instances.push(this);
  }

  observe(target) {
    this.targets.add(target);
  }

  unobserve(target) {
    this.targets.delete(target);
  }

  disconnect() {
    this.disconnected = true;
    this.targets.clear();
  }

  trigger(entries) {
    this.callback(entries);
  }
}

class FakeResizeObserver {
  static instances = [];

  constructor(callback) {
    this.callback = callback;
    this.targets = new Set();
    FakeResizeObserver.instances.push(this);
  }

  observe(target) {
    this.targets.add(target);
  }

  unobserve(target) {
    this.targets.delete(target);
  }

  disconnect() {
    this.disconnected = true;
    this.targets.clear();
  }

  trigger(entries) {
    this.callback(entries);
  }
}

test("normalizeConfig applies defaults, types, and safe bounds", () => {
  assert.deepEqual(normalizeConfig(), {
    enabled: true,
    bufferViewports: 2,
    minAnswers: 5,
    showPageWidget: true,
  });
  assert.deepEqual(normalizeConfig({ enabled: "false", bufferViewports: -3, minAnswers: 50000 }), {
    enabled: false,
    bufferViewports: 1,
    minAnswers: 1000,
    showPageWidget: true,
  });
  assert.deepEqual(normalizeConfig({ enabled: "yes", bufferViewports: "2.6", minAnswers: "8.4" }), {
    enabled: true,
    bufferViewports: 3,
    minAnswers: 8,
    showPageWidget: true,
  });
  assert.equal(normalizeConfig({ showPageWidget: "false" }).showPageWidget, false);
  assert.equal(normalizeConfig({ showPageWidget: "unexpected" }).showPageWidget, true);
  assert.equal(normalizeConfig({ minAnswers: 12 }).minAnswers, 5);
  assert.equal(normalizeConfig({ minAnswers: "12" }).minAnswers, 5);
  assert.equal(normalizeConfig({ minAnswers: null }).minAnswers, 5);
  assert.equal(normalizeConfig({ minAnswers: "" }).minAnswers, 5);
  assert.equal(normalizeConfig({ minAnswers: false }).minAnswers, 5);
  assert.equal(normalizeConfig({ minAnswers: [] }).minAnswers, 5);
  assert.equal(normalizeConfig({ minAnswers: "   " }).minAnswers, 5);
  assert.equal(normalizeConfig({ bufferViewports: null }).bufferViewports, 2);
  assert.equal(normalizeConfig({ bufferViewports: "" }).bufferViewports, 2);
  assert.equal(normalizeConfig({ bufferViewports: "   " }).bufferViewports, 2);
});

test("findAnswerItems recognizes answers and excludes comment rows", () => {
  const validAnswer = makeAnswer({ top: 0, bottom: 80, height: 80 });
  const malformedAnswer = makeAnswer({ top: 100, bottom: 180, height: 80 }, "not-json");
  const nonAnswer = makeAnswer({ top: 200, bottom: 280, height: 80 }, JSON.stringify({ type: "comment" }));
  const comment = new FakeElement("List-item", {}, { top: 300, bottom: 340, height: 40 });
  comment.appendChild(new FakeElement("CommentItem", { "data-zop": JSON.stringify({ type: "comment" }) }));

  const { documentObject } = makeQuestionColumn([validAnswer, malformedAnswer, nonAnswer, comment]);
  assert.deepEqual(findAnswerItems(documentObject), [validAnswer, malformedAnswer]);
});

test("parks far answers and restores the original element near the buffer", () => {
  const rows = [makeAnswer({ top: 20, bottom: 100, height: 80 })];
  for (let index = 0; index < 11; index += 1) {
    rows.push(makeAnswer({ top: 1000 + index * 100, bottom: 1080 + index * 100, height: 80 }));
  }
  const { documentObject } = makeQuestionColumn(rows);
  const windowObject = fakeWindow();
  const virtualizer = new AnswerVirtualizer({
    document: documentObject,
    window: windowObject,
    config: { enabled: true, bufferViewports: 1, minAnswers: 12 },
  });

  virtualizer.start();
  assert.equal(virtualizer.getStats().total, 12);
  assert.ok(virtualizer.getStats().parked > 0);
  const farAnswer = rows[1];
  const record = virtualizer.records.get(farAnswer);
  assert.equal(record.parked, true);
  assert.equal(farAnswer.parentNode, documentObject.querySelectorAll(".Question-mainColumn")[0]);
  assert.equal(farAnswer.classList.contains("zhihu-smoother-parked"), true);
  assert.equal(farAnswer.style.contentVisibility, "hidden");
  assert.equal(farAnswer.style.containIntrinsicSize, "");
  assert.equal(farAnswer.style.containIntrinsicInlineSize, "none");
  assert.equal(farAnswer.style.containIntrinsicBlockSize, "80px");
  assert.deepEqual(windowObject.scrollCalls, []);

  farAnswer._rect = { top: 30, bottom: 110, height: 80 };
  virtualizer.updateWindow();
  assert.equal(record.parked, false);
  assert.equal(farAnswer.parentNode, documentObject.querySelectorAll(".Question-mainColumn")[0]);
  assert.equal(virtualizer.getStats().parked < 11, true);
  assert.deepEqual(windowObject.scrollCalls, []);

  virtualizer.destroy();
  assert.equal(virtualizer.getStats().parked, 0);
  assert.equal(virtualizer.getStats().live, 0);
});

test("locates the anonymous real answer list and preserves its loading sentinel", () => {
  const rows = [
    makeAnswer({ top: 10, bottom: 230, height: 220 }, JSON.stringify({ type: "answer", itemId: "a-1" })),
    makeAnswer({ top: 240, bottom: 460, height: 220 }, JSON.stringify({ type: "answer", itemId: "a-2" })),
  ];
  const promotion = new FakeElement("Pc-word-new", {}, { top: 500, bottom: 540, height: 40 });
  const page = makeQuestionPage(rows, { promotions: [promotion] });
  const virtualizer = new AnswerVirtualizer({
    document: page.documentObject,
    window: page.windowObject,
    root: page.documentObject,
    config: { enabled: true, minAnswers: 1 },
  });

  virtualizer.start();

  assert.equal(virtualizer.listRoot, page.listRoot);
  assert.deepEqual(findAnswerItems(page.documentObject), rows);
  assert.equal(page.listRoot.children.includes(promotion), true);
  assert.equal(promotion.getAttribute("aria-hidden"), "true");
  assert.equal(promotion.getAttribute("data-zhihu-smoother-suppressed"), "true");
  assert.equal(promotion.style.display, "none");
  assert.equal(page.listRoot.children.at(-1), page.sentinel);
  virtualizer.destroy();
});

test("suppresses an above-viewport promotion without removing or scrolling", () => {
  const promotion = new FakeElement("Pc-word-new", {}, { top: -80, bottom: 0, height: 80 });
  const page = makeQuestionPage([makeAnswer({ top: 20, bottom: 240, height: 220 })], { promotions: [promotion] });
  page.windowObject.scrollY = 500;
  const virtualizer = new AnswerVirtualizer({
    document: page.documentObject,
    window: page.windowObject,
    config: { enabled: true, minAnswers: 1 },
  });

  virtualizer.start();

  assert.equal(promotion.parentNode, page.listRoot);
  assert.equal(promotion.getAttribute("aria-hidden"), "true");
  assert.equal(promotion.getAttribute("data-zhihu-smoother-suppressed"), "true");
  assert.equal(page.windowObject.scrollY, 500);
  assert.equal(page.listRoot.children.at(-1), page.sentinel);
  virtualizer.destroy();
});

test("mutation observer processes only direct added nodes and keeps the sentinel", () => {
  FakeMutationObserver.instances.length = 0;
  const page = makeQuestionPage([makeAnswer({ top: 20, bottom: 240, height: 220 })]);
  const virtualizer = new AnswerVirtualizer({
    document: page.documentObject,
    window: page.windowObject,
    MutationObserver: FakeMutationObserver,
    config: { enabled: true, minAnswers: 1 },
  });
  virtualizer.start();
  const observer = FakeMutationObserver.instances.at(-1);
  assert.equal(observer.target, page.listRoot);
  assert.deepEqual(observer.options, { childList: true });

  let scanCalls = 0;
  virtualizer.scan = () => {
    scanCalls += 1;
    throw new Error("incremental mutation must not rescan");
  };
  const added = makeAnswer({ top: 250, bottom: 470, height: 220 }, JSON.stringify({ type: "answer", itemId: "new-answer" }));
  page.listRoot.insertBefore(added, page.sentinel);
  observer.trigger([{ type: "childList", target: page.listRoot, addedNodes: [added] }]);

  assert.equal(scanCalls, 0);
  assert.equal(virtualizer.getStats().total, 1);
  page.windowObject.flushAnimationFrame();
  assert.equal(virtualizer.getStats().total, 2);
  assert.equal(page.listRoot.children.at(-1), page.sentinel);

  const promotion = new FakeElement("Pc-word-new", {}, { top: -40, bottom: 0, height: 40 });
  page.listRoot.insertBefore(promotion, page.sentinel);
  observer.trigger([{ type: "childList", target: page.listRoot, addedNodes: [promotion] }]);
  assert.equal(promotion.getAttribute("data-zhihu-smoother-suppressed"), null);
  page.windowObject.flushAnimationFrame();
  assert.equal(promotion.parentNode, page.listRoot);
  assert.equal(promotion.getAttribute("data-zhihu-smoother-suppressed"), "true");
  virtualizer.destroy();
});

test("registers a whole mutation batch in a single frame to keep the document tall", () => {
  FakeMutationObserver.instances.length = 0;
  const page = makeQuestionPage([makeAnswer({ top: 20, bottom: 240, height: 220 })]);
  const virtualizer = new AnswerVirtualizer({
    document: page.documentObject,
    window: page.windowObject,
    MutationObserver: FakeMutationObserver,
    config: { enabled: true, minAnswers: 1 },
  });
  virtualizer.start();
  const observer = FakeMutationObserver.instances.at(-1);
  const added = [
    makeAnswer({ top: 250, bottom: 470, height: 220 }, JSON.stringify({ type: "answer", itemId: "batch-1" })),
    makeAnswer({ top: 480, bottom: 700, height: 220 }, JSON.stringify({ type: "answer", itemId: "batch-2" })),
    makeAnswer({ top: 710, bottom: 930, height: 220 }, JSON.stringify({ type: "answer", itemId: "batch-3" })),
  ];
  added.forEach((row) => page.listRoot.insertBefore(row, page.sentinel));
  observer.trigger([{ type: "childList", target: page.listRoot, addedNodes: [...added, added[0]] }]);

  // Zhihu's infinite-scroll sentinel measures its distance through the live
  // document height. Rows stay folded at the CSS seed height until they are
  // registered, so stretching one registration per frame keeps the document
  // artificially short and re-triggers loading. The whole batch must settle
  // within a single frame (duplicate queue entries deduped).
  assert.equal(virtualizer.getStats().total, 1);
  assert.equal(page.windowObject.pendingAnimationFrameCount(), 1);
  page.windowObject.flushAnimationFrame();
  assert.equal(virtualizer.getStats().total, 4);
  assert.equal(virtualizer.records.get(added[1]).id, "item:batch-2");
  assert.equal(page.windowObject.pendingAnimationFrameCount(), 0);
  virtualizer.destroy();
});

test("does not register an added node removed before its queued frame", () => {
  FakeMutationObserver.instances.length = 0;
  const page = makeQuestionPage([makeAnswer({ top: 20, bottom: 240, height: 220 })]);
  const virtualizer = new AnswerVirtualizer({
    document: page.documentObject,
    window: page.windowObject,
    MutationObserver: FakeMutationObserver,
    config: { enabled: true, minAnswers: 1 },
  });
  virtualizer.start();
  const observer = FakeMutationObserver.instances.at(-1);
  const added = makeAnswer({ top: 250, bottom: 470, height: 220 }, JSON.stringify({ type: "answer", itemId: "removed-before-frame" }));
  page.listRoot.insertBefore(added, page.sentinel);
  observer.trigger([{ type: "childList", target: page.listRoot, addedNodes: [added] }]);
  assert.equal(page.windowObject.pendingAnimationFrameCount(), 1);

  page.listRoot.removeChild(added);
  observer.trigger([{ type: "childList", target: page.listRoot, removedNodes: [added], addedNodes: [] }]);
  page.windowObject.flushAnimationFrame();

  assert.equal(virtualizer.getStats().total, 1);
  assert.equal(virtualizer.records.get(added), undefined);
  assert.equal(page.windowObject.pendingAnimationFrameCount(), 0);
  virtualizer.destroy();
});

test("stop, destroy, and disable cancel queued additions", () => {
  for (const action of ["stop", "destroy", "disable"]) {
    FakeMutationObserver.instances.length = 0;
    const page = makeQuestionPage([makeAnswer({ top: 20, bottom: 240, height: 220 })]);
    const virtualizer = new AnswerVirtualizer({
      document: page.documentObject,
      window: page.windowObject,
      MutationObserver: FakeMutationObserver,
      config: { enabled: true, minAnswers: 1 },
    });
    virtualizer.start();
    const observer = FakeMutationObserver.instances.at(-1);
    const added = makeAnswer({ top: 250, bottom: 470, height: 220 }, JSON.stringify({ type: "answer", itemId: `cancel-${action}` }));
    page.listRoot.insertBefore(added, page.sentinel);
    observer.trigger([{ type: "childList", target: page.listRoot, addedNodes: [added] }]);
    assert.equal(page.windowObject.pendingAnimationFrameCount(), 1);

    if (action === "stop") {
      virtualizer.stop();
    } else if (action === "destroy") {
      virtualizer.destroy();
    } else {
      virtualizer.updateConfig({ enabled: false });
    }
    page.windowObject.flushAnimationFrame();

    assert.equal(virtualizer._addedNodeQueue.size, 0);
    assert.equal(page.windowObject.pendingAnimationFrameCount(), 0);
    assert.equal(virtualizer.records.get(added), undefined);
    if (action !== "destroy") {
      virtualizer.destroy();
    }
  }
});

test("stable itemId rebinds a React replacement without creating a duplicate record", () => {
  FakeIntersectionObserver.instances.length = 0;
  const original = makeAnswer({ top: 20, bottom: 240, height: 220 }, JSON.stringify({ type: "answer", itemId: 123 }));
  const page = makeQuestionPage([original]);
  const virtualizer = new AnswerVirtualizer({
    document: page.documentObject,
    window: page.windowObject,
    MutationObserver: FakeMutationObserver,
    IntersectionObserver: FakeIntersectionObserver,
    config: { enabled: true, minAnswers: 1 },
  });
  virtualizer.start();
  const observer = FakeMutationObserver.instances.at(-1);
  const replacement = makeAnswer({ top: 20, bottom: 240, height: 220 }, JSON.stringify({ type: "answer", itemId: 123 }));
  page.listRoot.insertBefore(replacement, page.sentinel);
  observer.trigger([{ type: "childList", target: page.listRoot, addedNodes: [replacement] }]);
  assert.equal(virtualizer.records.get(replacement), undefined);
  page.windowObject.flushAnimationFrame();

  assert.equal(virtualizer.getStats().total, 1);
  assert.equal(virtualizer.records.get(replacement).id, "item:123");
  assert.equal(original.parentNode, page.listRoot);
  assert.equal(replacement.parentNode, page.listRoot);
  const intersection = FakeIntersectionObserver.instances.at(-1);
  assert.equal(intersection.targets.has(original), false);
  assert.equal(intersection.targets.has(replacement), true);
  virtualizer.destroy();
});

test("IntersectionObserver owns scroll work and restores the same parked element from entries", () => {
  FakeIntersectionObserver.instances.length = 0;
  const page = makeQuestionPage([makeAnswer({ top: 20, bottom: 240, height: 220 })]);
  const virtualizer = new AnswerVirtualizer({
    document: page.documentObject,
    window: page.windowObject,
    IntersectionObserver: FakeIntersectionObserver,
    config: { enabled: true, minAnswers: 1, bufferViewports: 1 },
  });
  virtualizer.start();
  const intersection = FakeIntersectionObserver.instances.at(-1);
  assert.match(intersection.options.rootMargin, /^100px/);

  let scanCalls = 0;
  let updateCalls = 0;
  virtualizer.scan = () => { scanCalls += 1; };
  virtualizer.updateWindow = () => { updateCalls += 1; };
  page.windowObject.trigger("scroll");
  assert.equal(scanCalls, 0);
  assert.equal(updateCalls, 0);

  const row = page.listRoot.children[0];
  intersection.trigger([{
    target: row,
    isIntersecting: false,
    boundingClientRect: { top: 1000, bottom: 1220, height: 220 },
  }]);
  const record = virtualizer.records.get(row);
  assert.equal(record.parked, true);
  intersection.trigger([{
    target: row,
    isIntersecting: true,
    boundingClientRect: { top: 40, bottom: 260, height: 220 },
  }]);
  assert.equal(record.parked, false);
  assert.equal(row.parentNode, page.listRoot);
  virtualizer.destroy();
});

test("IntersectionObserver restores parked rows and does not park below minAnswers", () => {
  FakeIntersectionObserver.instances.length = 0;
  const rows = [
    makeAnswer({ top: 20, bottom: 240, height: 220 }),
    makeAnswer({ top: 1000, bottom: 1220, height: 220 }),
    makeAnswer({ top: 1250, bottom: 1470, height: 220 }),
    makeAnswer({ top: 1500, bottom: 1720, height: 220 }),
    makeAnswer({ top: 1750, bottom: 1970, height: 220 }),
  ];
  const page = makeQuestionPage(rows);
  const virtualizer = new AnswerVirtualizer({
    document: page.documentObject,
    window: page.windowObject,
    IntersectionObserver: FakeIntersectionObserver,
    config: { enabled: true, minAnswers: 1, bufferViewports: 1 },
  });
  virtualizer.start();

  const intersection = FakeIntersectionObserver.instances.at(-1);
  const parkedRows = rows.filter((row) => virtualizer.records.get(row).parked);
  assert.ok(parkedRows.length > 0);

  // Simulate a threshold transition after rows have already been parked.
  virtualizer.config.minAnswers = 12;
  intersection.trigger(rows.map((row) => ({
    target: row,
    isIntersecting: false,
    boundingClientRect: { top: 2000, bottom: 2220, height: 220 },
  })));

  assert.deepEqual(virtualizer.getStats(), { total: 5, parked: 0, live: 5, enabled: true });
  for (const row of rows) {
    assert.equal(row.classList.contains("zhihu-smoother-parked"), false);
  }
  virtualizer.destroy();
});

test("ResizeObserver records real comment-driven height changes", () => {
  FakeResizeObserver.instances.length = 0;
  const row = makeAnswer({ top: 20, bottom: 240, height: 220 }, JSON.stringify({ type: "answer", itemId: "resize" }));
  const page = makeQuestionPage([row]);
  const virtualizer = new AnswerVirtualizer({
    document: page.documentObject,
    window: page.windowObject,
    ResizeObserver: FakeResizeObserver,
    config: { enabled: true, minAnswers: 1 },
  });
  virtualizer.start();
  const resize = FakeResizeObserver.instances.at(-1);
  const record = virtualizer.records.get(row);
  assert.equal(record.lastMeasuredHeight, 220);

  row._rect = { top: 20, bottom: 390, height: 370 };
  resize.trigger([{ target: row, contentRect: { height: 999 } }]);
  assert.equal(record.height, 370);
  assert.equal(record.lastMeasuredHeight, 370);
  virtualizer.destroy();
});

test("keeps an unmeasured intrinsic answer live instead of using a median", () => {
  const measured = [
    makeAnswer({ top: 10, bottom: 229, height: 219 }),
    makeAnswer({ top: 235, bottom: 481, height: 246 }),
    makeAnswer({ top: 490, bottom: 802, height: 312 }),
  ];
  const intrinsic = makeAnswer(
    { top: 2000, bottom: 2672, height: 672 },
    JSON.stringify({ type: "answer", itemId: "intrinsic" }),
    { contentVisibility: "auto" },
  );
  const page = makeQuestionPage([...measured, intrinsic]);
  const virtualizer = new AnswerVirtualizer({
    document: page.documentObject,
    window: page.windowObject,
    config: { enabled: true, minAnswers: 1, bufferViewports: 1 },
  });
  virtualizer.start();
  const record = virtualizer.records.get(intrinsic);
  assert.equal(record.parked, false);
  assert.notEqual(intrinsic.style.containIntrinsicSize, "672px");
  assert.equal(intrinsic.style.containIntrinsicSize || "", "");
  virtualizer.destroy();
});

test("keeps an unmeasured offscreen row live until a real height exists", () => {
  const intrinsic = makeAnswer(
    { top: 2000, bottom: 2672, height: 672 },
    JSON.stringify({ type: "answer", itemId: "fallback" }),
    { contentVisibility: "auto" },
  );
  const page = makeQuestionPage([intrinsic]);
  const virtualizer = new AnswerVirtualizer({
    document: page.documentObject,
    window: page.windowObject,
    config: { enabled: true, minAnswers: 1, bufferViewports: 1 },
  });

  virtualizer.start();

  const record = virtualizer.records.get(intrinsic);
  assert.equal(record.parked, false);
  assert.equal(intrinsic.style.contentVisibility, "auto");
  assert.equal(intrinsic.style.containIntrinsicSize || "", "");
  virtualizer.destroy();
});

test("parks a far answer whose expanded comments have settled", () => {
  const row = makeAnswer(
    { top: 2000, bottom: 2300, height: 300 },
    JSON.stringify({ type: "answer", itemId: "comments-open" }),
  );
  const comments = new FakeElement("Comments-container", {}, { top: 2200, bottom: 2500, height: 300 });
  row.children[0].appendChild(comments);
  const page = makeQuestionPage([row]);
  const virtualizer = new AnswerVirtualizer({
    document: page.documentObject,
    window: page.windowObject,
    config: { enabled: true, minAnswers: 1, bufferViewports: 1 },
  });

  virtualizer.start();

  const record = virtualizer.records.get(row);
  assert.equal(record.parked, true);
  assert.equal(row.style.contentVisibility, "hidden");
  assert.equal(row.parentNode, page.listRoot);
  assert.equal(comments.parentNode !== null, true);
  virtualizer.destroy();
});

test("keeps an answer live briefly after its height changes, then parks", () => {
  const clock = { value: 1000, now: () => clock.value };
  const timers = createFakeTimers();
  const row = makeAnswer(
    { top: 20, bottom: 240, height: 220 },
    JSON.stringify({ type: "answer", itemId: "comments-grace" }),
  );
  const comments = new FakeElement("Comments-container", {}, { top: 100, bottom: 300, height: 200 });
  row.children[0].appendChild(comments);
  const page = makeQuestionPage([row]);
  const virtualizer = new AnswerVirtualizer({
    document: page.documentObject,
    window: page.windowObject,
    config: { enabled: true, minAnswers: 1, bufferViewports: 1 },
    now: clock.now,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });

  virtualizer.start();
  const record = virtualizer.records.get(row);
  assert.equal(record.lastMeasuredHeight, 220);

  // Comments expand: the row grows while it is still near the viewport.
  row._rect = { top: 20, bottom: 520, height: 500 };
  virtualizer.updateWindow();
  assert.equal(record.lastMeasuredHeight, 500);
  assert.equal(record.parked, false);
  assert.equal(record.lastHeightChangeAt, 1000);

  // The row leaves the buffer while the expansion is still settling.
  row._rect = { top: 2000, bottom: 2500, height: 500 };
  virtualizer.updateWindow();
  assert.equal(record.parked, false);
  assert.equal(timers.pendingCount(), 1);
  virtualizer.updateWindow();
  assert.equal(timers.pendingCount(), 1);

  // Once the grace period has elapsed, the scheduled recheck parks the row.
  clock.value += 6000;
  timers.runAll();
  assert.equal(record.parked, true);
  assert.equal(row.style.contentVisibility, "hidden");
  assert.equal(timers.pendingCount(), 0);
  virtualizer.destroy();
});

test("keeps an answer with keyboard focus inside it live", () => {
  const row = makeAnswer(
    { top: 2000, bottom: 2300, height: 300 },
    JSON.stringify({ type: "answer", itemId: "focus-pin" }),
  );
  const page = makeQuestionPage([row]);
  const virtualizer = new AnswerVirtualizer({
    document: page.documentObject,
    window: page.windowObject,
    config: { enabled: true, minAnswers: 1, bufferViewports: 1 },
  });

  virtualizer.start();
  assert.equal(virtualizer.records.get(row).parked, true);

  page.documentObject.activeElement = row.children[0];
  row._rect = { top: 30, bottom: 330, height: 300 };
  virtualizer.updateWindow();
  assert.equal(virtualizer.records.get(row).parked, false);

  row._rect = { top: 2000, bottom: 2300, height: 300 };
  virtualizer.updateWindow();
  assert.equal(virtualizer.records.get(row).parked, false);

  page.documentObject.activeElement = null;
  virtualizer.updateWindow();
  assert.equal(virtualizer.records.get(row).parked, true);
  virtualizer.destroy();
});

test("reuses the cached vertical-box insets when re-parking a record", () => {
  const row = makeAnswer(
    { top: 2000, bottom: 2220, height: 220 },
    JSON.stringify({ type: "answer", itemId: "cache-box" }),
  );
  row.style.paddingTop = "16px";
  row.style.paddingBottom = "16px";
  const page = makeQuestionPage([row]);
  const virtualizer = new AnswerVirtualizer({
    document: page.documentObject,
    window: page.windowObject,
    config: { enabled: true, minAnswers: 1, bufferViewports: 1 },
  });

  virtualizer.start();
  const record = virtualizer.records.get(row);
  assert.equal(record.parked, true);
  assert.equal(row.style.containIntrinsicBlockSize, "188px");

  // Restore the row, change its padding, and park it again: the insets must
  // stay cached from the first park instead of forcing a new style read.
  // Reading computed style here would yield 140px (220 - 40 - 40) instead.
  row._rect = { top: 30, bottom: 250, height: 220 };
  virtualizer.updateWindow();
  assert.equal(record.parked, false);

  row.style.paddingTop = "40px";
  row.style.paddingBottom = "40px";
  row._rect = { top: 2000, bottom: 2220, height: 220 };
  virtualizer.updateWindow();
  assert.equal(record.parked, true);
  assert.equal(row.style.containIntrinsicBlockSize, "188px");
  virtualizer.destroy();
});

test("grace recheck parks the deferred record without a full window sweep", () => {
  const clock = { value: 1000, now: () => clock.value };
  const timers = createFakeTimers();
  const graceRow = makeAnswer(
    { top: 20, bottom: 240, height: 220 },
    JSON.stringify({ type: "answer", itemId: "grace-row" }),
  );
  const farRow = makeAnswer(
    { top: 5000, bottom: 5220, height: 220 },
    JSON.stringify({ type: "answer", itemId: "far-row" }),
  );
  const page = makeQuestionPage([graceRow, farRow]);
  const virtualizer = new AnswerVirtualizer({
    document: page.documentObject,
    window: page.windowObject,
    now: clock.now,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    config: { enabled: true, minAnswers: 1, bufferViewports: 1 },
  });
  virtualizer.start();
  assert.equal(virtualizer.records.get(farRow).parked, true);

  // Trigger the height-change grace on the near row, then move it far away.
  graceRow._rect = { top: 20, bottom: 520, height: 500 };
  virtualizer.updateWindow();
  assert.equal(virtualizer.records.get(graceRow).lastHeightChangeAt, 1000);
  graceRow._rect = { top: 2000, bottom: 2500, height: 500 };
  virtualizer.updateWindow();
  assert.equal(virtualizer.records.get(graceRow).parked, false);
  assert.equal(timers.pendingCount(), 1);

  // The scheduled recheck must reconcile the deferred record directly
  // instead of sweeping every managed record through updateWindow().
  let updateWindowCalls = 0;
  const originalUpdateWindow = virtualizer.updateWindow.bind(virtualizer);
  virtualizer.updateWindow = () => {
    updateWindowCalls += 1;
    return originalUpdateWindow();
  };
  clock.value += 6000;
  timers.runAll();

  assert.equal(virtualizer.records.get(graceRow).parked, true);
  assert.equal(updateWindowCalls, 0);
  virtualizer.destroy();
});

test("keeps a real 7090px height on its record without polluting estimates", () => {
  const typicalRows = [
    makeAnswer({ top: 10, bottom: 229, height: 219 }),
    makeAnswer({ top: 235, bottom: 481, height: 246 }),
    makeAnswer({ top: 490, bottom: 802, height: 312 }),
  ];
  const outlier = makeAnswer(
    { top: 15, bottom: 7105, height: 7090 },
    JSON.stringify({ type: "answer", itemId: "long-answer" }),
  );
  const unknown = makeAnswer(
    { top: 3000, bottom: 3672, height: 672 },
    JSON.stringify({ type: "answer", itemId: "unknown-answer" }),
  );
  const page = makeQuestionPage([...typicalRows, outlier, unknown]);
  const virtualizer = new AnswerVirtualizer({
    document: page.documentObject,
    window: page.windowObject,
    config: { enabled: true, minAnswers: 1, bufferViewports: 1 },
  });

  virtualizer.start();

  const outlierRecord = virtualizer.records.get(outlier);
  const unknownRecord = virtualizer.records.get(unknown);
  assert.equal(outlierRecord.lastMeasuredHeight, 7090);
  assert.equal(unknownRecord.parked, false);
  assert.equal(unknown.style.containIntrinsicSize || "", "");
  assert.notEqual(unknown.style.containIntrinsicSize, "3725px");
  virtualizer.destroy();
});

test("incrementally removes a direct answer node from the records", () => {
  FakeMutationObserver.instances.length = 0;
  const removed = makeAnswer({ top: 20, bottom: 240, height: 220 }, JSON.stringify({ type: "answer", itemId: "removed" }));
  const kept = makeAnswer({ top: 250, bottom: 470, height: 220 }, JSON.stringify({ type: "answer", itemId: "kept" }));
  const page = makeQuestionPage([removed, kept]);
  const virtualizer = new AnswerVirtualizer({
    document: page.documentObject,
    window: page.windowObject,
    MutationObserver: FakeMutationObserver,
    config: { enabled: true, minAnswers: 1 },
  });
  virtualizer.start();
  const observer = FakeMutationObserver.instances.at(-1);
  page.listRoot.removeChild(removed);
  observer.trigger([{ type: "childList", target: page.listRoot, removedNodes: [removed], addedNodes: [] }]);

  assert.equal(virtualizer.getStats().total, 1);
  assert.equal(virtualizer.records.get(removed), undefined);
  assert.equal(virtualizer.records.get(kept).id, "item:kept");
  virtualizer.destroy();
});

test("restores all parked rows when direct removals drop below minAnswers", () => {
  FakeMutationObserver.instances.length = 0;
  const visible = makeAnswer({ top: 20, bottom: 240, height: 220 }, JSON.stringify({ type: "answer", itemId: "visible" }));
  const far = makeAnswer({ top: 1000, bottom: 1220, height: 220 }, JSON.stringify({ type: "answer", itemId: "far" }));
  const page = makeQuestionPage([visible, far]);
  const virtualizer = new AnswerVirtualizer({
    document: page.documentObject,
    window: page.windowObject,
    MutationObserver: FakeMutationObserver,
    config: { enabled: true, minAnswers: 2, bufferViewports: 1 },
  });
  virtualizer.start();
  const farRecord = virtualizer.records.get(far);
  assert.equal(farRecord.parked, true);
  const observer = FakeMutationObserver.instances.at(-1);
  page.listRoot.removeChild(visible);
  observer.trigger([{ type: "childList", target: page.listRoot, removedNodes: [visible], addedNodes: [] }]);

  assert.equal(virtualizer.getStats().total, 1);
  assert.equal(farRecord.parked, false);
  assert.equal(far.style.contentVisibility, "");
  virtualizer.destroy();
});

test("same-parent answer reordering does not remove its record", () => {
  FakeMutationObserver.instances.length = 0;
  const first = makeAnswer({ top: 20, bottom: 240, height: 220 }, JSON.stringify({ type: "answer", itemId: "first" }));
  const second = makeAnswer({ top: 250, bottom: 470, height: 220 }, JSON.stringify({ type: "answer", itemId: "second" }));
  const page = makeQuestionPage([first, second]);
  const virtualizer = new AnswerVirtualizer({
    document: page.documentObject,
    window: page.windowObject,
    MutationObserver: FakeMutationObserver,
    config: { enabled: true, minAnswers: 1 },
  });
  virtualizer.start();
  const observer = FakeMutationObserver.instances.at(-1);
  page.listRoot.removeChild(first);
  page.listRoot.insertBefore(first, page.sentinel);
  observer.trigger([{ type: "childList", target: page.listRoot, removedNodes: [first], addedNodes: [first] }]);

  assert.equal(virtualizer.getStats().total, 2);
  assert.equal(virtualizer.records.get(first).id, "item:first");
  virtualizer.destroy();
});

test("every record deletion restores parked rows below the activation threshold", () => {
  const first = makeAnswer({ top: 2000, bottom: 2220, height: 220 }, JSON.stringify({ type: "answer", itemId: "delete-first" }));
  const second = makeAnswer({ top: 2230, bottom: 2450, height: 220 }, JSON.stringify({ type: "answer", itemId: "delete-second" }));
  const page = makeQuestionPage([first, second]);
  const virtualizer = new AnswerVirtualizer({
    document: page.documentObject,
    window: page.windowObject,
    config: { enabled: true, minAnswers: 2, bufferViewports: 1 },
  });
  virtualizer.start();
  assert.equal(virtualizer.getStats().parked, 2);

  virtualizer._deleteRecord(virtualizer.records.get(first));

  assert.deepEqual(virtualizer.getStats(), { total: 1, parked: 0, live: 1, enabled: true });
  assert.equal(second.classList.contains("zhihu-smoother-parked"), false);
  virtualizer.destroy();
});

test("parks with content-box intrinsic size while retaining the measured outer height", () => {
  const row = makeAnswer(
    { top: 2000, bottom: 2220, height: 220 },
    JSON.stringify({ type: "answer", itemId: "padded" }),
  );
  row.style.contentVisibility = "visible";
  row.style.containIntrinsicSize = "auto 48px";
  row.style.containIntrinsicInlineSize = "13px";
  row.style.containIntrinsicBlockSize = "17px";
  row.style.paddingTop = "16px";
  row.style.paddingBottom = "16px";
  const page = makeQuestionPage([row]);
  const virtualizer = new AnswerVirtualizer({
    document: page.documentObject,
    window: page.windowObject,
    config: { enabled: true, minAnswers: 1, bufferViewports: 1 },
  });
  virtualizer.start();
  const record = virtualizer.records.get(row);

  assert.equal(record.lastMeasuredHeight, 220);
  assert.equal(record.parked, true);
  assert.equal(row.style.containIntrinsicSize, "");
  assert.equal(row.style.containIntrinsicInlineSize, "none");
  assert.equal(row.style.containIntrinsicBlockSize, "188px");
  row._rect = { top: 20, bottom: 240, height: 220 };
  virtualizer.updateWindow();
  assert.equal(record.parked, false);
  assert.equal(row.style.contentVisibility, "visible");
  assert.equal(row.style.containIntrinsicSize, "auto 48px");
  assert.equal(row.style.containIntrinsicInlineSize, "13px");
  assert.equal(row.style.containIntrinsicBlockSize, "17px");
  virtualizer.destroy();
});

test("restores a parked row and refreshes its height two frames later", () => {
  const row = makeAnswer(
    { top: 2000, bottom: 2220, height: 220 },
    JSON.stringify({ type: "answer", itemId: "restore-defer" }),
  );
  const page = makeQuestionPage([row]);
  const virtualizer = new AnswerVirtualizer({
    document: page.documentObject,
    window: page.windowObject,
    config: { enabled: true, minAnswers: 1, bufferViewports: 1 },
  });
  virtualizer.start();
  const record = virtualizer.records.get(row);
  assert.equal(record.parked, true);

  row._rect = { top: 30, bottom: 330, height: 300 };
  virtualizer.updateWindow();
  assert.equal(record.parked, false);
  // Restore no longer measures synchronously; the record keeps its parked
  // height until the deferred two-frame callback chain runs.
  assert.equal(record.lastMeasuredHeight, 220);
  page.windowObject.flushAnimationFrame();
  assert.equal(record.lastMeasuredHeight, 220);
  page.windowObject.flushAnimationFrame();
  assert.equal(record.lastMeasuredHeight, 300);
  virtualizer.destroy();
});

test("registers a new answer write-only and defers its measurement to reconcile", () => {
  FakeMutationObserver.instances.length = 0;
  const near = makeAnswer({ top: 20, bottom: 240, height: 220 }, JSON.stringify({ type: "answer", itemId: "near" }));
  const page = makeQuestionPage([near]);
  const virtualizer = new AnswerVirtualizer({
    document: page.documentObject,
    window: page.windowObject,
    MutationObserver: FakeMutationObserver,
    config: { enabled: true, minAnswers: 1, bufferViewports: 1 },
  });
  virtualizer.start();
  const observer = FakeMutationObserver.instances.at(-1);

  const added = makeAnswer({ top: 250, bottom: 470, height: 220 }, JSON.stringify({ type: "answer", itemId: "added-measure" }));
  page.listRoot.insertBefore(added, page.sentinel);
  observer.trigger([{ type: "childList", target: page.listRoot, addedNodes: [added] }]);
  page.windowObject.flushAnimationFrame();

  const record = virtualizer.records.get(added);
  assert.ok(record);
  // Registration performs no geometry read: a getRect right after the class
  // write forces a synchronous layout per appended row. Geometry arrives
  // from the next reconcile (IntersectionObserver entries in the browser,
  // updateWindow on the test/no-observer path).
  assert.equal(record.lastMeasuredHeight, 0);
  virtualizer.updateWindow();
  assert.equal(record.lastMeasuredHeight, 220);
  virtualizer.destroy();
});

test("registering an appended batch performs zero forced-layout geometry reads", () => {
  FakeMutationObserver.instances.length = 0;
  const page = makeQuestionPage([makeAnswer({ top: 20, bottom: 240, height: 220 })]);
  const virtualizer = new AnswerVirtualizer({
    document: page.documentObject,
    window: page.windowObject,
    MutationObserver: FakeMutationObserver,
    config: { enabled: true, minAnswers: 1 },
  });
  virtualizer.start();
  const observer = FakeMutationObserver.instances.at(-1);

  // Any geometry read during the registration frame is a forced layout after
  // the class/style writes. Count them: the budget for the whole batch is 0.
  let rectReads = 0;
  const added = [];
  for (let index = 0; index < 5; index += 1) {
    const row = makeAnswer(
      { top: 300 + index * 250, bottom: 520 + index * 250, height: 220 },
      JSON.stringify({ type: "answer", itemId: `storm-${index}` }),
    );
    const originalRect = row.getBoundingClientRect.bind(row);
    row.getBoundingClientRect = () => {
      rectReads += 1;
      return originalRect();
    };
    added.push(row);
    page.listRoot.insertBefore(row, page.sentinel);
  }
  observer.trigger([{ type: "childList", target: page.listRoot, addedNodes: added }]);
  page.windowObject.flushAnimationFrame();

  assert.equal(virtualizer.getStats().total, 6);
  assert.equal(rectReads, 0);
  virtualizer.destroy();
});

test("shares one vertical-box read across all parked records", () => {
  const first = makeAnswer(
    { top: 2000, bottom: 2220, height: 220 },
    JSON.stringify({ type: "answer", itemId: "shared-first" }),
  );
  const second = makeAnswer(
    { top: 3000, bottom: 3220, height: 220 },
    JSON.stringify({ type: "answer", itemId: "shared-second" }),
  );
  first.style.paddingTop = "16px";
  first.style.paddingBottom = "16px";
  const page = makeQuestionPage([first, second]);
  const virtualizer = new AnswerVirtualizer({
    document: page.documentObject,
    window: page.windowObject,
    config: { enabled: true, minAnswers: 1, bufferViewports: 1 },
  });

  virtualizer.start();

  // The first park measures the insets once; the second record reuses the
  // shared value even though its own padding differs.
  assert.equal(virtualizer.records.get(first).parked, true);
  assert.equal(virtualizer.records.get(second).parked, true);
  assert.equal(first.style.containIntrinsicBlockSize, "188px");
  assert.equal(second.style.containIntrinsicBlockSize, "188px");
  assert.equal(virtualizer._verticalBoxCache, 32);
  virtualizer.destroy();
});

test("keeps an answer with active playing media live even when offscreen", () => {
  const answer = makeAnswer(
    { top: 2000, bottom: 2500, height: 500 },
    JSON.stringify({ type: "answer", itemId: "video-answer" }),
  );
  const video = new FakeElement("", {}, { top: 0, bottom: 0, height: 0 }, "video");
  video.paused = false;
  video.ended = false;
  answer.children[0].appendChild(video);

  const page = makeQuestionPage([answer]);
  const virtualizer = new AnswerVirtualizer({
    document: page.documentObject,
    window: page.windowObject,
    config: { enabled: true, minAnswers: 1, bufferViewports: 1 },
  });

  virtualizer.start();
  assert.equal(virtualizer.records.get(answer).parked, false);
  virtualizer.destroy();
});

test("_ensureListRoot reconnects observer when answer list container changes", () => {
  FakeMutationObserver.instances.length = 0;
  const answer1 = makeAnswer(
    { top: 10, bottom: 100, height: 90 },
    JSON.stringify({ type: "answer", itemId: "spa-1" }),
  );
  const page1 = makeQuestionPage([answer1]);
  const virtualizer = new AnswerVirtualizer({
    document: page1.documentObject,
    window: page1.windowObject,
    MutationObserver: FakeMutationObserver,
    config: { enabled: true, minAnswers: 1, bufferViewports: 1 },
  });
  virtualizer.start();

  const originalObserver = virtualizer.observer;
  assert.ok(originalObserver);

  const answer2 = makeAnswer(
    { top: 10, bottom: 100, height: 90 },
    JSON.stringify({ type: "answer", itemId: "spa-2" }),
  );
  const page2 = makeQuestionPage([answer2]);
  virtualizer.root = page2.documentObject;
  virtualizer.scan();

  assert.notEqual(virtualizer.observer, originalObserver);
  assert.equal(virtualizer.listRoot, page2.listRoot);
  virtualizer.destroy();
});

test("deep-link boot without a list attaches once the answer list appears", () => {
  FakeMutationObserver.instances.length = 0;
  // A deep-linked answer page has no .QuestionAnswers-answers list at boot:
  // start() finds no list root and no observer.
  const documentObject = new FakeDocument();
  const windowObject = fakeWindow();
  documentObject.defaultView = windowObject;
  const virtualizer = new AnswerVirtualizer({
    document: documentObject,
    window: windowObject,
    MutationObserver: FakeMutationObserver,
    config: { enabled: true, minAnswers: 1, bufferViewports: 1 },
  });
  virtualizer.start();
  assert.equal(virtualizer.listRoot, null);
  assert.equal(virtualizer.observer, null);

  // The user clicks "show all answers": the full list view mounts.
  const page = makeQuestionPage([
    makeAnswer({ top: 20, bottom: 240, height: 220 }, JSON.stringify({ type: "answer", itemId: "deep-1" })),
    makeAnswer({ top: 250, bottom: 470, height: 220 }, JSON.stringify({ type: "answer", itemId: "deep-2" })),
  ]);
  documentObject.documentElement.appendChild(page.answers);
  virtualizer.root = documentObject;
  virtualizer.scan();

  assert.equal(virtualizer.listRoot, page.listRoot);
  assert.ok(virtualizer.observer);
  assert.equal(virtualizer.observer.target, page.listRoot);
  assert.equal(virtualizer.getStats().total, 2);
  virtualizer.destroy();
});

test("watchdog heartbeat re-attaches tracking after the tracked list is unmounted", () => {
  FakeMutationObserver.instances.length = 0;
  const timers = createFakeTimers();
  const answer = makeAnswer({ top: 20, bottom: 240, height: 220 }, JSON.stringify({ type: "answer", itemId: "watch-1" }));
  const page = makeQuestionPage([answer]);
  const virtualizer = new AnswerVirtualizer({
    document: page.documentObject,
    window: page.windowObject,
    MutationObserver: FakeMutationObserver,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    config: { enabled: true, minAnswers: 1, bufferViewports: 1 },
  });
  virtualizer.start();
  assert.equal(virtualizer.getStats().total, 1);
  assert.ok(virtualizer.observer);

  // The SPA swaps to the single-answer deep-link view: the whole list view
  // (including the tracked list root) leaves the DOM.
  page.documentObject.documentElement.removeChild(page.answers);
  virtualizer.scan();
  assert.equal(virtualizer.listRoot, null);
  assert.equal(virtualizer.observer, null);

  // The user clicks "show all answers": a fresh list view mounts elsewhere.
  const nextPage = makeQuestionPage([
    makeAnswer({ top: 20, bottom: 240, height: 220 }, JSON.stringify({ type: "answer", itemId: "watch-2" })),
    makeAnswer({ top: 250, bottom: 470, height: 220 }, JSON.stringify({ type: "answer", itemId: "watch-3" })),
  ]);
  page.documentObject.documentElement.appendChild(nextPage.answers);

  // No route event fires (in-place view swap); the heartbeat alone must
  // re-attach tracking to the new list.
  timers.runAll();

  assert.equal(virtualizer.listRoot, nextPage.listRoot);
  assert.ok(virtualizer.observer);
  assert.equal(virtualizer.observer.target, nextPage.listRoot);
  assert.equal(virtualizer.getStats().total, 2);
  virtualizer.destroy();
});

test("watchdog heartbeat idles at the slow interval once tracking is healthy", () => {
  FakeMutationObserver.instances.length = 0;
  const timers = createFakeTimers();
  const answer = makeAnswer({ top: 20, bottom: 240, height: 220 }, JSON.stringify({ type: "answer", itemId: "idle-1" }));
  const page = makeQuestionPage([answer]);
  const virtualizer = new AnswerVirtualizer({
    document: page.documentObject,
    window: page.windowObject,
    MutationObserver: FakeMutationObserver,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    config: { enabled: true, minAnswers: 1, bufferViewports: 1 },
  });
  virtualizer.start();

  // Healthy state: no scan is pending (the heartbeat only schedules itself
  // when tracking is degraded) and one idle tick is pending.
  virtualizer._scheduleWatchdog();
  assert.equal(timers.pendingCount(), 1);

  // Running the healthy tick must not trigger a rescan: the root, observer,
  // and record set are all intact.
  let scanCalls = 0;
  virtualizer.scan = () => {
    scanCalls += 1;
    throw new Error("healthy heartbeat must not rescan");
  };
  timers.runAll();
  assert.equal(scanCalls, 0);

  // And the heartbeat re-armed itself for the idle interval.
  assert.equal(timers.pendingCount(), 1);
  virtualizer.destroy();
  assert.equal(timers.pendingCount(), 0);
});

test("pages below minAnswers settle into the idle heartbeat instead of polling forever", () => {
  FakeMutationObserver.instances.length = 0;
  const timers = createFakeTimers();
  // Production default minAnswers (5) on a 3-answer page: the list root is
  // present and observed, so tracking is healthy even though the record
  // count never crosses the activation threshold. Growth is the Mutation
  // Observer's job; the count itself must not keep the heartbeat fast.
  const rows = [0, 1, 2].map((index) => makeAnswer(
    { top: 20 + index * 250, bottom: 240 + index * 250, height: 220 },
    JSON.stringify({ type: "answer", itemId: `small-${index}` }),
  ));
  const page = makeQuestionPage(rows);
  const virtualizer = new AnswerVirtualizer({
    document: page.documentObject,
    window: page.windowObject,
    MutationObserver: FakeMutationObserver,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    config: { enabled: true, minAnswers: 5, bufferViewports: 1 },
  });
  virtualizer.start();
  assert.equal(virtualizer.getStats().total, 3);

  let scanCalls = 0;
  virtualizer.scan = () => {
    scanCalls += 1;
    throw new Error("a below-threshold but attached page must not be rescanned");
  };
  for (let tick = 0; tick < 5; tick += 1) {
    timers.runAll();
  }
  assert.equal(scanCalls, 0);
  assert.equal(timers.nextDelay(), 1000);
  virtualizer.destroy();
});

test("watchdog backs off while no list exists and recovers when one mounts", () => {
  FakeMutationObserver.instances.length = 0;
  const timers = createFakeTimers();
  const documentObject = new FakeDocument();
  const windowObject = fakeWindow();
  documentObject.defaultView = windowObject;
  const virtualizer = new AnswerVirtualizer({
    document: documentObject,
    window: windowObject,
    MutationObserver: FakeMutationObserver,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    config: { enabled: true, minAnswers: 5, bufferViewports: 1 },
  });
  virtualizer.start();

  // No list at all (deep-link view): each failed tick doubles the delay,
  // capped at 2400ms. The heartbeat never stops, so recovery without route
  // events stays bounded by one interval.
  assert.equal(timers.nextDelay(), 300);
  timers.runAll();
  assert.equal(timers.nextDelay(), 600);
  timers.runAll();
  assert.equal(timers.nextDelay(), 1200);
  timers.runAll();
  assert.equal(timers.nextDelay(), 2400);
  timers.runAll();
  assert.equal(timers.nextDelay(), 2400);

  // The list view finally mounts: the next backed-off tick attaches it and
  // the heartbeat drops back to the idle cadence.
  const page = makeQuestionPage([
    makeAnswer({ top: 20, bottom: 240, height: 220 }, JSON.stringify({ type: "answer", itemId: "backoff-1" })),
    makeAnswer({ top: 250, bottom: 470, height: 220 }, JSON.stringify({ type: "answer", itemId: "backoff-2" })),
  ]);
  documentObject.documentElement.appendChild(page.answers);
  timers.runAll();

  assert.equal(virtualizer.listRoot, page.listRoot);
  assert.ok(virtualizer.observer);
  assert.equal(virtualizer.observer.target, page.listRoot);
  assert.equal(timers.nextDelay(), 1000);
  virtualizer.destroy();
});

test("refresh resets a backed-off watchdog to its fastest cadence", () => {
  FakeMutationObserver.instances.length = 0;
  const timers = createFakeTimers();
  const documentObject = new FakeDocument();
  const windowObject = fakeWindow();
  documentObject.defaultView = windowObject;
  const virtualizer = new AnswerVirtualizer({
    document: documentObject,
    window: windowObject,
    MutationObserver: FakeMutationObserver,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    config: { enabled: true, minAnswers: 5, bufferViewports: 1 },
  });
  virtualizer.start();

  // Burn the watchdog down to the capped backoff interval.
  for (let tick = 0; tick < 4; tick += 1) {
    timers.runAll();
  }
  assert.equal(timers.nextDelay(), 2400);

  // A route change (content.js calls rescan/refresh) must drop the stale
  // backoff immediately: the next view can mount at any moment.
  virtualizer.refresh();
  assert.equal(timers.nextDelay(), 300);
  virtualizer.destroy();
});

test("optimizes images within answer element for asynchronous decoding", () => {
  const answer = makeAnswer(
    { top: 0, bottom: 120, height: 120 },
    JSON.stringify({ type: "answer", itemId: "img-opt-1" }),
  );
  const img1 = new FakeElement("RichText-image", { src: "https://pic1.zhimg.com/a.jpg" }, { top: 10, bottom: 60, height: 50 }, "img");
  const img2 = new FakeElement("RichText-image", { src: "https://pic1.zhimg.com/b.jpg" }, { top: 70, bottom: 110, height: 40 }, "img");
  answer.appendChild(img1);
  answer.appendChild(img2);

  const page = makeQuestionPage([answer]);
  const virtualizer = new AnswerVirtualizer({
    root: page.documentObject,
    enabled: true,
  });
  virtualizer.start();

  assert.equal(img1.decoding, "async");
  assert.equal(img2.decoding, "async");
  virtualizer.destroy();
});

test("_checkInViewportParked unparks a record when it enters the viewport on scroll", () => {
  FakeIntersectionObserver.instances.length = 0;
  const answer = makeAnswer({ top: 20, bottom: 240, height: 220 });
  const page = makeQuestionPage([answer]);
  const virtualizer = new AnswerVirtualizer({
    document: page.documentObject,
    window: page.windowObject,
    IntersectionObserver: FakeIntersectionObserver,
    config: { enabled: true, minAnswers: 1, bufferViewports: 1 },
  });
  virtualizer.start();

  const record = virtualizer.records.get(page.listRoot.children[0]);
  assert.ok(record);

  // 模拟被暂时冻结在远离视口的位置
  virtualizer._parkRecord(record, { top: 2000, bottom: 2220, height: 220 });
  assert.equal(record.parked, true);

  // 模拟用户瞬间滚动使得该节点进入视口 [100, 320]
  record.element.getBoundingClientRect = () => ({
    top: 100,
    bottom: 320,
    height: 220,
    width: 600,
    left: 0,
    right: 600,
  });

  // 执行保底解冻
  virtualizer._checkInViewportParked();
  assert.equal(record.parked, false);
  assert.equal(record.element.style.contentVisibility, "");

  virtualizer.destroy();
});

test("scroll guard sweep is rate limited while the IntersectionObserver is active", () => {
  FakeIntersectionObserver.instances.length = 0;
  const clock = { value: 1000, now: () => clock.value };
  const timers = createFakeTimers();
  const rows = [makeAnswer({ top: 20, bottom: 240, height: 220 }, JSON.stringify({ type: "answer", itemId: "guard-0" }))];
  for (let index = 1; index < 6; index += 1) {
    rows.push(makeAnswer(
      { top: 1000 + index * 100, bottom: 1220 + index * 100, height: 220 },
      JSON.stringify({ type: "answer", itemId: `guard-${index}` }),
    ));
  }
  const page = makeQuestionPage(rows);
  const virtualizer = new AnswerVirtualizer({
    document: page.documentObject,
    window: page.windowObject,
    IntersectionObserver: FakeIntersectionObserver,
    now: clock.now,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    config: { enabled: true, minAnswers: 1, bufferViewports: 1 },
  });
  virtualizer.start();
  assert.equal(virtualizer.getStats().parked, 5);

  let sweeps = 0;
  const originalSweep = virtualizer._checkInViewportParked.bind(virtualizer);
  virtualizer._checkInViewportParked = () => {
    sweeps += 1;
    return originalSweep();
  };

  // Ten scroll events within the same window: one immediate sweep plus at
  // most one trailing scheduled sweep, never one per event.
  for (let index = 0; index < 10; index += 1) {
    clock.value += 10;
    page.windowObject.trigger("scroll");
    page.windowObject.flushAnimationFrame();
  }
  assert.equal(sweeps, 1);
  assert.equal(timers.pendingCount(), 1);

  clock.value += 200;
  timers.runAll();
  page.windowObject.flushAnimationFrame();
  assert.equal(sweeps, 2);
  assert.equal(timers.pendingCount(), 0);

  // After the interval has fully elapsed, a fresh scroll sweeps immediately.
  clock.value += 200;
  page.windowObject.trigger("scroll");
  page.windowObject.flushAnimationFrame();
  assert.equal(sweeps, 3);
  virtualizer.destroy();
});

test("_restoreParkedStyles strictly cleanses stale contentVisibility hidden value", () => {
  const answer = makeAnswer({ top: 0, bottom: 200, height: 200 });
  const page = makeQuestionPage([answer]);
  const virtualizer = new AnswerVirtualizer({
    document: page.documentObject,
    window: page.windowObject,
    config: { enabled: true },
  });

  const record = {
    element: answer,
    parked: true,
    parkedInlineStyles: {
      contentVisibility: "hidden", // 模拟历史残留的 hidden
      containIntrinsicSize: "auto 200px",
      containIntrinsicInlineSize: "",
      containIntrinsicBlockSize: "200px",
    },
  };

  answer.style.contentVisibility = "hidden";
  virtualizer._restoreParkedStyles(record, answer);

  // 断言绝不能恢复为 "hidden"，必须被彻底清洗为空字符串
  assert.equal(answer.style.contentVisibility, "");
  assert.equal(answer.style.containIntrinsicSize, "auto 200px");
});
