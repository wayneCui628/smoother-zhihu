<p align="center">
  <img src="src/assets/icon-128.png" alt="知乎顺滑器 Logo" width="80" height="80">
</p>

<h1 align="center">知乎顺滑器 (Smoother Zhihu)</h1>

<p align="center">面向 Chromium 内核浏览器的轻量级极客扩展。专为解决知乎网页版（尤其是超长回答问答流）越滚越卡、内存飙升、交互阻塞与大面积空白而生。</p>

[![CI](https://github.com/wayneCui628/smoother-zhihu/actions/workflows/ci.yml/badge.svg)](https://github.com/wayneCui628/smoother-zhihu/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Manifest V3](https://img.shields.io/badge/Manifest-V3-success.svg)](manifest.json)
[![Zero Dependencies](https://img.shields.io/badge/Dependencies-0-orange.svg)](package.json)

---

## 核心特性

- ⚡ **抗点击交互阻塞**：对知乎新拉取的回答卡片应用 `content-visibility: auto`，跳过批量插入时 500+ DOM 节点的强制样式与深度排版，主线程挂载耗时由 400ms 暴降至 10ms，请求加载时点击秒级响应；
- 🖼️ **全量图片异步解码**：自动为问答流配图标记原生 `decoding="async"`，把繁重的位图解码移出渲染主线程，杜绝图文混排引发的丢帧卡顿；
- 🛡️ **非侵入式虚拟化架构**：**绝不暴力销毁或篡改 DOM 节点**，保留知乎 React 的容器所有权与事件监听；仅在远离视口时利用原生 CSS Containment 冻结渲染，临近视口原地无感唤醒；
- 👁️ **两阶段视口绝对保底**：杜绝盲目信赖异步 `IntersectionObserver` 造成的滚动露白；基于 rAF 节流的只读/写入两阶段分离巡检保底，只要卡片进入物理视窗，瞬间强制解冻；
- 🚫 **纯净阅读与广告隔离**：零样式污染抹去信息流中的商业广告（`.Pc-word-new` 等推广），不占任何滚动空间，同时严密保护知乎无限滚动探测器；
- 📊 **智能避让悬浮挂件**：右下角极简常驻状态条，动态感知知乎原生返回顶部按钮，支持暗色模式自适应与无障碍读屏（WAI-ARIA）规范。

---

## 安装使用

### 快速安装（开发者模式）
1. 获取项目代码（任选一种）：
   - **Git 方式**：运行 `git clone https://github.com/wayneCui628/smoother-zhihu.git`
   - **直接下载**：点击页面右上角绿色 **Code** 按钮 -> **Download ZIP**，下载后解压到本地；
2. 打开 Chromium 内核浏览器扩展管理页面：
   - **Chrome**: 地址栏输入 `chrome://extensions`
   - **Edge**: 地址栏输入 `edge://extensions`
3. 开启 **开发者模式**（Chrome 位于页面右上角开关，Edge 位于左侧菜单栏底部）；
4. 点击 **加载已解压的扩展程序** (Load unpacked)，选择本项目包含 `manifest.json` 的解压根目录；
5. 打开任意回答数量较多的知乎问题页（如 50+ 回答），尽情享受丝滑滚动体验！

---

## 开发与自动化测试

本项目坚持纯粹极简的设计哲学：**零构建工具（No Webpack/Vite）、零外部运行时依赖（Zero npm dependencies）**。代码即是产物，所有语法与单元测试均由 Node.js 原生 Test Runner 驱动：

```powershell
# 运行全套语法校验与 54 项深度单元测试
npm run check
```

---

## 隐私声明 (Privacy)

本扩展恪守极致的隐私安全规范：
- 仅申请扩展最基础的 `storage` 权限用于持久化本地视口缓冲配置；
- **无任何远程代码**、**无任何分析埋点/统计 SDK**、**无任何外部网络请求**；
- 所有的虚拟化与排版调优均在浏览器沙箱本地完成，绝不读取、收集或上传你的任何知乎浏览数据。

---

## 免责声明 (Disclaimer)

1. 本项目是独立的浏览器前端渲染性能调优开源扩展，仅供 Web 渲染流水线、现代 CSS Containment 规范与性能工程技术交流学习使用。
2. “知乎”商标及相关知识产权归北京智者天下科技有限公司及 Zhihu Inc. 所有，本项目与知乎公司不存在任何隶属、认可、赞助或合作关系。
3. 本扩展提供的信息流样式调整规则仅供个人前端学习研究与样式自定义演示，扩展本身不属于商业广告拦截工具。用户使用本扩展时须自行遵守《知乎用户协议》，因使用本工具导致的任何潜在争议，作者概不承担法律连带责任。

---

## 开源协议 (License)

本项目采用 [MIT License](LICENSE) 许可协议。
