# Agent Note: 外观和语言由主进程保存在 preferences.json,主题用 nativeTheme 应用

Status: accepted
Date: 2026-11-22
Basis: CYCL-79("深浅色(跟随系统或指定)、界面语言……设置持久化到客户端";"先明确实际可选语言")。负责人 2026-11-22 在本轮对话里选定:语言提供 English 和简体中文,选项为跟随系统、English、简体中文。其余做法是实现时定的,记在这里。

## Problem

设置页要能指定浅色或深色,并选择界面语言,选择要在重启后保持。两件事各有约束:

- 样式全部用 `light-dark()`,另有一处 `@media (prefers-color-scheme: dark)`(深色下的字重),代码配色按系统深浅选 Shiki 主题,原生的菜单和对话框也有深浅。指定主题时这些要一起变。
- 页面的第一屏就要是选定的主题和语言,否则每次启动会闪一下。
- decision 0012 把"支持哪些语言、运行时怎么选"留到以后;此前页面的小偏好(代码配色、是否显示思考)各自存在渲染进程的 localStorage。

## Decision

- **存哪里**:`userData/preferences.json`,由主进程读写,格式 `{ "theme": "system" | "light" | "dark", "language": "system" | "en-US" | "zh-CN" }`。和 `settings.json`(环境列表)分开:这份文件坏了只丢一个外观选择,不影响环境列表;反过来也一样。
- **兼容规则**:文件缺失、不是 JSON、或某个值不在上面的词表里(包括更新的版本加的语言),该项按 `system`。文件里不认识的键保存时原样写回。页面送来的值按同一张词表检查,不认识的不生效。先写文件,写成功才生效并上报。
- **主题**:主进程设 `nativeTheme.themeSource`,在建窗口之前就设一次。样式不加 `[data-theme]` 之类的选择器。
- **语言**:页面在 `store.start()` 里先读到偏好再标记就绪,用 `I18nProvider` 包住整个应用,切换时整页换译文,不重启。`system` 取 `app.getPreferredSystemLanguages()[0]`(没有时 `app.getLocale()`):简体中文的 locale 用 `zh-CN`,其余(含繁体)用 `en-US`。主进程的系统通知用同一个选择。
- **语言的名字**用各自的语言写("English"、"简体中文"),不随当前语言翻译。
- 状态:已实现(`apps/desktop/src/main/preferences.ts`、`packages/ui/src/languages.ts`、`packages/ui/src/messages/zh-CN.ts`)。

## Alternatives considered

- **像代码配色那样存在渲染进程的 localStorage**:改动最小。没选:主题要在窗口创建前由主进程应用才没有闪烁,原生菜单和 `prefers-color-scheme` 也只有 `nativeTheme` 能一起改;语言还要给主进程的通知用。
- **在根元素上设 `color-scheme` 强制主题**:`light-dark()` 会跟着变,但 `@media (prefers-color-scheme)`、按系统深浅选的 Shiki 主题和原生控件不会,要逐处补,以后新写的媒体查询也会漏。
- **写进 `settings.json`**:少一个文件。没选:那份文件的读写围绕环境列表(旧格式迁移、读不懂的条目原样保留、坏了另存一份),把偏好掺进去会让两种东西共用一条出错路径。
- **只做机制、只列 English**,以及**这一轮不做语言**:都问过负责人,负责人选了中英两种。
- **繁体中文的系统也显示简体**:没选。没有繁体目录时给它简体是替用户做了没被要求的选择;用户仍可以手动选简体中文。

## Consequences

- 代码配色和"显示思考"仍在 localStorage,偏好现在有两个存放处。它们只影响页面自己,没有迁移的必要;以后要统一时迁到这份文件。
- 新增一种语言:加一个消息文件、在 `LANGUAGES` 和 `LANGUAGE_CHOICES` 里各加一项、在埋点的词表里加一个词。旧版本读到新语言的值会按跟随系统处理。
- 主进程自己产生的报错(更新失败原因等)和本机环境的名字仍是英文,没有目录。
- 中文译文由实现者(模型)一次译出,键和占位符的一致有测试,措辞没有经过人工审校。
- **未验证**:安装版真实窗口里切换主题时原生标题栏和菜单的表现;Linux 和 Windows 上 `getPreferredSystemLanguages` 的返回。

## Related

- [decision 0012:界面的源语言是 en-US](../../docs/decisions/0012-ui-language-en-us.md):这份笔记回答了它留下的"支持哪些语言、运行时怎么选"。
