const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');

const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const virtualizerSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'content', 'virtualizer.js'), 'utf8');
const contentCss = fs.readFileSync(path.join(__dirname, '..', 'src', 'content', 'content.css'), 'utf8');

// 构建高保真知乎问答长流页面（100 个真实问答卡片，每个卡片包含头像、富文本、多段落、代码块、图片与操作条，约 4000 个 DOM 节点）
function buildBenchHtml(answerCount = 100) {
  let answersHtml = '';
  for (let i = 0; i < answerCount; i++) {
    answersHtml += `
      <div class="List-item" role="listitem" data-zop='{"type":"answer","authorName":"答主_${i}","itemId":${200000 + i}}'>
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

async function runTestScenario(enableExtension) {
  const benchHtmlFile = path.join(__dirname, `bench_${enableExtension ? 'opt' : 'raw'}.html`);
  fs.writeFileSync(benchHtmlFile, buildBenchHtml(100));

  const chromeProc = spawn(chromePath, [
    '--remote-debugging-port=9222',
    `--user-data-dir=${path.join(process.env.TEMP, `chrome-bench-${enableExtension ? 'opt' : 'raw'}`)}`,
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

async function main() {
  console.log('====================================================');
  console.log('  Chromium 真实内核基准测试 (100 回答长页面极限压测)');
  console.log('====================================================\n');
  
  console.log('[1/2] 正在运行: 知乎原生未优化 (Vanilla)...');
  const vanilla = await runTestScenario(false);
  console.log('      原生数据收集完毕。\n');

  console.log('[2/2] 正在运行: 开启知乎顺滑器 (Smoother Zhihu)...');
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
}

main();
