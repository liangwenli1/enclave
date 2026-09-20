---
version: 1
name: Enclave-design-system
source: adapted from awesome-design-md/clickhouse (VoltAgent/awesome-design-md)
description: >
  Enclave 的统一视觉系统，官网与工作台共用。近纯黑画布 (#0a0a0a) 上只有一个品牌
  电压——电光黄 (#faff69)，用于主 CTA、关键数字与「已准入」这类唯一重点，绝不做
  装饰。正文是 Inter，哈希 / 端口 / PID / 原因码一律 JetBrains Mono。卡片是比画布
  略亮的深灰面板 (#1a1a1a) 配 1px 发丝边框，没有阴影堆叠、没有玻璃模糊、没有渐变。
  系统没有浅色版：Enclave 只有深色。
---

## 0. 这份文件管什么

官网（`enclave-www`）和工作台（`enclave/src`）必须读同一套 token。两边改颜色、字号、
圆角、间距，都只能改这里定义的变量，不许在组件里写死十六进制色值。

一条硬规则贯穿全文：**用户不需要看到的东西不准出现在这两个界面里。**
内部通道名、构建阶段、验证机、模板残留、占位区块、没接通的按钮，一律不进 UI。
能给用户做决定的信息（哈希、原因码、额度、到期日）要显眼；给开发者看的（P0/P4、
commit、内部路径）一个字都不留。

---

## 1. 颜色

```
canvas            #0a0a0a   页面地板，唯一背景色
surface-soft      #121212   分区微差、表头、条纹行
surface-card      #1a1a1a   卡片、代码窗、表格容器、输入框
surface-elevated  #242424   卡片里的卡片、hover 态、选中行
hairline          #2a2a2a   1px 边框
hairline-strong   #3a3a3a   强分隔、输入框下边线

ink               #ffffff   标题与主文本
body              #cccccc   正文
body-strong       #e6e6e6   强调段落
muted             #888888   说明、表头、次要
muted-soft        #5a5a5a   fine print

primary           #faff69   品牌电压：主 CTA、关键数字、唯一重点
primary-active    #e6eb52   按下 / hover
primary-disabled  #3a3a1f   禁用态底色（配 muted 文字）
on-primary        #0a0a0a   黄底上的文字，永远是近黑

success           #22c55e   Running / 已准入 / 校验通过
warning           #f59e0b   candidate / 需要确认 / 自签名
error             #ef4444   拒启 / 哈希不符 / 失败
info              #3b82f6   中性提示（少用）
```

规则：

- 黄色一次只在一个视觉层级出现。一屏里同时有黄按钮和黄数字，就把数字降成白色。
- 一屏最多一个黄色主操作（弹窗、引导各自算一屏）。列表每行都有的操作一律用次要按钮，
  需要提示可点时只给图标上色。
- 状态色只用于状态，不当装饰，不做背景大色块；需要底色时用 12% 混入画布。
- 黄底区块（CTA band、主推套餐卡）里所有文字用 `on-primary`，不许用白字。
- 没有浅色模式。`color-scheme: dark` 固定。

---

## 2. 字体

```
sans   Inter, "PingFang SC", "Microsoft YaHei", "Noto Sans SC", system-ui, sans-serif
mono   "JetBrains Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace
```

**两端都不加载第三方字体。** 工作台必须离线可用且不得向任何第三方发请求；官网主要面向
中国大陆访问，Google Fonts 不可靠。统一走系统栈：装了 Inter / JetBrains Mono 的机器自动
用上，没装的落到 PingFang SC / 微软雅黑 / Consolas，版式按系统栈调过，不依赖网络字体。

| token | 字号 | 字重 | 行高 | 字距 | 用在哪 |
|---|---|---|---|---|---|
| display-xl | clamp(40px, 6vw, 72px) | 700 | 1.05 | -2.5px | 官网首屏大标题 |
| display-lg | clamp(32px, 4.5vw, 56px) | 700 | 1.10 | -2px | 官网分区标题 |
| display-md | clamp(26px, 3vw, 40px) | 700 | 1.15 | -1.5px | CTA band |
| display-sm | 32px | 700 | 1.20 | -1px | 工作台页面主标题 |
| title-lg | 24px | 700 | 1.30 | -0.3px | 卡片大标题、套餐名 |
| title-md | 18px | 600 | 1.40 | 0 | 卡片标题、分区小标题 |
| title-sm | 16px | 600 | 1.40 | 0 | 列表项标题 |
| stat | clamp(36px, 5vw, 56px) | 700 | 1.0 | -1.5px | 关键数字（黄色） |
| body-md | 16px | 400 | 1.55 | 0 | 官网正文 |
| body-sm | 14px | 400 | 1.55 | 0 | 工作台正文 |
| caption | 13px | 500 | 1.40 | 0 | 说明文字 |
| overline | 12px | 600 | 1.40 | 1.5px, uppercase | 分区眉标、表头 |
| code | 14px | 400 | 1.55 | 0 | 哈希、端口、路径、原因码 |
| button | 14px | 600 | 1 | 0 | 所有按钮 |

中文标题不使用 -2.5px 这种负字距（会粘连）：中文标题一律 `letter-spacing: -0.01em`。
判断方式在组件里用 `.is-cjk` 类，不靠脚本探测。

---

## 3. 圆角 / 间距 / 尺寸

```
radius   xs 4   sm 6   md 8（按钮、输入框）   lg 12（卡片）   pill 9999（徽章）
space    4 · 8 · 12 · 16 · 24 · 32 · 48 · 96(section)
控件高度  按钮/输入 40px；紧凑型 32px；触摸目标最小 44px（官网）
容器宽度  官网 1120px；工作台内容区 min(100%, 1280px)
```

卡片一律 `radius-lg` + `1px hairline`，**不加阴影**。悬浮反馈只改背景到
`surface-elevated`，不位移、不放大。

---

## 4. 组件规格

### 按钮

| 变体 | 底 | 字 | 边框 |
|---|---|---|---|
| primary | `primary` | `on-primary` | 无 |
| secondary | `surface-card` | `ink` | `hairline` |
| ghost | 透明 | `body` | 无（hover 改 `surface-card`） |
| danger | 透明 | `error` | `error` 混 40% |

高 40px，横向 padding 20px，`radius-md`，`button` 字号。禁用态用 `primary-disabled`
底 + `muted` 字，**并且必须有 title 说明为什么禁用**——不给原因的灰按钮不许出现。

### 卡片

`surface-card` + `hairline` + `radius-lg` + padding 24px（官网 32px）。
卡片里嵌卡片用 `surface-elevated`。

### 表格（哈希表、环境表、代理表）

表头 `overline` + `muted`，底 `surface-soft`；行分隔 1px `hairline`；
悬浮行 `surface-elevated`；数值列（哈希 / 端口 / 字节 / 时间）一律 `code` + `tabular-nums`。
长哈希不折行，用 `text-overflow: ellipsis` + 点击复制。

### 状态徽章

`pill` + 12px 字 + 左侧 6px 圆点。三种：
`success` 运行中 / 已准入 · `warning` 需确认 · `error` 已拒启。
**没有第四种颜色**，不用黄色做状态。

### 输入框

`surface-card` 底、`hairline-strong` 下边线、40px 高、`radius-md`。
聚焦：边框转 `primary`，外加 2px `primary` 40% 的 focus ring。
错误：边框 `error`，下方 13px `error` 文案，文案必须说清怎么改。

### 代码 / 哈希块

`surface-card` + `radius-lg` + 20px padding + `code` 字体 + `body` 色。
右上角常驻复制按钮。哈希块是 Enclave 的招牌元素，官网下载页和工作台内核页都用它。

### 空状态

图标 + 一句话说明 + 一个主操作。不允许出现「暂无数据」这种没有下一步的空页。

---

## 4.5 文案：界面不是文档

**常驻的解释性文字一律不写进界面。** 用户每天看十遍的地方，不该每次都讲一遍原理。
原理、背景、我们为什么这么做——全部放官网文档页。

界面上只允许三类文字：

1. **出错时的原因和下一步**：`哈希对不上，已拒绝启动。删掉重下。` ——只在错误发生时出现。
2. **勾选前必须知道的后果**：关沙箱、用预览通道内核这类同意项，一句话讲清代价。
3. **跟着输入框的一行提示**：格式要求、为什么现在不能填。

页面标题下面那行只写**事实**（数量、状态、版本），不写道理：

- 对：`3 / 50 个环境 · 1 个运行中 · Solo`
- 错：`代理绑定到环境后，内核启动时会同时关掉 QUIC 和 DoH，避免绕过代理直连。`

判断方法：这句话用户读过一次之后，第二次还需要读吗？不需要 → 它属于文档。

---

## 5. 版式节奏

官网：分区间距 96px，首屏 h1 后接一句 `body-md` 引导句（最多两行），随后是
「三张卡 / 黄色 CTA band / 数据表」三种块的循环，不要连续两个同类型块。

工作台：左侧固定导航 232px，内容区上 24px、左右 32px；页面主标题 `display-sm`
后接一句 `caption` 状态行（例如「内核 148.0.7778.215 · 已准入 · 3 个环境运行中」）。

---

## 6. 动效

只有三种：透明度 150ms、背景色 150ms、内容进入 250ms 位移 4px。
缓动统一 `cubic-bezier(0.22, 1, 0.36, 1)`。
`prefers-reduced-motion` 下全部降到 0.01ms。不做视差、不做无限循环动画。

---

## 7. 可访问性

- 正文对比度 ≥ 4.5:1（`body` #cccccc on #0a0a0a = 11.6:1，达标）。
- `muted-soft` 只能用于 13px 以上的非关键信息。
- 所有交互元素有 `:focus-visible` 黄色描边，键盘可达。
- 状态不只靠颜色：徽章带文字，表格状态列带文字。
- 中文界面 `lang="zh-CN"`，字号不小于 13px。

---

## 8. 明令禁止

- 玻璃拟态、模糊背景、渐变网格、霓虹发光、装饰性插画。
- 一屏超过一个黄色主操作。
- 灰色禁用按钮不给原因。
- 「即将推出」「敬请期待」「Coming soon」占位块。
- 内部术语出现在 UI：验证机、P0/P1/P4、candidate 通道（对用户说「预览版」）、
  commit、dev user、preview、模板残留页面。
- 假的成功态：没接通的功能不许给按钮，更不许点了什么也不发生。
