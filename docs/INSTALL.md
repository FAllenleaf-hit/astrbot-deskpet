# 详细安装指南

## 前置条件

| 项 | 要求 |
|---|---|
| AstrBot | **v4.x**（含 v4.26.1 验证） |
| Node.js | ≥ 18（推荐 20 LTS） |
| Python | AstrBot 自带环境即可 |
| 操作系统 | Windows 10/11（主要测试平台）；macOS / Linux 理论可用但未充分测试 |

---

## 一、安装桌宠 App

```bash
git clone https://github.com/USER/astrbot-deskpet.git
cd astrbot-deskpet/desktop-app
npm install
```

`npm install` 会下载 Electron（约 100MB），耐心等待。

### 放入模型

见 [`../models/README.md`](../models/README.md)。最少需要一个是 `.model3.json` 的模型。

### 启动

```bash
npm start
```

Windows 也可以双击 `desktop-app/start.bat`，或自己创建桌面快捷方式指向：

```
<项目路径>/node_modules/electron/dist/electron.exe "<项目路径>/app"
```

首次启动会以「本地模式」运行（不连 AstrBot），可以先用设置面板预览动作和表情。

---

## 二、安装 AstrBot 插件

### 方式 A：手动复制（推荐）

把 `plugin/` 目录复制到：

```
<AstrBot 安装目录>/data/plugins/astrbot_plugin_deskpet/
```

最终应该是：

```
<AstrBot>/data/plugins/astrbot_plugin_deskpet/main.py
<AstrBot>/data/plugins/astrbot_plugin_deskpet/metadata.yaml
<AstrBot>/data/plugins/astrbot_plugin_deskpet/_conf_schema.json
<AstrBot>/data/plugins/astrbot_plugin_deskpet/requirements.txt
```

然后**重启 AstrBot**（或面板 →「插件」→ 重载）。

### 方式 B：面板上传 zip

把 `release/astrbot-deskpet-plugin-vX.Y.Z.zip` 在 AstrBot 面板
「插件」→「安装」里上传即可（zip 内必须直接是 `main.py` 等文件，不含外层多级目录）。

### 依赖

插件依赖 `websockets`。多数 AstrBot 环境已自带；若报缺少：

```bash
<AstrBot python> -m pip install websockets
```

---

## 三、挂载平台

1. 打开 AstrBot 面板 →「消息平台」→「新增」
2. 类型选 **Live2D 桌宠**
3. 填写：

| 字段 | 值 |
|---|---|
| id | `deskpet`（默认） |
| host | `127.0.0.1` |
| port | `8765`（与桌宠 `config.json` 的 `ws.port` 一致） |
| token | 留空（除非桌宠配置里设了） |
| **shared_umo** | 想共用记忆的会话，见下 |
| mark_admin | `true`（默认） |

4. 启用并保存

### 填写 `shared_umo`

umo 的格式是 `<平台ID>:<消息类型>:<会话ID>`：

```
QQ 私聊：   default:FriendMessage:123456789
QQ 群聊：   default:GroupMessage:987654321
```

- 平台 ID 在面板「消息平台」列表里能看到，默认一般就是 `default`
- 想先跑通、不折腾记忆共享 → **留空**

### 验证

1. 桌宠窗口左下角显示 **「AstrBot：已连接」**（绿点）
2. 在桌宠里打字，应该收到回复
3. 在任意平台发 `/deskpet` 会返回当前配置提示

---

## 四、常见问题定位

### 桌宠连不上

- AstrBot 是否在运行？
- 面板里 deskpet 平台是否已启用？
- 端口被占用？改桌宠 `config.json` 的 `ws.port` 并同步插件配置

### 连上了但没回复

按顺序排查：

1. **会话白名单**（最常见）：面板 →「配置」→ `platform_settings`
   - `enable_id_white_list` 为 `true` 时，桌宠的 umo 必须在 `id_whitelist` 里
   - 或者把 `wl_ignore_admin_on_friend` 设为 `true`（插件默认 `mark_admin=true` 就会走豁免）
2. **插件没触发**：插件配置里 `debug` 设为 `true`，看 `<AstrBot>/data/deskpet/debug.log`
   - 有 `收到 WS 消息` → 有 `提交事件` → 有 `on_llm_request` → 有 `push_chain`？
   - 卡在哪一步就能定位
3. **LLM 报错**：看 AstrBot 日志里的 provider 报错

### 想确认桌宠端是否真的收到回复

桌宠的 stderr 会打印 `收到 reply（N 字, emotion=xxx）: ...`。

---

## 五、卸载

1. AstrBot 面板删除 deskpet 平台
2. 删除 `data/plugins/astrbot_plugin_deskpet/`
3. 删除桌宠 App 目录（`config.json` 是你的配置，想留着就单独备份）
