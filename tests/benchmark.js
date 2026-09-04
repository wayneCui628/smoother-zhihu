const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const http = require('http');

function findChromePath() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    // Chromium 内核即可驱动 CDP，Edge 与 Chrome 协议完全一致，作为兜底候选
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  return candidates.find((c) => fs.existsSync(c)) || 'google-chrome';
}

const chromePath = findChromePath();
const virtualizerSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'content', 'virtualizer.js'), 'utf8');
const contentCss = fs.readFileSync(path.join(__dirname, '..', 'src', 'content', 'content.css'), 'utf8');

// 构建单个回答卡片 HTML（与初始页面完全同构的真实卡片：头像、富文本、多段落、代码位、图片与操作条）。
// withListitemRole: 初始页面的行带 role="listitem"（照抄旧基准页）；
// 风暴场景的追加行不带该属性——virtualizer 的 isListSentinel 会把"直接挂在列表根下的 div[role=listitem]"
// 一律视为知乎加载哨兵而跳过注册，真实知乎的回答行也不携带该属性，只有哨兵携带。
function buildAnswerCardHtml(i, withListitemRole = true) {
  return `
      <div class="List-item"${withListitemRole ? ' role="listitem"' : ''} data-zop='{"type":"answer","authorName":"答主_${i}","itemId":${200000 + i}}'>
        <div class="ContentItem AnswerItem" data-zop='{"type":"answer","itemId":${200000 + i}}'>
          <div class="AuthorInfo">
            <div class="AuthorInfo-head">
              <span class="UserLink-link">答主_${i}</span>
              <span class="AuthorInfo-badge">知乎优秀答主</span>
            </div>
            <div class="AuthorInfo-detail">
              <span class="AuthorInfo-badgeText">前端工程架构 / Chromium 渲染管线专家</span>
            </div>
          </div>
          <div class="RichContent">
            <div class="RichContent-inner">
              <p>【知乎长回答实测样本 #${i + 1}】探讨高负载 Web 应用下 DOM 节点暴增与合成层（Compositing Layer）开销。</p>
              <p>知乎原生长页面在连续加载 100 个回答后，整棵 DOM 树的深度和广度呈线性剧增。每个回答都有独立的 React 事件代理、富文本着色和图文排版。</p>
              <div class="origin_image_respond">
                <img class="origin_image zh-lightbox-thumb" src="data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='700' height='260'><rect width='700' height='260' fill='%23e0e6ed'/><text x='50%' y='50%' font-size='18' fill='%2364778a' text-anchor='middle'>模拟知乎高清插图 #${i + 1} (700x260)</text></svg>" alt="图_${i}">
              </div>
              <p>当用户在长页面快速滑动时，如果不对视口外的数千个 DOM 节点施加渲染隔离（CSS Containment），每一次滚动或局部尺寸变动都会导致整个文档发生深层回流与重绘。</p>
              <p>知乎顺滑器通过非侵入式虚拟化架构，在保证 React 根节点生命周期完整的前提下，利用 content-visibility: hidden 冻结离屏渲染，使浏览器仅需维护视口周围极少量的活跃合成层。</p>
            </div>
            <div class="ContentItem-actions">
              <button type="button" class="Button VoteButton">▲ 赞同 3.4k</button>
              <button type="button" class="Button VoteButton">▼</button>
              <button type="button" class="Button ContentItem-action">256 条评论</button>
              <button type="button" class="Button ContentItem-action">分享</button>
              <button type="button" class="Button ContentItem-action">收藏</button>
            </div>
          </div>
        </div>
      </div>
    `;
}

// 构建高保真知乎问答长流页面（100 个真实问答卡片，每个卡片包含头像、富文本、多段落、代码块、图片与操作条，约 4000 个 DOM 节点）
function buildBenchHtml(answerCount = 100) {
  let answersHtml = '';
  for (let i = 0; i < answerCount; i++) {
    answersHtml += buildAnswerCardHtml(i);
  }

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>知乎性能真实压测</title>
<style>
  body { margin: 0; font-family: -apple-system, sans-serif; background: #f6f6f6; color: #121212; }
  .Question-main { width: 1000px; margin: 0 auto; display: flex; gap: 10px; }
  .Question-mainColumn { width: 694px; background: #fff; }
  .Question-sideColumn { width: 296px; background: #fff; }
  .List-item { border-bottom: 1px solid #f0f2f7; padding: 20px; }
  .AuthorInfo { display: flex; flex-direction: column; margin-bottom: 10px; }
  .UserLink-link { font-weight: 600; font-size: 15px; color: #121212; }
  .AuthorInfo-badgeText { font-size: 12px; color: #8590a6; margin-top: 2px; }
  .RichContent p { line-height: 1.6; margin: 10px 0; font-size: 15px; }
  .origin_image_respond img { max-width: 100%; border-radius: 4px; display: block; margin: 12px 0; }
  .ContentItem-actions { display: flex; gap: 12px; margin-top: 14px; }
  .Button { padding: 6px 12px; border: 1px solid #eee; background: #f6f6f6; border-radius: 4px; font-size: 13px; color: #8590a6; }
</style>
</head>
<body>
  <div class="Question-main">
    <div class="Question-mainColumn">
      <div class="QuestionAnswers-answers">
        ${answersHtml}
        <div class="List-item" role="listitem"></div> <!-- 知乎原生无限加载哨兵 -->
      </div>
    </div>
    <div class="Question-sideColumn">
      <div style="padding: 20px;">知乎侧边栏推荐位</div>
    </div>
  </div>
</body>
</html>`;
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// CDP 调试端口的候选端点：chrome 可能只绑上其中一侧（IPv4 被垂死实例短暂占用时，
// 新实例可能仅成功绑定 IPv6 回环），探测必须双栈都试
const DEBUG_ENDPOINTS = ['http://127.0.0.1:9222/json/list', 'http://[::1]:9222/json/list'];

async function findDebugPage() {
  for (const endpoint of DEBUG_ENDPOINTS) {
    try {
      const list = await fetchJson(endpoint);
      const page = list && list.find(t => t.type === 'page');
      if (page) {
        return page;
      }
    } catch (e) {}
  }
  return null;
}

// 调试端口被残留的 chrome（上一个场景实例尚未完全退出，或历史僵尸进程）占用时，
// 通过 CDP 礼貌请求其退出。返回 false 表示双栈都无监听，可以放心 spawn 新实例。
async function closeStaleBrowser() {
  const page = await findDebugPage();
  if (!page) {
    return false;
  }
  await new Promise((resolve) => {
    try {
      const ws = new global.WebSocket(page.webSocketDebuggerUrl);
      ws.onopen = () => {
        try { ws.send(JSON.stringify({ id: 1, method: 'Browser.close' })); } catch (e) {}
        setTimeout(resolve, 400);
      };
      ws.onerror = () => resolve();
      setTimeout(resolve, 1500); // 兜底，避免挂死
    } catch (e) { resolve(); }
  });
  return true;
}

async function runTestScenario(enableExtension) {
  const benchHtmlFile = path.join(__dirname, `bench_${enableExtension ? 'opt' : 'raw'}.html`);
  fs.writeFileSync(benchHtmlFile, buildBenchHtml(100));

  const chromeProc = spawn(chromePath, [
    '--remote-debugging-port=9222',
    `--user-data-dir=${path.join(os.tmpdir(), `chrome-bench-${enableExtension ? 'opt' : 'raw'}`)}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--headless=new',
    'about:blank'
  ], { stdio: 'ignore' });

  for (let i = 0; i < 30; i++) {
    try {
      const list = await fetchJson('http://127.0.0.1:9222/json/list');
      const page = list && list.find(t => t.type === 'page');
      if (page) {
        let id = 1;
        const callbacks = new Map();
        const ws = new global.WebSocket(page.webSocketDebuggerUrl);
        ws.onmessage = (event) => {
          const msg = JSON.parse(event.data);
          if (msg.id && callbacks.has(msg.id)) {
            callbacks.get(msg.id)(msg);
            callbacks.delete(msg.id);
          }
        };
        const send = (method, params = {}) => new Promise(r => {
          const mId = id++;
          callbacks.set(mId, r);
          ws.send(JSON.stringify({ id: mId, method, params }));
        });
        await new Promise(r => ws.onopen = r);
        await send('Page.enable');
        await send('Performance.enable');

        await send('Emulation.setDeviceMetricsOverride', {
          width: 1280,
          height: 800,
          deviceScaleFactor: 1,
          mobile: false
        });

        await send('Page.navigate', { url: 'file:///' + benchHtmlFile.replace(/\\/g, '/') });
        await new Promise(r => setTimeout(r, 600));

        if (enableExtension) {
          // 注入扩展 CSS 与 Virtualizer 控制器
          const injectRes = await send('Runtime.evaluate', {
            expression: `
              (() => {
                const style = document.createElement('style');
                style.textContent = ${JSON.stringify(contentCss)};
                document.head.appendChild(style);
                ${virtualizerSrc}
                window.__virtualizer = window.ZhihuAnswerVirtualizer.createVirtualizer({ enabled: true, bufferViewports: 2 });
                return { inited: Boolean(window.__virtualizer), stats: window.__virtualizer.getStats() };
              })()
            `,
            returnByValue: true
          });
          console.log('Virtualizer 注入结果:', JSON.stringify(injectRes));
          await new Promise(r => setTimeout(r, 500));
        }

        // 测量批量新回答插入排版耗时 (模拟知乎追加 10 个回答时的阻塞时长)
        const mountEvaluation = await send('Runtime.evaluate', {
          returnByValue: true,
          expression: `
            (() => {
              const container = document.querySelector('.QuestionAnswers-answers');
              const t0 = performance.now();
              for (let j = 0; j < 10; j++) {
                const item = document.createElement('div');
                item.className = 'List-item';
                item.setAttribute('role', 'listitem');
                const zop = JSON.stringify({ type: 'answer', itemId: 300000 + j });
                item.setAttribute('data-zop', zop);
                const inner = document.createElement('div');
                inner.className = 'ContentItem AnswerItem';
                inner.setAttribute('data-zop', zop);
                inner.innerHTML = '<p>追加回答 ' + j + '</p>';
                item.appendChild(inner);
                container.appendChild(item);
              }
              // 强制读取 offsetHeight 触发同步排版
              const _h = document.body.offsetHeight;
              const duration = performance.now() - t0;
              return { mountDuration: Math.round(duration * 100) / 100 };
            })()
          `
        });
        console.log('mountEvaluation raw:', JSON.stringify(mountEvaluation));

        // 真实平滑滚动测试 50 步，记录 rAF 帧率
        const scrollEvaluation = await send('Runtime.evaluate', {
          awaitPromise: true,
          returnByValue: true,
          expression: `
            new Promise((resolve) => {
              let frames = 0;
              let startTime = performance.now();
              let isScrolling = true;

              function tick() {
                if (!isScrolling) return;
                frames++;
                requestAnimationFrame(tick);
              }
              requestAnimationFrame(tick);

              const maxScroll = document.body.scrollHeight - window.innerHeight;
              const steps = 40;
              const stepPx = maxScroll / steps;
              let currentStep = 0;

              const interval = setInterval(() => {
                currentStep++;
                window.scrollBy(0, stepPx);
                if (currentStep >= steps) {
                  clearInterval(interval);
                  isScrolling = false;
                  setTimeout(() => {
                    const elapsed = performance.now() - startTime;
                    const fps = Math.min(60, Math.round((frames / (elapsed / 1000))));

                    // 统计当前活跃绘制的回答节点 (未被冻结的节点)
                    const items = Array.from(document.querySelectorAll('.List-item[data-zop]'));
                    const parkedItems = items.filter(el => el.classList.contains('zhihu-smoother-parked'));
                    const activeItemsCount = items.length - parkedItems.length;

                    // 统计 DOM 节点总数
                    const totalDomNodes = document.getElementsByTagName('*').length;

                    const vStats = window.__virtualizer ? window.__virtualizer.getStats() : null;

                    resolve({
                      fps,
                      totalItems: items.length,
                      activeItems: activeItemsCount,
                      parkedItems: parkedItems.length,
                      totalDomNodes,
                      vStats
                    });
                  }, 400);
                }
              }, 25);
            })
          `
        });

        // 获取 CDP Performance 真实内核排版耗时
        const cdpMetrics = await send('Performance.getMetrics');
        const metricsMap = {};
        cdpMetrics.result.metrics.forEach(m => metricsMap[m.name] = m.value);

        ws.close();
        chromeProc.kill();
        fs.unlinkSync(benchHtmlFile);

        const mData = (mountEvaluation?.result?.result?.value) || (mountEvaluation?.result?.value) || {};
        const sData = (scrollEvaluation?.result?.result?.value) || (scrollEvaluation?.result?.value) || {};

        return {
          mountDuration: mData.mountDuration,
          fps: sData.fps,
          totalItems: sData.totalItems,
          activeItems: sData.activeItems,
          totalDomNodes: sData.totalDomNodes,
          vStats: sData.vStats,
          layoutDuration: Math.round(metricsMap.LayoutDuration * 1000),
          recalcStyleDuration: Math.round(metricsMap.RecalcStyleDuration * 1000),
          layoutCount: metricsMap.LayoutCount,
          jsHeapUsed: Math.round((metricsMap.JSHeapUsedSize || 0) / 1024 / 1024)
        };
      }
    } catch(e) {}
    await new Promise(r => setTimeout(r, 300));
  }
}

// ==================== 连续加载风暴场景（无限滚动哨兵反馈回路建模） ====================
// 建模真实无限滚动：底部空哨兵进入视口 → 知乎追加下一批回答 → 新回答被 CSS 折叠成 420px →
// 文档变短 → 哨兵仍在触发范围 → 继续加载。连续 10 轮、每轮 5 个真实回答卡片，观察注册耗时、
// 文档高度单调性与内核 Layout 指标，用于验证 MutationObserver 批量注册重构是否掐断 loading 风暴。
const STORM_ROUNDS = 10;                 // 连续加载 10 轮
const STORM_BATCH_SIZE = 5;              // 每轮追加 5 个完整回答卡片
const STORM_VANILLA_INTERVAL_MS = 500;   // vanilla 场景固定加载间隔（模拟知乎自身的加载节奏）
const STORM_REGISTER_TIMEOUT_MS = 10000; // smoother 场景单轮"整批注册完成"等待的兜底超时

// 生成风暴场景单轮的页面内脚本：滚到底触发哨兵 → 在哨兵前插入一批真实卡片 → 等待本轮完成 → 回传指标。
// smoother: 逐帧轮询直到页面内所有回答行都带上 .zhihu-smoother-answer（注册完成）；
// vanilla: 固定 500ms 等待模拟知乎自身的加载节奏，两边轮数一致。
function buildStormRoundExpression(enableExtension, batchHtml, batchItemIds) {
  return `
    new Promise((resolve) => {
      const container = document.querySelector('.QuestionAnswers-answers');
      if (!container) { resolve({ error: 'container not found' }); return; }
      const batchIds = ${JSON.stringify(batchItemIds)};
      const batchHtml = ${JSON.stringify(batchHtml)};
      const isBatchRow = (row) => {
        try { return batchIds.indexOf(JSON.parse(row.getAttribute('data-zop')).itemId) !== -1; } catch (e) { return false; }
      };
      const allRowsRegistered = () => {
        const rows = document.querySelectorAll('.List-item[data-zop]');
        if (rows.length === 0) return false;
        for (let i = 0; i < rows.length; i++) {
          if (!rows[i].classList.contains('zhihu-smoother-answer')) return false;
        }
        return true;
      };
      // 1. 滚到底部：底部空哨兵进入视口（建模"哨兵可见 → 触发加载"的反馈回路）
      window.scrollTo(0, document.body.scrollHeight);
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const rowsBefore = document.querySelectorAll('.List-item[data-zop]');
        const sentinelBefore = container.querySelector('.List-item:not([data-zop])');
        let rowsSumBefore = 0;
        for (let i = 0; i < rowsBefore.length; i++) rowsSumBefore += rowsBefore[i].offsetHeight;
        const heightBefore = document.body.offsetHeight;
        const sentinelHeightBefore = sentinelBefore ? sentinelBefore.offsetHeight : 0;
        const t0 = performance.now();
        // 2. 在空哨兵之前插入下一批回答（真实知乎行为：加载哨兵始终保持在流末尾）
        const sentinel = container.querySelector('.List-item:not([data-zop])');
        if (sentinel) {
          sentinel.insertAdjacentHTML('beforebegin', batchHtml);
        } else {
          container.insertAdjacentHTML('beforeend', batchHtml);
        }
        const appendDuration = performance.now() - t0;
        const finish = () => {
          const bodyHeight = document.body.offsetHeight;
          const sentinel = container.querySelector('.List-item:not([data-zop])');
          const rows = document.querySelectorAll('.List-item[data-zop]');
          let registeredRows = 0;
          let batchHeightSum = 0;
          let rowsSum = 0;
          for (let i = 0; i < rows.length; i++) {
            if (rows[i].classList.contains('zhihu-smoother-answer')) registeredRows++;
            if (isBatchRow(rows[i])) batchHeightSum += rows[i].offsetHeight;
            rowsSum += rows[i].offsetHeight;
          }
          resolve({
            heightBefore: heightBefore,
            rowsSumBefore: rowsSumBefore,
            sentinelHeightBefore: sentinelHeightBefore,
            roundMs: Math.round((performance.now() - t0) * 100) / 100,
            appendDuration: Math.round(appendDuration * 100) / 100,
            bodyHeight: bodyHeight,
            sentinelHeight: sentinel ? sentinel.offsetHeight : 0,
            rowsSum: rowsSum,
            totalRows: rows.length,
            registeredRows: registeredRows,
            batchHeightSum: batchHeightSum
          });
        };
        ${enableExtension ? `
        // smoother: 逐帧轮询，直到全页所有回答行完成注册（含超时兜底，超时即视为折叠残留/注册卡死）
        const poll = () => {
          if (allRowsRegistered() || performance.now() - t0 > ${STORM_REGISTER_TIMEOUT_MS}) {
            finish();
            return;
          }
          requestAnimationFrame(poll);
        };
        requestAnimationFrame(poll);
        ` : `
        // vanilla: 固定 ${STORM_VANILLA_INTERVAL_MS}ms 间隔，模拟知乎自身"哨兵触发 → 追加完成"的加载节奏
        setTimeout(finish, ${STORM_VANILLA_INTERVAL_MS});
        `}
      }));
    })
  `;
}

// 连续加载风暴对比场景。与 runTestScenario 相互独立、复用同一套 CDP 基础设施，
// enableExtension=false 为知乎原生（vanilla），true 为注入扩展 CSS + Virtualizer。
async function runStormScenario(enableExtension) {
  const benchHtmlFile = path.join(__dirname, `bench_storm_${enableExtension ? 'opt' : 'raw'}.html`);
  fs.writeFileSync(benchHtmlFile, buildBenchHtml(100));

  let chromeProc = null;
  let spawnedAt = 0;

  for (let i = 0; i < 30; i++) {
    try {
      // 按需拉起 chrome，三种情况都需要重启：
      // 1. 上一次尝试的进程已退出——可能是 profile 被残留实例锁定，Windows 进程单例
      //    机制把新进程移交给旧实例后立即退出（因此每次 spawn 都用全新的 user-data-dir）；
      // 2. 进程仍存活但调试端口持续连不上——启动瞬间端口被占导致 devtools 未能绑定，
      //    该实例已无利用价值，杀掉重来；
      // 3. 首次进入循环。
      // 重启前先用 CDP 礼貌关闭双栈端口上可能存在的残留实例。原有两个场景因运行
      // 节奏恰好错开未暴露这些竞态，风暴场景追加在链条末端，必须能自愈。
      if (chromeProc === null || chromeProc.exitCode !== null || Date.now() - spawnedAt > 3000) {
        if (chromeProc && chromeProc.exitCode === null) {
          try { chromeProc.kill(); } catch (e) {}
        }
        await closeStaleBrowser();
        chromeProc = spawn(chromePath, [
          '--remote-debugging-port=9222',
          `--user-data-dir=${path.join(os.tmpdir(), `chrome-bench-storm-${enableExtension ? 'opt' : 'raw'}-${process.pid}-${Date.now()}`)}`,
          '--no-first-run',
          '--no-default-browser-check',
          '--headless=new',
          'about:blank'
        ], { stdio: 'ignore' });
        spawnedAt = Date.now();
        await new Promise(r => setTimeout(r, 400));
      }
      const page = await findDebugPage();
      if (page) {
        let id = 1;
        const callbacks = new Map();
        const ws = new global.WebSocket(page.webSocketDebuggerUrl);
        ws.onmessage = (event) => {
          const msg = JSON.parse(event.data);
          if (msg.id && callbacks.has(msg.id)) {
            callbacks.get(msg.id)(msg);
            callbacks.delete(msg.id);
          }
        };
        const send = (method, params = {}) => new Promise(r => {
          const mId = id++;
          callbacks.set(mId, r);
          ws.send(JSON.stringify({ id: mId, method, params }));
        });
        await new Promise(r => ws.onopen = r);
        await send('Page.enable');
        await send('Performance.enable');

        await send('Emulation.setDeviceMetricsOverride', {
          width: 1280,
          height: 800,
          deviceScaleFactor: 1,
          mobile: false
        });

        await send('Page.navigate', { url: 'file:///' + benchHtmlFile.replace(/\\/g, '/') });
        await new Promise(r => setTimeout(r, 600));

        if (enableExtension) {
          // 注入扩展 CSS 与 Virtualizer 控制器（与现有场景完全一致的注入代码）
          const injectRes = await send('Runtime.evaluate', {
            expression: `
              (() => {
                const style = document.createElement('style');
                style.textContent = ${JSON.stringify(contentCss)};
                document.head.appendChild(style);
                ${virtualizerSrc}
                window.__virtualizer = window.ZhihuAnswerVirtualizer.createVirtualizer({ enabled: true, bufferViewports: 2 });
                return { inited: Boolean(window.__virtualizer), stats: window.__virtualizer.getStats() };
              })()
            `,
            returnByValue: true
          });
          console.log('Virtualizer 注入结果:', JSON.stringify(injectRes));
          await new Promise(r => setTimeout(r, 300));

          // 等待初始 100 行全部注册完成，保证风暴开始前基线干净（全部真实高度，无 420px 折叠残留）
          const baselineRes = await send('Runtime.evaluate', {
            awaitPromise: true,
            returnByValue: true,
            expression: `
              new Promise((resolve) => {
                const t0 = performance.now();
                const poll = () => {
                  const rows = document.querySelectorAll('.List-item[data-zop]');
                  let registered = 0;
                  for (let i = 0; i < rows.length; i++) {
                    if (rows[i].classList.contains('zhihu-smoother-answer')) registered++;
                  }
                  if ((rows.length > 0 && registered === rows.length) || performance.now() - t0 > 8000) {
                    resolve({ totalRows: rows.length, registeredRows: registered, elapsedMs: Math.round(performance.now() - t0) });
                    return;
                  }
                  requestAnimationFrame(poll);
                };
                requestAnimationFrame(poll);
              })
            `
          });
          console.log('初始 100 行基线注册:', JSON.stringify((baselineRes?.result?.result?.value) || (baselineRes?.result?.value) || null));
        }

        // 内核指标快照（每轮取 LayoutCount/LayoutDuration 差值）
        const takeMetrics = async () => {
          const res = await send('Performance.getMetrics');
          const map = {};
          res.result.metrics.forEach(m => map[m.name] = m.value);
          return map;
        };
        let prevMetrics = await takeMetrics();

        const rounds = [];
        for (let r = 0; r < STORM_ROUNDS; r++) {
          const startIndex = 100 + r * STORM_BATCH_SIZE;
          const itemIds = [];
          let batchHtml = '';
          for (let k = 0; k < STORM_BATCH_SIZE; k++) {
            // 追加行不带 role="listitem"（见 buildAnswerCardHtml 注释），其余体积与真实卡片完全一致
            batchHtml += buildAnswerCardHtml(startIndex + k, false);
            itemIds.push(200000 + startIndex + k);
          }
          const roundRes = await send('Runtime.evaluate', {
            awaitPromise: true,
            returnByValue: true,
            expression: buildStormRoundExpression(enableExtension, batchHtml, itemIds)
          });
          const rd = (roundRes?.result?.result?.value) || (roundRes?.result?.value) || null;
          if (!rd || rd.error) {
            throw new Error(`第 ${r + 1} 轮 evaluate 失败: ${JSON.stringify(roundRes).slice(0, 300)}`);
          }
          const curMetrics = await takeMetrics();
          rd.layoutCountDelta = curMetrics.LayoutCount - prevMetrics.LayoutCount;
          rd.layoutDurationDelta = Math.round((curMetrics.LayoutDuration - prevMetrics.LayoutDuration) * 1000) / 1000;
          prevMetrics = curMetrics;
          rounds.push(rd);
          console.log(`  第 ${r + 1}/${STORM_ROUNDS} 轮: ${enableExtension ? '整批注册完成耗时' : '固定等待'} ${rd.roundMs} ms | 文档高度 ${rd.heightBefore} → ${rd.bodyHeight} px | 本批实测高度和 ${rd.batchHeightSum} px | 行高和 Δ ${rd.rowsSum - rd.rowsSumBefore} px | Layout Δ ${rd.layoutCountDelta} 次 / ${rd.layoutDurationDelta} ms`);
        }

        // 终态核查：smoother 场景所有回答行（排除空哨兵）必须全部完成注册
        let finalCheck = null;
        let vStats = null;
        if (enableExtension) {
          const finalRes = await send('Runtime.evaluate', {
            returnByValue: true,
            expression: `
              (() => {
                const all = document.querySelectorAll('.List-item');
                const rows = document.querySelectorAll('.List-item[data-zop]');
                let registered = 0;
                const unregisteredIds = [];
                for (let i = 0; i < rows.length; i++) {
                  if (rows[i].classList.contains('zhihu-smoother-answer')) {
                    registered++;
                  } else {
                    let itemId = null;
                    try { itemId = JSON.parse(rows[i].getAttribute('data-zop')).itemId; } catch (e) {}
                    unregisteredIds.push(itemId);
                  }
                }
                // 与 CSS 折叠规则同口径的检查：未注册行（排除无 data-zop 的空哨兵）必须为 0
                let unregisteredNonSentinel = 0;
                for (let i = 0; i < all.length; i++) {
                  if (all[i].classList.contains('zhihu-smoother-answer')) continue;
                  if (!all[i].getAttribute('data-zop')) continue;
                  unregisteredNonSentinel++;
                }
                return { totalAnswerRows: rows.length, registeredRows: registered, unregisteredNonSentinel: unregisteredNonSentinel, unregisteredIds: unregisteredIds.slice(0, 10) };
              })()
            `
          });
          finalCheck = (finalRes?.result?.result?.value) || (finalRes?.result?.value) || null;
          console.log('终态注册核查:', JSON.stringify(finalCheck));
          const statsRes = await send('Runtime.evaluate', {
            returnByValue: true,
            expression: 'window.__virtualizer ? window.__virtualizer.getStats() : null'
          });
          vStats = (statsRes?.result?.result?.value) || (statsRes?.result?.value) || null;
        }

        ws.close();
        chromeProc.kill();
        fs.unlinkSync(benchHtmlFile);

        return {
          rounds,
          finalCheck,
          vStats,
          totalMs: Math.round(rounds.reduce((s, x) => s + x.roundMs, 0) * 100) / 100,
          totalLayoutCount: rounds.reduce((s, x) => s + x.layoutCountDelta, 0),
          totalLayoutDuration: Math.round(rounds.reduce((s, x) => s + x.layoutDurationDelta, 0) * 100) / 100
        };
      }
    } catch (e) {
      // 与现有场景同样的容错重试，但保留一行诊断信息便于定位失败原因
      console.log(`  [风暴场景 ${enableExtension ? 'smoother' : 'vanilla'}] 第 ${i + 1}/30 次尝试失败: ${(e && e.message) ? e.message.slice(0, 200) : e}`);
    }
    await new Promise(r => setTimeout(r, 300));
  }
  // 30 次尝试全部失败：兜底清理，避免留下僵尸 chrome 持续占用调试端口
  if (chromeProc && chromeProc.exitCode === null) {
    try { chromeProc.kill(); } catch (e) {}
  }
  try { fs.unlinkSync(benchHtmlFile); } catch (e) {}
  return null;
}

// 输出"连续加载风暴对比"报告块
function printStormReport(vanilla, smoother) {
  console.log('');
  console.log(`============ 连续加载风暴对比报告 (${STORM_ROUNDS} 轮 × 每轮 ${STORM_BATCH_SIZE} 回答，哨兵反馈回路) ============`);
  if (!vanilla || !vanilla.rounds || vanilla.rounds.length === 0 || !smoother || !smoother.rounds || smoother.rounds.length === 0) {
    console.log('风暴场景运行失败（chrome 启动或 CDP 通信异常），无法生成完整报告。');
    if (vanilla && vanilla.rounds) console.log('vanilla 部分数据:', JSON.stringify(vanilla));
    if (smoother && smoother.rounds) console.log('smoother 部分数据:', JSON.stringify(smoother));
    console.log('===================================================================================================\\n');
    return;
  }

  console.log('每轮明细 (ms / px):');
  console.log('轮次 | vanilla 固定等待 | smoother 整批注册完成 | vanilla 文档高度 | smoother 文档高度 | smoother 注册行/总行');
  for (let i = 0; i < Math.max(vanilla.rounds.length, smoother.rounds.length); i++) {
    const v = vanilla.rounds[i] || {};
    const s = smoother.rounds[i] || {};
    console.log(`  ${String(i + 1).padStart(2)} | ${String(v.roundMs !== undefined ? v.roundMs : '-').padStart(8)} | ${String(s.roundMs !== undefined ? s.roundMs : '-').padStart(10)} | ${String(v.bodyHeight !== undefined ? v.bodyHeight : '-').padStart(8)} | ${String(s.bodyHeight !== undefined ? s.bodyHeight : '-').padStart(8)} | ${s.registeredRows !== undefined ? s.registeredRows + '/' + s.totalRows : '-'}`);
  }

  console.log(`- 10 轮总耗时: vanilla ${vanilla.totalMs} ms vs smoother ${smoother.totalMs} ms`);
  console.log(`- 平均每轮耗时: vanilla ${Math.round(vanilla.totalMs / vanilla.rounds.length * 100) / 100} ms vs smoother ${Math.round(smoother.totalMs / smoother.rounds.length * 100) / 100} ms`);

  // vanilla 文档高度单调性：每轮追加 5 个真实高度卡片，必须单调增长
  const vHeights = vanilla.rounds.map(r => r.bodyHeight);
  let vMonotonic = true;
  for (let i = 1; i < vHeights.length; i++) {
    if (vHeights[i] <= vHeights[i - 1]) { vMonotonic = false; break; }
  }
  console.log(`- vanilla 文档高度单调增长: ${vMonotonic ? '是' : '否'} (轨迹: ${vHeights.join(' → ')})`);

  // smoother 文档高度单调性 + 折叠残留检查：
  // 注册完成后本轮文档高度应 ≥ 上一轮高度 + 本批新行实测真实高度和（容忍 50px 取整/边界噪声）
  const sHeights = smoother.rounds.map(r => r.bodyHeight);
  let sMonotonic = true;
  for (let i = 1; i < sHeights.length; i++) {
    if (sHeights[i] <= sHeights[i - 1]) { sMonotonic = false; break; }
  }
  const residuals = [];
  for (let i = 0; i < smoother.rounds.length; i++) {
    const r = smoother.rounds[i];
    // 行级判据（主口径，免疫哨兵干扰）：全部回答行的实测高度和应 ≥ 上一状态行高和 + 本批新行实测高度和。
    // 若新批有行停留在 420px 折叠占位（loading 风暴的核心残留特征），该和会显著低于期望。
    const expectedRows = r.rowsSumBefore + r.batchHeightSum;
    if (r.rowsSum < expectedRows - 50) {
      residuals.push({ round: i + 1, kind: 'row', actual: r.rowsSum, expected: Math.round(expectedRows), shortfall: Math.round(expectedRows - r.rowsSum) });
      continue;
    }
    // 文档级判据（任务口径，扣除哨兵自身高度变化）：空哨兵同样是未注册的 .List-item，
    // 离屏时会被 CSS 种子规则折叠成 420px 占位、进入视口后恢复真实高度（恒定偏移，非新批折叠）
    const expectedDoc = r.heightBefore + r.batchHeightSum + (r.sentinelHeight - r.sentinelHeightBefore);
    if (r.bodyHeight < expectedDoc - 50) {
      residuals.push({ round: i + 1, kind: 'doc', actual: r.bodyHeight, expected: Math.round(expectedDoc), shortfall: Math.round(expectedDoc - r.bodyHeight) });
    }
  }
  console.log(`- smoother 文档高度单调增长: ${sMonotonic ? '是' : '否'} (轨迹: ${sHeights.join(' → ')})`);
  if (residuals.length === 0) {
    console.log('- smoother 折叠残留检查: 未发现残留（每轮追加后行高和/文档高度均与期望一致）');
  } else {
    console.log(`- smoother 折叠残留检查: 发现 ${residuals.length} 轮残留!`);
    residuals.forEach(x => console.log(`    第 ${x.round} 轮 (${x.kind === 'row' ? '行高和口径' : '文档高度口径'}): 实测 ${x.actual} px < 期望 ${x.expected} px (缺口 ${x.shortfall} px)`));
  }

  console.log(`- 总 LayoutCount (10 轮): vanilla ${vanilla.totalLayoutCount} 次 vs smoother ${smoother.totalLayoutCount} 次`);
  console.log(`- 总 LayoutDuration (10 轮): vanilla ${vanilla.totalLayoutDuration} ms vs smoother ${smoother.totalLayoutDuration} ms`);
  console.log('- 测量口径说明: 空哨兵本身也是未注册的 .List-item，离屏时会被 CSS 种子规则折叠成 420px 占位;');
  console.log('  折叠残留判据以"回答行高度和"为主口径（免疫该哨兵偏移），文档高度口径已扣除哨兵自身高度变化。');

  const fc = smoother.finalCheck;
  if (fc) {
    const extra = fc.unregisteredIds && fc.unregisteredIds.length > 0
      ? ` (未注册 itemId: ${fc.unregisteredIds.join(',')})`
      : '';
    console.log(`- 终态注册核查 (smoother): 回答行总数 ${fc.totalAnswerRows}, 已注册 ${fc.registeredRows}, 排除哨兵后未注册行 ${fc.unregisteredNonSentinel}${extra}`);
  }
  if (smoother.vStats) console.log('顺滑器内部状态 (vStats):', JSON.stringify(smoother.vStats));
  console.log('===================================================================================================\\n');
}

async function main() {
  console.log('====================================================');
  console.log('  Chromium 真实内核基准测试 (100 回答长页面极限压测)');
  console.log('====================================================\n');

  console.log('[1/4] 正在运行: 知乎原生未优化 (Vanilla)...');
  const vanilla = await runTestScenario(false);
  console.log('      原生数据收集完毕。\n');

  console.log('[2/4] 正在运行: 开启知乎顺滑器 (Smoother Zhihu)...');
  const smoother = await runTestScenario(true);
  console.log('      顺滑器数据收集完毕。\n');

  console.log('================== 实测对比数据报告 ==================');
  console.log('顺滑器内部状态 (vStats):', smoother.vStats);
  console.log(`- 批量回答挂载耗时 (Mount Duration): 原生 ${vanilla.mountDuration} ms vs 顺滑器 ${smoother.mountDuration} ms`);
  console.log(`- 连续滚动平均帧率 (Scroll FPS):    原生 ${vanilla.fps} FPS vs 顺滑器 ${smoother.fps} FPS`);
  console.log(`- 活跃排版回答卡片数 (Active Rows):  原生 ${vanilla.activeItems}/${vanilla.totalItems} vs 顺滑器 ${smoother.activeItems}/${smoother.totalItems}`);
  console.log(`- 内核布局总耗时 (Layout Duration): 原生 ${vanilla.layoutDuration} ms vs 顺滑器 ${smoother.layoutDuration} ms`);
  console.log(`- 样式重算耗时 (Recalc Style):      原生 ${vanilla.recalcStyleDuration} ms vs 顺滑器 ${smoother.recalcStyleDuration} ms`);
  console.log(`- 布局重排触发次数 (Layout Count):  原生 ${vanilla.layoutCount} 次 vs 顺滑器 ${smoother.layoutCount} 次`);
  console.log(`- 页面总 DOM 节点数:                原生 ${vanilla.totalDomNodes} 节点 vs 顺滑器 ${smoother.totalDomNodes} 节点`);
  console.log('======================================================\n');

  console.log('[3/4] 正在运行: 连续加载风暴 (Vanilla)...');
  const stormVanilla = await runStormScenario(false);
  console.log('      风暴原生数据收集完毕。\n');

  console.log('[4/4] 正在运行: 连续加载风暴 (Smoother Zhihu)...');
  const stormSmoother = await runStormScenario(true);
  console.log('      风暴顺滑器数据收集完毕。\n');

  printStormReport(stormVanilla, stormSmoother);
}

main();
