# 把 Live2D 模型放在这里

本仓库**不包含任何 Live2D 模型文件**（体积大，且绝大多数模型禁止再分发）。

## 目录要求

每个模型一个子文件夹，里面是 Cubism 3 / 4 格式（`.model3.json`）：

```
models/
└── 我的模型/
    ├── 我的模型.model3.json    ← 入口文件，桌宠扫描的就是它
    ├── 我的模型.moc3
    ├── 我的模型.physics3.json
    ├── 我的模型.cdi3.json
    ├── textures/
    │   ├── texture_00.png
    │   └── ...
    ├── motions/
    │   └── *.motion3.json
    └── expressions/
        └── *.exp3.json
```

支持 `.model3.json`（Cubism 3/4）和 `.model.json`（Cubism 2，功能有限）。

## 从哪里获取模型

| 来源 | 说明 |
|---|---|
| [Live2D 官方示例模型](https://github.com/Live2D/CubismWebSamples) | 免费可商用，适合先跑通 |
| [VTube Studio](https://denchisoft.com/) 上作者公开的模型 | **务必看作者的授权说明** |
| 自己用 Live2D Cubism Editor 制作 | 最自由 |

## ⚠️ 授权提醒

- 从 VTube Studio / Booth 下载的模型，**大多数明确禁止再分发**，只能自己本地使用
- 部分模型允许「个人使用 + 改参数」，但禁止「打包分发模型文件」
- **请勿**把 `models/` 目录提交到你的 Git 仓库 —— 本仓库的 `.gitignore` 已排除它
- 如果你想分享自己的配置，可以导出 `config.json`，但不要带上模型

## 模型兼容性说明

桌宠对模型做过一些兼容处理：

- **混合颜色**（`multiplyColor` / `screenColor`）：已支持
- **裁剪遮罩**：已修复低分辨率导致的锯齿
- **定制表情**（`IsModelCustomizationExpression`）：直接写参数驱动
- **多贴图 / 大贴图**（4096~8192）：已做 mipmap 与各向异性过滤

如果你的模型显示异常，可以在桌宠设置里开关 `autoHideBlendColor`，
或调整 `clippingMaskSize` / `renderScale`。
