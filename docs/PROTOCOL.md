# 桌宠 ↔ AstrBot 通信协议 v1

- 传输：WebSocket，默认 `ws://127.0.0.1:8765/?token=<可选>`
- 角色：**桌宠是服务端**，AstrBot 适配器是客户端（断线由客户端重连）
- 格式：每条消息一个 JSON 对象；编码 UTF-8；图片/音频走 base64

## 握手

桌宠在连接建立后立刻发：

```json
{ "type": "hello", "protocol": 1, "app": "deskpet", "version": "1.0.0",
  "current": "MyPet/MyPet.model3.json",
  "models": [{ "id": "MyPet/MyPet.model3.json", "name": "MyPet", "type": "cubism4" }] }
```

适配器回：

```json
{ "type": "hello_ack", "protocol": 1, "umo": "deskpet:private:me", "persona": null }
```

## 桌宠 → AstrBot

```jsonc
// 用户打字
{ "type": "message", "id": "m123", "text": "你好", "ts": 1700000000000 }

// 互动（摸头/戳/拖拽）——会作为一条用户消息进入对话
{ "type": "interaction", "kind": "pat", "area": "HitAreaHead",
  "text": "（用户摸了摸你的头）" }

{ "type": "pong" }
```

## AstrBot → 桌宠

```jsonc
// 完整回复
{ "type": "reply", "id": "m123", "text": "你好呀",
  "emotion": "happy",              // 可选：切表情
  "emotionHoldMs": 6000,           // 可选：保持多久
  "segments": [{ "type": "plain", "text": "你好呀" }],
  "audio": { "base64": "…", "mime": "audio/mpeg" } }   // 或 { "path": "C:/x.mp3" }

// 流式（当前适配器未启用，接口预留）
{ "type": "stream", "id": "m123", "delta": "你", "done": false }

// 只换表情 / 只播语音 / 系统提示
{ "type": "emotion", "emotion": "shy", "holdMs": 3000 }
{ "type": "speak", "audio": { "base64": "…", "mime": "audio/mpeg" } }
{ "type": "notice", "text": "连接成功" }

{ "type": "ping" }
```

## 音频约定

适配器可以直接给 `path`（AstrBot 与桌宠同机时最省事），桌宠主进程会读文件转 base64；
跨机部署时适配器应自己 base64 化。

## 想写别的前端？

只要实现「WS 服务端 + hello/hello_ack + message/reply」这四件事，
就能复用整个 AstrBot 侧的人格、记忆、插件与工具。桌宠只是其中一个前端。
