# 0012 界面的源语言是 en-US,为 i18n 预留

状态:已接受(2026-11-18)。用户的要求:界面的主语言是 en-US,以后要能支持 i18n。

## 决定

- **源语言是 en-US。** 界面上每一句话先以 en-US 写成,放在消息目录 `packages/ui/src/messages/en-US.ts`。别的语言是同一结构的另一个文件,缺的键回退到 en-US。`<html lang="en-US">`。
- **文字和代码分开。** 组件里写 `t("search.empty")`,不写 `"No session matches that."`。键按位置命名(`search.placeholder`),不按内容命名,改措辞不用改键。
- **整句,不拼句。** 不写 `"Delete " + name`:别的语言词序不同。变化的部分用 `{placeholder}`;数量用复数消息(`{ one, other }`,语言需要的 `few`、`many` 等由 `Intl.PluralRules` 选)。
- **数字和日期用 `Intl`**,按语言的写法(`t.number`、`t.date`),不手写格式、不手拼单位("5 MB" 用 `style: "unit"`)。
- **参数是文字,不是标记。** 一个参数里的 `<b>`、`{x}` 原样显示,不解释。
- **版式经得起变长。** 别的语言的同一句话常常更长(德语约 +30% 到 +40%):按钮和标签不写死宽度,长文字省略并能看全。图标不带文字。
- 实现在 `packages/ui/src/i18n.ts`(没有 React 和 DOM,主进程也能用)和 `react/i18n.tsx`(`I18nProvider`、`useI18n`)。没有 Provider 时用 en-US。

## 分步迁移

存量的界面文字(约 60 处,在对话框、侧栏、对话、权限卡、更新横幅里)还写在标记里。这一步只做地基和新文字:

- **新写的界面文字**(会话搜索、图片、代码配色)都走目录。
- **门禁里有一个"棘轮"**:`scan-copy.mjs --i18n` 数每个文件里还写在标记里的界面文字,和 `.claude/skills/cycle-design-taste/scripts/i18n-baseline.json` 比。只能减少,不能增加;新文件不允许有。把存量搬进目录后,用 `--update` 把基线降下来。
- 它抓得到:JSX 里的文字、`title`、`aria-label`、`placeholder`、`alt`、`label` 的字面量。**抓不到**:三元表达式里的字符串、拼出来的模板字符串、store 和 model 里的错误文案。迁移时这些要人工找。

## 不在这一步决定的

> 2026-11-22 补:前两条(支持哪些语言、运行时怎么选)已在 [`2026-11-22-appearance-and-language-preferences`](../../.agents/notes/2026-11-22-appearance-and-language-preferences.md) 里决定;main 自己的文字里只有系统通知跟随所选语言。下面保留当时的原文。

- 支持哪些语言,谁来翻译,放在哪个文件夹。
- 运行时怎么选语言(跟随系统,还是应用里的设置)。`Intl` 的 locale 来自哪里:渲染进程能读 `navigator.language`,main 的 `app.getLocale()` 更准。
- 从右到左的语言(阿拉伯语、希伯来语)。样式里的 `padding-left`、`margin-left` 要改成逻辑属性(`padding-inline-start`),图标里有方向的(箭头)要翻转。现在没做。
- **不翻译的**:agent 的输出(它自己的语言)、daemon 和 agent 返回的错误原话(连不上主机时 ssh 的原话,等宽显示)、命令、路径、版本号。这些是数据,不是界面。
- main 进程自己产生的文字(原生对话框、菜单、更新错误)。它们要有自己的目录,或者由渲染进程翻译。

## 为什么

- 现在没有做:在 en-US 单语时加 `t()` 是纯成本。但文字散在 60 多处、没有规矩,以后迁移的成本会随每个新功能涨。立规矩和棘轮的成本很小,而且让存量不再增加。
- 不用现成的 i18n 库(i18next、FormatJS):我们的需求是一个键值目录、占位符和复数,用 `Intl` 就够;少一个依赖,也少一份打包体积。需要 ICU 的完整语法(select、嵌套复数)时再换,目录的结构(键和文字)不变。
