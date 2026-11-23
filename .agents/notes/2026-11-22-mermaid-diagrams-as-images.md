# Agent Note: agent 回复里的 Mermaid 用 mermaid.js(strict)画，以 data URL 图片显示，不进页面 DOM

Status: accepted
Date: 2026-11-22
Basis: 2026-11-22 UX 对齐批次的任务说明("Mermaid diagrams in agent markdown":securityLevel strict、无 HTML 标签、不联网、无脚本、懒加载、跟随深浅色、流式和出错时退回代码块、能看源码);对照 `cycle_v2` 的 `packages/ui/src/content/mermaid*.ts(x)` 与它的笔记 `2026-11-08-mermaid-svg-in-the-page.md`;本仓库 `node_modules/streamdown@2.8.0` 的 mermaid 实现。

## Problem

agent 回复里的 ` ```mermaid ` 一直显示成代码。要画成图，但源码来自 agent,是不可信内容(docs/desktop.md "页面的安全设置")。任何画法都会产出 SVG,只要这份 SVG 成为页面 DOM 的一部分，它的元素、属性、样式、链接就跨过了边界：页面握着到 main 的桥，而 agent 能执行命令。

## Decision

- 用 `mermaid`(11.17.2,精确版本)在页面里画，配置 `securityLevel: "strict"`、`htmlLabels: false`(含 `flowchart.htmlLabels`)、`suppressErrorRendering: true`,并把 `htmlLabels`、`flowchart`、`theme`、`themeVariables`、`themeCSS`、`fontFamily`、`darkMode` 加进 `secure`,图自己的 `%%{init}%%` 和 front matter 改不回来。
- 画出的 SVG **不插进页面**:在一个不显示的 `DOMParser` 文档里读一遍(只改尺寸、去掉 strict 仍保留的 `<a>`),序列化成 `data:image/svg+xml` 用 `<img>` 显示。作为图片的 SVG 不执行脚本、不加载任何外部资源、链接不可点，这是浏览器保证的，不依赖我们的清洗规则跟上 mermaid 的输出。mermaid 排版时临时插进页面的节点仍受页面 CSP 约束(`connect-src 'none'`、`img-src 'self' data:`、`script-src 'self'`)。
- mermaid 用动态 `import()` 在第一张图时才加载(Bun 分包，启动包里只多一份分包清单)。
- 颜色在画的时候从 `--cycle-*` 令牌读成 `rgb()` 交给 mermaid 的 `base` 主题;深浅色各画一次并缓存(包括失败的),系统切换时重画。字体用系统字体：图片里用不了页面打包的字体，排版和显示必须是同一种字体。
- 围栏没闭合、正在画、画不出来时都是原来的代码块(同一个节点，不换树，不闪);画不出来时下面一行说明，不显示 mermaid 的错误图。图下有 "Show source" 切回源码(带 Copy),图本身可以按下放大(ui-sdk Dialog,键盘可用)。

## Alternatives considered

- **Streamdown 2.8 自带的 mermaid 插件**(`plugins.mermaid`,配 `@streamdown/mermaid`):它用 `dangerouslySetInnerHTML` 把 SVG 插进页面，安全全靠 mermaid 自己的 DOMPurify;界面文字("Loading diagram..."、"Mermaid Error:")写死不能翻译，出错框是写死的红色 Tailwind 类;下载 PNG/SVG 会在页面里生成文件下载。放弃。
- **cycle_v2 的做法**(beautiful-mermaid 加一整套 SVG 元素/属性白名单，再插进页面):白名单要跟着渲染器升级维护，漏一项就是页面里的内容;而且 beautiful-mermaid 不画 gantt、pie、mindmap 等。图片的边界更简单，也不受渲染器输出变化影响。没有采用。
- **mermaid 的 `securityLevel: "sandbox"`**:它把图放进 iframe,而页面 CSP 是 `frame-src 'none'`,放宽 CSP 不值得。放弃。

## Consequences

- 图里的文字不能选中复制(要复制就 Show source);图片按容器缩小，很大的图要放大看。
- mermaid 及其依赖(d3、dagre、cytoscape、katex、dompurify 等，均为宽松许可)约 18 MB 分包随应用发布，只在用到时加载。
- 页面字体和图里字体不同(系统字体)。
- `packages/ui/test/browser/diagram.browser.tsx` 断言：图是 data URL 图片、页面里没有 mermaid 的 SVG、带 HTML/脚本/链接/`%%{init}%%` 的源码画出来不含 `foreignObject`、`javascript:`、外链。CSP 下(`script-src 'self'`)不触发违规，是 2026-11-22 在临时测试里查的，没有进测试集。
- 部分取代 [会话 Markdown 规则](2026-11-22-conversation-markdown-rules.md) 第 7 条里"Mermaid 不做"的部分;数学公式仍不做。

## Related

- [会话里 agent 的 Markdown 怎么画](2026-11-22-conversation-markdown-rules.md)
