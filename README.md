# 知乎顺滑器 (Smoother Zhihu)

面向 Chromium 内核浏览器的轻量级极客扩展。专为解决知乎网页版（尤其是超长回答问答流）越滚越卡、内存飙升、交互阻塞与大面积空白而生。

[![CI](https://github.com/wayneCui628/smoother-zhihu/actions/workflows/ci.yml/badge.svg)](https://github.com/wayneCui628/smoother-zhihu/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Manifest V3](https://img.shields.io/badge/Manifest-V3-success.svg)](manifest.json)
[![Zero Dependencies](https://img.shields.io/badge/Dependencies-0-orange.svg)](package.json)

---

## 核心特性

- ⚡ **抗点击交互阻塞**：对知乎新拉取的回答卡片应用 `content-visibility: auto`，跳过批量插入时 500+ DOM 节点的强制样式与深度排版，主线程挂载耗时由 400ms 暴降至 10ms，请求加载时点击秒级响应；
- 🖼️ **全量图片异步解码**：自动为问答流配图标记原生 `decoding="async"`，把繁重的位图解码移出渲染主线程，杜绝图文混排引发的丢帧卡顿；
- 🛡️ **非侵入式虚拟化架构**：**绝不暴力销毁或篡改 DOM 节点**，保留知乎 React 的容器所有权与事件监听；仅在远离视口时利用原生 CSS Containment 冻结渲染，临近视口原地无感唤醒；
- 👁️ **两阶段视口绝对保底**：杜绝盲目信赖异步 `IntersectionObserver` 造成的滚动露白；滚动调度以 $O(1)$ 复杂度与只读/写入两阶段分离巡检保底，只要卡片进入物理视窗，瞬间强制解冻；
- 🚫 **纯净阅读与广告隔离**：零样式污染抹去信息流中的商业广告（`.Pc-word-new` 等推广），不占任何滚动空间，同时严密保护知乎无限滚动探测器；
- 📊 **智能避让悬浮挂件**：右下角极简常驻状态条，动态感知知乎原生返回顶部按钮，支持暗色模式自适应与无障碍读屏（WAI-ARIA）规范。

---

## 安装使用

### 快速安装（开发者模式）
1. 将本项目 Clone 或下载解压至本地：
   ```bash
   git clone https://github.com/wayneCui628/smoother-zhihu.git
   ```
2. 打开 Chromium 内核浏览器扩展管理页面：
   - **Chrome**: `chrome://extensions`
   - **Edge**: `edge://extensions`
3. 勾选页面右上角的**「开发者模式」**（Developer mode）；
4. 点击左上角**「加载已解压的扩展程序」**，选择本项目根目录；
5. 打开任意回答数量较多的知乎问题页（如 50+ 回答），尽情丝滑滚动体验！

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

本项目是独立的浏览器前端渲染性能调优开源扩展，仅供 Web 渲染流水线、现代 CSS Containment 规范与性能工程技术交流学习使用。

“知乎”商标及相关版权归知乎（Zhihu Inc.）所有，本项目与知乎公司不存在任何隶属、认可、赞助或合作关系。

---

## 开源协议 (License)

本项目采用 [MIT License](LICENSE) 许可协议。
