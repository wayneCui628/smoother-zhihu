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
  constructor(className = "", attributes = {}, rect = { top: 0, bottom: 0, height: 0 }) {
    this.classList = new FakeClassList(className);
    this.attributes = { ...attributes };
    this.children = [];
    this.parentNode = null;
    this.style = {};
    this._rect = { ...rect };
  }

  get className() {
    return this.classList.toString();
  }

  set className(value) {
    this.classList = new FakeClassList(value);
  }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  replaceChild(next, previous) {
    const index = this.children.indexOf(previous);
    if (index < 0) throw new Error("child not found");
    next.parentNode = this;
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
    return selector.startsWith(".") && this.classList.contains(selector.slice(1));
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
}

class FakeDocument extends FakeElement {
  constructor() {
    super();
    this.nodeType = 9;
    this.documentElement = new FakeElement();
    this.scrollingElement = this.documentElement;
    this.appendChild(this.documentElement);
  }

  createElement() {
    return new FakeElement();
  }
}

function makeAnswer(rect, dataZop = JSON.stringify({ type: "answer" })) {
  const outer = new FakeElement("List-item", {}, rect);
  const answer = new FakeElement("AnswerItem", { "data-zop": dataZop });
  outer.appendChild(answer);
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
  return {
    innerHeight: 100,
    scrollY: 0,
    scrollX: 0,
    addEventListener() {},
    removeEventListener() {},
    scrollTo(_x, y) {
      this.scrollY = y;
    },
  };
}

test("normalizeConfig applies defaults, types, and safe bounds", () => {
  assert.deepEqual(normalizeConfig(), {
    enabled: true,
    bufferViewports: 4,
    minAnswers: 12,
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
  const virtualizer = new AnswerVirtualizer({
    document: documentObject,
    window: fakeWindow(),
    config: { enabled: true, bufferViewports: 1, minAnswers: 12 },
  });

  virtualizer.start();
  assert.equal(virtualizer.getStats().total, 12);
  assert.ok(virtualizer.getStats().parked > 0);
  const farAnswer = rows[1];
  const record = virtualizer.records.get(farAnswer);
  assert.equal(record.parked, true);
  assert.equal(farAnswer.parentNode, null);
  assert.equal(record.placeholder.parentNode != null, true);

  record.placeholder._rect = { top: 30, bottom: 110, height: 80 };
  virtualizer.updateWindow();
  assert.equal(record.parked, false);
  assert.equal(farAnswer.parentNode, documentObject.querySelectorAll(".Question-mainColumn")[0]);
  assert.equal(virtualizer.getStats().parked < 11, true);

  virtualizer.destroy();
  assert.equal(virtualizer.getStats().parked, 0);
  assert.equal(virtualizer.getStats().live, 0);
});
