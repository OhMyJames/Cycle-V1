# 动效

Cycle 里的动效只做一件事:让一个变化被看见。没有理由的动效删掉。内容在不动的时候也必须是完整的。

## 可以动的

| 什么 | 怎么动 | 时间 |
|---|---|---|
| 按钮、可点的行 | 悬停时底色变深一档;按下时 `scale(.985)` | 100ms(`--cycle-motion-state`) |
| 焦点 | 不做过渡,焦点环直接出现 | 0 |
| 对话框、菜单、提示 | 淡入加 4 到 6px 位移;关闭更快 | 进 200ms(`--cycle-motion-enter`),出 100ms |
| 横幅(更新、daemon 版本) | 出现时淡入,不推动已有内容跳动 | 200ms |
| "Working" 的状态点 | 缓慢脉动,一个周期 1.2 到 2s | 循环 |
| 新消息和流式文字 | 文字直接追加,不做逐字动画;滚动只在用户在底部时跟随 | 无 |
| 列表增删 | 不做动画 | 无 |

## 不可以

- 弹跳、回弹、过冲、旋转、闪光、发光。
- 动 width、height、top、left、margin、padding。只用 transform 和 opacity(悬停时可以变颜色)。
- 滚动触发的出现、视差、滚动劫持。
- 流式输出时让页面跳:代码块、表格、图片占位要在开始时就有稳定的高度,或只往下长。
- 超过 200ms 的界面过渡(循环的状态点除外)。
- 打字机效果。agent 的输出已经够慢了。

## 数值

- 三档时长:状态变化(悬停、按下)100ms,展开收起 160ms,出现 200ms。展开收起时只有那块长高或缩短,里面的内容淡入,不位移。
- 曲线用一条:`cubic-bezier(.2, .8, .2, 1)`(ease-out);循环用 linear。
- 距离:悬停不位移,对话框 6px,横幅 4px。
- 在 `app.css` 里用自定义属性定义一次(`--cycle-ease`、`--cycle-motion-state`、`--cycle-motion-disclosure`、`--cycle-motion-enter`),别处引用,不写散落的数字。

## 减少动效

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation: none !important; transition: none !important; }
}
```

这是整个应用唯一允许 `!important` 的地方。减少动效下,状态点不脉动,改用文字("Working")表达,不能因为动效没了而丢信息。

## 每个动效写一行理由

在写文案的同一步写下来:"横幅淡入:避免内容突然被推下去";"状态点脉动:表示还在工作,文字旁边已有 Working"。写不出来就不要做。
