# 文案

界面里的每个字都要有用:告诉用户现在是什么情况,或者下一步能做什么。先写文案,再写代码。
`scripts/scan-copy.mjs` 查能数出来的那些毛病;下面是它查不出的部分。

## 写法

- **按钮是动词加对象**:"Allow once"、"Delete session"、"Add host"。不写"OK""Submit""Yes"。破坏性的按钮写出被破坏的东西,
  确认框里的主按钮和触发它的按钮用同一个词。
- **状态用名词和事实**:"Reconnecting"、"Working"、"Waiting for your approval"。不写"请稍候"。
- **错误写三样**:发生了什么、为什么(远端或系统原话,不改写)、用户能做什么。远端的原话放在后面,原样,等宽显示。
  - 差:"Something went wrong."
  - 好:"Not connected to this host. ssh: connect to host build-1 port 22: Connection refused. Check that the host is up, then Retry."
- **空状态说下一步**:"No sessions yet." 后面跟一个能点的 "New session",不是一句鼓励。
- **只写真的**:不编数字、人名、时间。一个数字要么来自数据,要么不出现。
- **一种语言,一种大小写**:现在界面是英文,句首大写,其余小写;标题不用 Title Case。加了本地化再说,不要中英混排。
- **不自我介绍,不聊界面本身**:不写"This screen lets you…"、"We've added…"。
- **术语一致**:host、session、agent、turn、permission 各只有一个叫法,不换着说(不要 server/machine/remote 混用)。
- **句子短,不加感叹号、表情、省略号装饰**。"Starting…" 里的省略号表示还在进行,可以;别处不用。

## 模型腔

读起来像模型写的,通常是这几类。一个不一定是问题,成群出现才是。

- **空话**:powerful、seamless、effortless、robust、elevate、unlock、leverage、ecosystem、journey。它们顶替一个事实:
  "seamless" 顶替的是步骤,"robust" 顶替的是失败时的表现。写事实。
- **套话**:"Oops""Uh-oh""Something went wrong""Please try again later""An error occurred"。这些什么也没说。
- **美德词**:honest、actually、genuinely、simply、thoughtful。界面不夸自己。
- **对比句式**:"Not just X, but Y"、"X, not Y"。只说正面的事实。
- **每个按钮旁边的小说明**:控件的名字已经说明它做什么;只有后果不明显时才加一句(例如"Deletes the history for good")。
- **过度礼貌或过度亲切**:不用 "Hi there!"、"Let's get started!"。
- **标签式标题堆叠**:每个区块一个小标题再加一句副标题。能删掉副标题就删。
- **一致的"人设"**:没有幽默、没有双关;出错的地方尤其不要。

## 过度修正

别因为规则造出另一种腔:全是碎片短句、全用被动、每个错误都以"Check your connection"结尾。文案跟着情况走,没有固定模板。

## 例子(都来自现在的界面)

| 位置 | 现在 | 判断 |
|---|---|---|
| 空对话 | "Nothing here yet. Say something below." | 可以,说了下一步 |
| 空会话列表 | "No sessions yet." | 缺一个下一步;旁边要有 "New session" |
| 没有 agent | "No agent is available on this host." | 缺原因和下一步:是没装还是没登录? |
| 设置提示 | "A change applies to the next thing the agent does." | 好,说的是后果 |
| 加载 | "Loading the conversation…" | 可以 |
