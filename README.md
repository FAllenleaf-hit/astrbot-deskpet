<div align="center">

# 🐟 AstrBot Live2D 桌宠

**让你的 AstrBot 机器人拥有一个住在桌面上的 Live2D 形象**
—— 和 QQ / Telegram / 任何已有会话**共享同一套人格与对话记忆**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![AstrBot](https://img.shields.io/badge/AstrBot-v4.x-green.svg)](https://github.com/AstrBotDevs/AstrBot)
[![Electron](https://img.shields.io/badge/Electron-33-9cf.svg)](https://www.electronjs.org/)
[![Live2D](https://img.shields.io/badge/Live2D-Cubism%203%2F4-ff69b4.svg)](https://www.live2d.com/)

</div>

---

## 这是什么

AstrBot 是一个多平台聊天机器人框架。本项目给它加**第二个对话入口**：一个常驻桌面的 Live2D 形象。

- 你在桌宠里打字 → 消息进入 AstrBot **正常的消息流水线**
- 因此自动继承 AstrBot 的一切：**同一个人格、同一个 provider、同一套插件和工具、同一份长期记忆**
- 回复显示在桌宠气泡里，带**表情 + 身体动作 + 嘴型**，情绪还会延续到下一次对话

```
                 ┌── aiocqhttp / Telegram / ...  ──→  QQ / TG / ...
AstrBot 核心 ─────┤      （原有平台，不受影响）
（同一套 provider  │
  人格 / 插件 /     └── deskpet 适配器 ←─WebSocket─→  Live2D 桌宠 App
  记忆 / 数据库）                                    （Electron）
```

**不需要 NapCat**，桌宠走本地 WebSocket，和 QQ 链路完全解耦 —— NapCat 掉线也不影响桌宠。

---

## 特性

### 🎭 与机器人共享人格与记忆
- 桌宠消息走 AstrBot 正常流水线，人格、provider、插件全继承
- `shared_umo` 可以把桌宠和某个已有会话（如 QQ 私聊）**绑成同一条对话上下文**
- 长期记忆、知识库、工具调用全部可用

### 💃 参数驱动的动作系统（不依赖动作文件）

不播放模型的 `.motion3.json`，而是直接驱动 **Cubism 标准参数**，所以**任何
Cubism 3/4 模型**都能用，且不需要作者提供动作文件：

| 情绪 | 表现（由标准参数组合而成） |
|---|---|
| 开心 | 上下弹跳 + 轻微放大 + 头部上扬 + 眯眼 + 嘴笑 |
| 难过 / 累 | 低头 + 身体下沉 + 靠向一侧 + 眼睛半闭 + 嘴角下撇 |
| 生气 | 转身别过头 + 快速甩头 + 皱眉 + 抿嘴 |
| 好奇 | 整体凑近 + 前倾 + 歪头 + 睁大眼 + 嘴成小 O 型 |
| 害羞 | 低头躲避 + 视线偏移 + 身体左右轻摇 + 抿嘴微笑 |
| 思考 | 歪头看斜上方 + 眼球上移 + 抬单侧眉毛 |

此外还有：

- **待机行为**：呼吸起伏、头部微晃、左右张望、打哈欠、夜间犯困（可各自开关）
- **触摸反应**：戳头会歪头蹭手，戳身体会点头惊一下
- **说话前先转头**看向你，再显示气泡
- **长回复**中途穿插小动作，避免长时间一个姿势

> 具体每个情绪用什么参数组合，见 `app/src/renderer/renderer.js` 里的 `applyBehavior()`。
> 想加自己的动作，照着写一个 `case` 即可。

### 🎨 外观、表情、嘴型（跟随模型能力自动适配）

所有外观类设置都是**读取模型自身的资源**来生成的，不是写死的：

- **表情**：自动扫描模型 `FileReference.Expressions` 里的全部 `.exp3.json`
  （有多少个就用多少个），在设置面板里逐个列出，可点击预览
- **表情可叠加**：不同表情用不同参数时可以**同时生效**；共用同一参数的会自动互斥
  （面板会提示"与 XX 共用参数，已自动取消"）
- **外貌开关**：自动识别模型里的服装/道具类参数（命名各异的 `Clothes*`、`key*`
  `Movement*` 等），做成可持久保存的开关
- **待机嘴型**：如果模型有细分嘴部参数（`JawOpen` / `Press` / `MouthSmile_L/R` /
  `Mouthpucker` / `MouthFunnel` / `TongueOut` 等），可以选一个固定的待机嘴型并调强度；
  模型没有这些参数时该选项不生效
- **体型切换**：模型有多个体型参数时会自动做成三选一

> 换句话说：**模型的素材越多，可玩的越多**；素材少的模型也能正常用，
> 只是设置面板里可选项会相应减少。

### 🧩 模型兼容性

| 能力 | 需要的参数 | 缺少时 |
|---|---|---|
| 基础表情动作 | `ParamAngleX/Y/Z`、`ParamBodyAngleX/Z`、`ParamEyeBallX/Y`、`ParamEyeLOpen/ROpen`、`ParamMouthOpenY`、`ParamMouthForm`、`ParamBreath` | 缺少的参数对应动作不出现，其余正常 |
| 口型同步 / TTS | `ParamMouthOpenY`（或 `Groups.LipSync` 指定的参数） | 无语音播放 |
| 表情（`.exp3.json`） | 模型自带表情文件 | 设置面板无表情可选 |
| 外貌开关 | 服装/道具类自定义参数 | 面板无对应开关 |
| 待机嘴型 | `JawOpen` / `Press` / `Mouth*` 等细分嘴部参数 | 面板选项无效 |

<br>

### 🖼 支持图片消息
回复里的图片会真的显示在气泡里，文字和图片**不会被互相顶掉**（分段回复会自动合并）。

### 🔍 放大浏览全身
滚轮放大后自动对准上半身，`Alt+拖拽` / `Shift+滚轮` / 滚动条可平移浏览。

---

## 快速开始

> 详细步骤见 [`docs/INSTALL.md`](docs/INSTALL.md)

### 1. 准备 AstrBot
需要 **AstrBot v4.x**，且已有一个能正常对话的平台（QQ / Telegram 等）。

### 2. 安装桌宠 App

```bash
git clone https://github.com/USER/astrbot-deskpet.git
cd astrbot-deskpet/app
npm install
```

### 3. 放入 Live2D 模型

```bash
# 把模型文件夹放进 models/，目录结构举例：
#   models/我的模型/我的模型.model3.json
#   models/我的模型/我的模型.moc3
#   models/我的模型/textures/...
```
> ⚠️ 本仓库**不含模型文件**（授权限制），获取方式与注意事项见 [`models/README.md`](models/README.md)。

### 4. 启动桌宠

```bash
npm start
# 或 Windows 双击 app/start.bat
```
桌宠右下角点 **⚙** → 设置面板里可以切换形象、预览动作和表情。

### 5. 安装 AstrBot 插件

把 `plugin/` 目录整个复制到 AstrBot 的 `data/plugins/` 下，重命名为 `astrbot_plugin_deskpet`：

```
<AstrBot>/data/plugins/astrbot_plugin_deskpet/
├── main.py
├── metadata.yaml
├── _conf_schema.json
└── requirements.txt
```

重启 AstrBot（或面板里重载插件）。

### 6. 挂载平台

1. AstrBot 面板 →「消息平台」→ 新增
2. 类型选 **Live2D 桌宠**
3. `host` / `port` 与桌宠 `config.json` 里的 `ws` 保持一致（默认 `127.0.0.1:8765`）
4. 保存后桌宠左下角应显示 **「AstrBot：已连接」**

在任意平台发 `/deskpet` 可以查看配置提示。

---

## 配置说明

### 插件配置（面板 → 插件 → Live2D 桌宠）

| 配置项 | 默认 | 说明 |
|---|---|---|
| `host` / `port` | `127.0.0.1` / `8765` | 桌宠 App 的监听地址 |
| `token` | 空 | 与桌宠 `ws.token` 一致（可选） |
| **`shared_umo`** | 空 | **共享哪条会话的记忆**，见下 |
| `mark_admin` | `true` | 把桌宠消息视为管理员（可绕过会话白名单、使用管理员命令） |
| `owner_id` | 空 | 发送者 ID，留空自动取 `shared_umo` 末尾那段 |
| `emotion_tag` | `true` | 解析回复里的 `[happy]` 等情绪标签驱动表情 |
| `inject_emotion_hint` | `true` | 自动给 LLM 注入「回复末尾带情绪标签」的约定 |
| `strip_tag_on_other_platforms` | `true` | 在 QQ 等平台移除情绪标签，避免被别人看到 |
| `mood_ttl_sec` | `7200` | 情绪延续有效期 |
| `max_image_mb` | `4` | 转给桌宠的图片体积上限 |
| `debug` | `false` | 写 `data/deskpet/debug.log` 排查问题 |

#### 关于 `shared_umo`（重点）

桌宠的会话身份由 `unified_msg_origin`（umo）决定。想让桌宠和 QQ 私聊**共用同一段对话**：

```
default:FriendMessage:123456789
└── 平台ID  └── 消息类型  └── 对方QQ号
```

- **填了** → 桌宠与这条 QQ 私聊共用上下文和记忆（两边说的话互相可见）
- **留空** → 桌宠使用自己的独立会话 `deskpet:private:me`，人格仍共享，但上下文不互通

> 平台的 id 可以在面板「消息平台」里看到（默认是 `default`）。

### 桌宠配置（`app/config.json`，首次运行自动生成）

| 项 | 说明 |
|---|---|
| `model` | 当前模型（相对 `models/` 的路径） |
| `scale` / `fill` | 缩放 / 占窗口高度的比例 |
| `window` | 窗口尺寸与位置 |
| `ws` | WebSocket 监听地址，需与插件一致 |
| `behavior` | 各类行为开关、动作幅度、待机嘴型 |
| `appearance` | 已选的外观（衣服/眼镜/体型）与面部表情 |
| `clippingMaskSize` | 遮罩缓冲尺寸，影响**细边缘锯齿**（默认 2048） |
| `renderScale` | 超采样倍率 |

大部分都能在桌宠的 ⚙ 设置面板里改，不用手动编辑 JSON。

---

## 常见问题

<details>
<summary><b>桌宠显示「AstrBot：未连接」</b></summary>

1. 确认 AstrBot 正在运行
2. 面板里 deskpet 平台是否已启用
3. `host`/`port` 是否与桌宠 `config.json` 的 `ws` 一致
4. 桌宠设置面板 →「重连 AstrBot」

</details>

<details>
<summary><b>桌宠里打字没有回复</b></summary>

最常见原因是 **AstrBot 的会话白名单**。检查：

- 面板 →「配置」→ `platform_settings.enable_id_white_list`
- 若开启，桌宠的 umo（或 `shared_umo`）必须在白名单里
- **或**开启 `wl_ignore_admin_on_friend` + 插件配置 `mark_admin=true`（默认如此）

排查：插件配置里把 `debug` 设为 `true`，看 `<AstrBot>/data/deskpet/debug.log`，
里面会记录「收到消息 → 提交事件 → 进 LLM → 发送」每一步卡在哪。

</details>

<details>
<summary><b>模型边缘有锯齿</b></summary>

桌宠已内置多项修复（`clippingMaskSize=2048` 是其中关键）。
如果仍有锯齿，可在 `config.json` 里把 `clippingMaskSize` 调到 `4096`，
或把 `renderScale` 从 `1.5` 调到 `2.0`（更吃显卡）。

</details>

<details>
<summary><b>模型鼻子/嘴巴颜色异常</b></summary>

部分模型用了 Cubism 的「混合颜色」（multiplyColor / screenColor）特性。
桌宠已给渲染器补上 shader 支持，正常情况下会正确显示；
如仍异常，检查 `config.json` 里的 `autoHideBlendColor`（默认 `false`）。

</details>

<details>
<summary><b>情绪标签老是没出现</b></summary>

模型不一定遵守「输出情绪标签」的约定（尤其上下文很长或有其他插件注入提示词时）。
桌宠有**关键词兜底推断**：即使没有标签，也会按回复内容猜一个情绪。

</details>

---

## 项目结构

```
astrbot-deskpet/
├── app/                    # Electron 桌宠 App
│   ├── src/main.js         # 主进程：窗口 / 托盘 / WebSocket 服务端 / IPC
│   ├── src/preload.js      # contextBridge API
│   └── src/renderer/       # 渲染进程：Pixi + Live2D + 行为系统 + 设置面板
├── plugin/                 # AstrBot 插件（平台适配器）
│   ├── main.py
│   ├── _conf_schema.json   # 面板里的插件配置项
│   └── metadata.yaml
├── models/                 # ← 你自己放 Live2D 模型（不入库）
├── tools/                  # 开发辅助脚本
├── docs/
│   ├── INSTALL.md          # 详细安装
│   ├── PROTOCOL.md         # WebSocket 协议
│   └── VENDOR-PATCHES.md   # 对渲染库打的补丁说明
├── scripts/
│   └── package-release.mjs # 打包 release 用
├── assets/                 # 图标
├── LICENSE
└── NOTICE.md               # 第三方组件与素材声明
```

---

## 技术要点

几个踩过的坑，写下来供参考：

| 问题 | 结论 |
|---|---|
| 细边缘锯齿 | `pixi-live2d-display` 把**裁剪遮罩缓冲写死 256×256**，放大后每个遮罩像素≈5 屏幕像素 → 大台阶。用 `setClippingMaskBufferSize(2048)` 解决 |
| 混合颜色不生效 | 该库没实现 `multiplyColor`/`screenColor`，**给片元着色器补两个 uniform** 解决 |
| 表情调不动 | 模型的定制表情是 `IsModelCustomizationExpression`，走 `model.expression()` 无效 → 改成**直接写参数** |
| 动作幅度太小 | 2~6° 的头部偏转在 400px 窗口里看不出来 → 加全局幅度倍率（默认 2.5） |
| 参数被覆盖层抵消 | 外貌覆盖每帧重置参数，会让「累加型偏移」算错基准 → `addParam` 改为对覆盖参数使用覆盖值作基准 |

---

## 开发

```bash
cd app
npm start

# 调试用命令行开关
npx electron . --motion Gesture:2      # 播放指定动作
npx electron . --mpopen                # 直接打开动作面板
npx electron . --settings              # 直接打开设置面板
npx electron . --shot <out.png>        # 截图（注意：截图模式下 rAF 被节流，程序化动画不跑）
```

协议细节见 [`docs/PROTOCOL.md`](docs/PROTOCOL.md)。

---

## 发布（Release 资产说明）

```bash
node scripts/package-release.mjs
```

生成三个 release 资产：

| 文件 | 用途 |
|---|---|
| **`astrbot_plugin_deskpet-v<ver>.zip`** | **AstrBot 面板「上传安装」用**。zip 根部直接是 `main.py` / `metadata.yaml`（AstrBot 的 `install_plugin_from_file` 要求 `metadata.yaml` 在解压根目录） |
| **`astrbot-deskpet-plugin-folder-v<ver>.zip`** | **手动安装用**。解压后直接得到 `astrbot_plugin_deskpet/` 文件夹，拖进 `<AstrBot>/data/plugins/` 即可 |
| `astrbot-deskpet-app-source-v<ver>.zip` | Electron 桌宠 App 源码（不含 node_modules / models / 用户配置） |

> 插件包只有 ~12KB 是正常的：里面是纯 Python + 4 个配置文件（源码约 27KB 文本）。
> Electron 运行时（~270MB）和 Live2D 模型（授权限制）都不在其中，由用户自行安装/获取。

---

## 许可

- **代码**：MIT（见 `LICENSE`）
- **Live2D Cubism Core**：Live2D Proprietary Software License（见 `NOTICE.md`）
- **模型文件**：不含任何模型，版权归原作者，请自行获取授权

> 本项目的桌面形象渲染基于 [Live2D Cubism SDK](https://www.live2d.com/sdk/)。
> 使用本软件即表示你同意 Live2D 的相关许可条款。
