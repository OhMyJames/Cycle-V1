# 检查

按从便宜到贵的顺序。每一步的目的是找出"看起来没问题但其实有问题"的地方。

## 1. 门禁(每次)

```bash
bun run check        # 边界、css、类型、lint、单元测试、DOM 测试,约 10 秒
```

新的界面状态要在 DOM 测试里有一条(`packages/ui/test/dom/app.dom.tsx`,假桥接在 `test/fake-bridge.ts`)。

## 2. 文案

```bash
bun .claude/skills/cycle-design-taste/scripts/scan-copy.mjs            # 默认扫 packages/ui/src/react
bun .claude/skills/cycle-design-taste/scripts/scan-copy.mjs path/a.tsx # 指定文件或目录
```

它读 JSX 文本和 `title`、`aria-label`、`placeholder`、`alt`、`label` 里的字符串,命中空话、套话、美德词、感叹号、表情、破折号。
不为通过它而改写:命中的词如果是字面意思(例如真的在说 "harness"),在这一行说明理由,而不是把句子改坏。
它查不出"没说事实"的文案,那要自己读(`references/copy.md`)。

## 3. 状态画廊

`bun packages/ui/gallery/shoot.ts`(在仓库根目录)用真实组件和假数据画出每个状态,在真实 Electron 里截图,浅色和深色、
1200×800 与 760×600(`--sizes` 换尺寸,`--platform darwin` 按 Mac 的标题栏画),并报告页面是否横向溢出、有没有控制台错误。改了界面就跑一遍,**读几张最相关的截图**。
界面加了新状态,就在 `packages/ui/gallery/scenarios.ts` 里加一个场景。详见 `DESIGN.md` 第 12 节。

## 4. 在真实窗口里看

门禁看不到颜色、间距、溢出、对齐。要看真东西:

- **冒烟**:`bun run test:integration smoke`(在 `apps/desktop` 下;会先 build)在 xvfb 下启动真实 Electron,走一遍连接、新建、发消息、批准。
- **真实模型的运行**:`CYCLE_REAL_MODEL_TOKEN=… bun run test:real`(在 `apps/desktop` 下,先在根目录 build);
  `SHOT_TO=/路径.png` 把窗口截图存下来。用法见 `docs/desktop.md`。
- **在 Mac 上**:打包出来的应用(`bun run build`,或从发布里下载)是用户真正看到的东西,窗口装饰、字体、深色模式以它为准。

看的时候:

1. **浅色和深色**各一遍(令牌用 `light-dark()`,跟随系统;在 Mac 上切系统外观,或在 Electron 里用 `nativeTheme.themeSource` 强制)。
2. **窗口大小**:默认(1200×800)和最窄的可用宽度;侧栏和主区都不能被挤坏。
3. **极端数据**(`references/states.md` 末尾)。
4. **键盘**:不碰鼠标,从头 Tab 到尾;焦点环看得见、不被裁掉;Esc 关闭对话框并把焦点还回触发处。
5. **流式中**:发一条会产生长输出的消息,看页面是否跳动、滚动是否只在用户在底部时跟随。
6. **缩放**:系统字体放大一档时布局仍然成立。

## 已知缺口(诚实记录)

- 状态画廊已有,但没有自动的视觉回归(不和上一次截图比较);颜色和间距的错误靠人眼读截图。
- 没有自动的视觉回归;颜色和间距的错误只能靠人眼和这份清单发现。
- 没有自动的可访问性扫描(例如 axe);键盘和 ARIA 只做了 ui-sdk 自带的那部分。
- 深色模式、窗口缩放在 Linux 的 xvfb 下不能代表 Mac 的实际效果。
