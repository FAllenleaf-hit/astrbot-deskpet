# Live2D 桌宠 · AstrBot 插件

把 Live2D 桌宠作为 AstrBot 的**第二个对话入口**。

桌宠 App 通过本地 WebSocket 连到这里，消息进入 AstrBot 正常流水线，
因此自动共享 provider / 人格 / 插件 / 长期记忆。

## 安装

1. 把本文件夹放到 `<AstrBot>/data/plugins/astrbot_plugin_deskpet/`
2. 重启 AstrBot（或面板重载插件）
3. 面板 →「消息平台」→ 新增 → 选择 **Live2D 桌宠**
4. `host`/`port` 与桌宠 `config.json` 里的 `ws` 保持一致（默认 `127.0.0.1:8765`）

## 主要配置

| 项 | 说明 |
|---|---|
| `host` / `port` | 桌宠监听地址 |
| `shared_umo` | 想共用记忆的会话，如 `default:FriendMessage:123456789`；留空则用独立会话 |
| `mark_admin` | 桌宠消息是否视为管理员（默认 `true`） |
| `emotion_tag` | 解析回复里的 `[happy]` 等标签驱动表情 |
| `debug` | 开启后写 `data/deskpet/debug.log` 方便排查 |

完整说明见 [项目 README](https://github.com/USER/astrbot-deskpet)。

## 依赖

`websockets>=11`（多数 AstrBot 环境已自带）

## 许可

MIT。桌宠 App 与 Live2D 相关许可见项目根目录 `NOTICE.md`。
