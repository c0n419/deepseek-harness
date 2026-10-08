---
description: "启用实验性 Herdr 多路复用器控制：宿主 socket 服务与 Web 面板。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-herdr-bundle

[English](README.md) | 中文

## 概述

此可选 Bundle 组合 Herdr 宿主 socket 服务与其 Web 面板。随包配置默认禁用。

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

打开 Web 侧栏的插件管理页并启用带终端窗口图标的 Herdr。启用后侧栏面板栏出现 Herdr 入口；打开后可查看工作区、标签页与面板，读取所选面板的输出，发送提示词或允许的按键，并聚焦面板。启用前请先启动 Herdr 服务器：配置的 socket 上没有服务器时，面板会提示 Herdr 未运行并提供重试。禁用 Bundle 会同时撤回两条配置项；面板与 socket 服务一起停止。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>维护者信息 — 点击展开</summary>

静态 `cordis.patch.yml` 插入两条配置项：宿主服务（`@deepseek-ai/dsh-experimental-herdr`）与 Web 面板（`@deepseek-ai/dsh-experimental-client-ui-herdr`）。可选 Bundle 安装使插件管理器能够发现此包，但不会在默认配置中选择它。浏览器贡献拥有其生成 Remote 的挂载；稳定 API Remotes 不导入实验性代码。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Herdr 宿主服务](../herdr/README.zh.md) —— socket 协议、Remote 接口与配置。
- [Herdr Web 面板](../client-ui-herdr/README.zh.md) —— 面板界面与控件。
- [实验性包](../README.zh.md) —— 孵化状态与发布策略。

-----

<a id="model-experience"></a>
## 模型体验

无，因为面板从浏览器驱动 Herdr 服务器，不注册任何面向模型的输入。

#### KV 缓存影响

没有直接影响；没有模型请求携带 Herdr 状态。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- **每进程一个服务器** —— 服务只连接配置中指定的 socket；其他 socket 上的命名 Herdr 会话不在组合范围内。
- **不做布局变更** —— 创建、关闭、拆分、移动与服务器命令均不在范围内；面板只读取结构并驱动已聚焦的面板。
- **面板状态不持久化** —— 页面刷新会重新打开视图流；Herdr 的任何内容都不会写入 Session 日志。
- **需要可达的 Herdr 版本** —— 服务校验上报的协议版本，不兼容时报告状态而不是降级运行。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者信息 — 点击展开</summary>

无。

</details>
