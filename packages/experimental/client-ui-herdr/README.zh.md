---
description: "在 Web 客户端中驱动 Herdr 多路复用器：工作区树、智能体状态、面板输出与提示词。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-client-ui-herdr

[English](README.md) | 中文

## 概述

此可选浏览器插件在侧栏面板栏增加 Herdr 入口与对应的全局页面。页面将 Herdr 服务器上报的工作区、标签页、面板与检测到的智能体渲染为带状态徽标的树，以带颜色的交互式终端屏幕显示所选面板，并提供提示词输入框、按键行以及聚焦操作。顶部一行报告连接状态：已连接时显示服务器版本，否则显示不可用或不兼容状态并提供重试。请通过已发布的实验性 Herdr Bundle 选择此包。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

通过 [`@deepseek-ai/dsh-experimental-herdr-bundle`](../herdr-bundle/README.zh.md) 启用此包，该 Bundle 一并提供宿主 socket 服务与本面板。Web 客户端加载器挂载 `/client` 导出；根宿主导出为空实现。

### 查看结构

左栏列出 Herdr 服务器上报的每个工作区，及其标签页与各标签页中的面板。面板行显示面板名与 Herdr 检测到的智能体。承载智能体的面板还带状态点与对应徽标——空闲为中性、运行中为进行中、受阻为警告、完成为成功——而没有智能体的面板两者都不显示，只显示“无智能体”文案，因为 Herdr 对这类面板上报的 `unknown` 并不描述任何智能体。所选面板在列表中标记，右栏随之切换。Herdr 自身的聚焦显示在所选行上，“聚焦”操作会把服务器焦点移到所选面板，无论其上是否有智能体。

### 读取输出与发送输入

右栏以 xterm 屏幕显示所选面板：带颜色的近期输出，按面板自身的列数换行，行数填满面板高度。点击屏幕并输入，会把每个按键——字母、Enter、方向键、Ctrl 组合——按顺序作为原始终端输入发送到面板，发送进行中输入的按键会合并到下一次发送；只有当用户位于历史底部时新读取才会替换屏幕，因此向上滚动阅读旧输出不会被打断。未选择面板时不显示任何控件。普通 shell 输出时 Herdr 不推送任何事件，因此面板每隔 `outputRefreshMs` 毫秒（随视图下发的 Host 设置）重新读取所选面板，读取进行中时跳过该次刷新；推送的 revision 变化、再次选择该面板以及每次发送提示词、按键或键入输入后也会重新读取，而在切换到其他面板后才返回的读取结果会被丢弃。提示词输入框可按 Enter 或“发送”提交，向所选面板承载的智能体发送一条提示词，并在没有智能体的面板上隐藏——输入框显示“无智能体”文案且发送按钮保持禁用——因为 Herdr 只能向智能体发送提示词。按键行与“聚焦”操作直接作用于面板本身，因此在任何面板上都可用；按键为 Esc、Ctrl+C、Enter、↑、↓、y 与 n。Herdr 拒绝的命令会在控件旁报告；已从服务器消失的面板会在输出位置报告。

### 连接状态

两种未连接状态都提供重试，因为两者的恢复方式相同：面板丢弃已结束的观察流并重新打开一个，宿端则据此重新探测服务器。配置的 socket 上没有服务器响应时，页面提示 Herdr 未运行并给出原因。服务器报告的协议号与本面板不一致时，页面显示期望值与实际值，而不是展示无法信任的树；当 Herdr 服务器升级或更换后，重试即可发现新服务器，无需重新加载页面。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>维护者信息 — 点击展开</summary>

客户端导出挂载自身生成的 `/remote` 贡献，注册本地化字典，并通过 Cordis effect 注册两个槽位：`sidebar.panellist` 的栏图标（其 id 同时是键控 `main` 面板的键）。一个流句柄驱动共享的 `createSnapshotStore`，存储持有完整的 `HerdrView`；面板通过注入的 hook 座位订阅，因此树与连接行由同一快照重渲染。所有命令都是按所选面板 id 寻址的单次 Remote 调用——从不使用 Herdr 以智能体名寻址的方法，因此没有智能体的面板依然可聚焦、可发送按键；面板读取则在所选面板推送的 revision 变化时、再次选择该面板时，或被拒绝的命令之后发出——从不使用定时器。释放插件 fiber 会中止流、撤回两个槽位并卸载 Remote 命名空间。

| 文件 | 作用 |
|---|---|
| [`src/client/mount.ts`](src/client/mount.ts) | Remote 挂载、字典、栏图标与主面板注册 |
| [`src/client/HerdrPanel.tsx`](src/client/HerdrPanel.tsx) | 连接状态、树、输出、提示词与按键控件 |
| [`src/client/locales.ts`](src/client/locales.ts) | 中英文面板文案 |
| [`src/index.ts`](src/index.ts) | 空宿主入口 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Herdr Bundle](../herdr-bundle/README.zh.md) —— 已发布的实验性 Bundle，挂载宿主服务与本面板。
- [Herdr 宿主服务](../herdr/README.zh.md) —— socket 协议、Remote 方法与配置。
- [实验性包](../README.zh.md) —— 孵化状态与发布策略。

-----

<a id="model-experience"></a>
## 模型体验

无，因为此浏览器面板不注册面向模型的输入；它发送的提示词经由 Herdr 服务器到达 Herdr 智能体。

#### KV 缓存影响

没有直接影响；此框架的任何模型请求都不携带 Herdr 状态。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- **不做布局变更** —— 面板无法创建、关闭、拆分或移动工作区、标签页与面板；它只读取结构并驱动所选面板。
- **重建的屏幕** —— 每次读取都根据 Herdr 的近期行重建屏幕而非流式推送，因此光标停在最后一行末尾，全屏程序的光标位置不会被还原。
- **按间隔读取** —— 所显示的面板每隔 `outputRefreshMs` 重新读取以跟随输出，因此新文本与键入回显最多延迟一个间隔出现。
- **固定宽度** —— 屏幕保持面板的列数；比面板更宽的窗格会横向滚动，而不是重新换行。
- **发送提示词需要智能体** —— 在 Herdr 未检测到智能体的面板上不显示提示词输入框；此类面板仍可使用按键行与“聚焦”操作。
- **激活时机** —— 在已打开的页面中启用 Bundle 后，需重新加载才能获得面板槽位。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者信息 — 点击展开</summary>

无。

</details>
