# 第三方组件与素材声明

## 代码许可

本仓库的**代码**（AstrBot 插件、Electron 桌宠 App、构建脚本）采用 **MIT** 许可，见 `LICENSE`。

## 运行时依赖

| 组件 | 许可 | 说明 |
|---|---|---|
| [AstrBot](https://github.com/AstrBotDevs/AstrBot) | AGPL-3.0 | 宿主框架，本仓库不包含其代码 |
| [Electron](https://www.electronjs.org/) | MIT | 桌宠桌面壳 |
| [PixiJS](https://pixijs.com/) | MIT | WebGL 渲染 |
| [pixi-live2d-display](https://github.com/guansss/pixi-live2d-display) | MIT | Live2D 的 Pixi 封装 |
| [Live2D Cubism Core](https://www.live2d.com/download/cubism-sdk/) | **Live2D Proprietary Software License** | 见下方说明 |
| [websockets](https://github.com/python-websockets/websockets) | BSD-3-Clause | 插件依赖 |

## Live2D Cubism Core

`app/src/renderer/vendor/live2dcubismcore.min.js` 是 Live2D 官方的 Cubism Core 运行时。

**使用本仓库或其中的桌宠程序，表示你同意
[Live2D Proprietary Software License Agreement](https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html)**
以及 [Live2D Cubism SDK 的发布条款](https://www.live2d.com/en/sdk/license/)。

如果你要分发本程序的**修改版本**，请自行确认是否符合 Live2D 的再分发条款，
或在发布页引导用户从 Live2D 官网自行下载 Core 文件。

## Live2D 模型文件

**本仓库不包含任何 Live2D 模型文件。**

模型（`.model3.json` / `.moc3` / 贴图 / 动作 / 表情）的版权属于各自作者，
多数模型（尤其是 VTube Studio 上发布的模型）**明确禁止再分发**。
请自行获取有授权的模型并放入 `models/` 目录，具体见 `models/README.md`。
