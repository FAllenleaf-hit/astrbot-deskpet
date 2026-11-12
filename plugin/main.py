"""
AstrBot 平台适配器：Live2D 桌宠 (deskpet)

把 Live2D 桌宠作为 AstrBot 的第二个对话入口：桌宠 App 与本适配器通过 WebSocket 通信，
消息进入 AstrBot 正常流水线，因此共享同一套 provider / persona / 插件 / 长期记忆。
配合 shared_umo 可以让桌宠与某个已有会话（如 QQ 私聊）共用同一条对话上下文。

AstrBot API 依据（v4.26.x）：
  Platform.__init__(config, event_queue)            # 只有 2 个参数
  manager 实例化: cls(platform_config, settings, event_queue)
  AstrMessageEvent.unified_msg_origin 是 property(setter 会解析成 MessageSession)
  回复走 event.send()，所以事件的 send() 才是决定"发到哪个前端"的地方

桌宠 App 是 WS 服务端（默认 127.0.0.1:8765），本适配器是 WS 客户端。
"""
from __future__ import annotations

import asyncio
import base64
import json
import os
import re
import uuid

try:
    import websockets
except ImportError:  # pragma: no cover
    websockets = None

from astrbot.api import logger
from astrbot.api.event import AstrMessageEvent, filter
from astrbot.api.message_components import Image, Plain, Record
from astrbot.api.platform import (
    AstrBotMessage,
    MessageMember,
    MessageType,
    Platform,
    PlatformMetadata,
    register_platform_adapter,
)
from astrbot.api.star import Context, Star, register
from astrbot.core.message.message_event_result import MessageChain

try:
    from astrbot.core.agent.message import TextPart
except Exception:  # 版本差异时的兜底
    TextPart = None

DEFAULT_MOOD_TTL_SEC = 7200
"""情绪有效期默认值（秒）。适配器会按平台配置的 mood_ttl_sec 覆盖"""

EMOTION_HINT = """附加输出约定（仅用于驱动桌面形象，不改变回复内容）：
正文照常写完之后，另起一行放一个情绪标记，形如 [happy]。
可用标记：happy / sad / angry / surprised / shy / thinking / tired / neutral；不确定就用 [neutral]。
不要在正文里讨论、比较或解释这个标记，也不要写出选择过程；这一行会被程序读取并删除，对方看不到。"""

# 兜底清洗：模型偶尔会把「选型过程」写进正文，例如
#   [hmm] — no, must pick from the eight. Use .然后正文重新开始
# 只处理「方括号英文语气词 + 紧随其后的纯英文碎片」这种明确形态，
# 不碰正常中文，也不碰 [Image] / [At: xx] 这类占位符。
_META_LEAK_RE = re.compile(
    r"\[(?:hmm+|um+|uh+|wait|okay|ok|oh)\]"
    r"[^\u4e00-\u9fff]{3,200}?"
    r"(?=[\u4e00-\u9fff]|$)",
    re.I,
)
_CJK_RE = re.compile(r"[\u4e00-\u9fff]")


def strip_meta_leak(text: str) -> str:
    """去掉模型泄漏进正文的英文选型草稿。

    这类泄漏的典型形态是「先写一版正文 → 冒出英文自我纠正 → 重新写一遍」。
    所以一旦命中，标记**之后**的内容才是真正的答复，优先保留尾部；
    若标记后没有实质内容（说明草稿在正文末尾），则只删掉草稿片段、保留前缀。
    """
    if not text or not isinstance(text, str):
        return text
    try:
        match = _META_LEAK_RE.search(text)
        if not match:
            return text
        tail = text[match.end():].strip()
        # 尾部有像样的中文答复 -> 用它（模型重启后的正式内容）
        if len(tail) >= 10 and _CJK_RE.search(tail):
            return tail
        # 否则只挖掉草稿本身，保留前后正文
        cleaned = (text[:match.start()] + text[match.end():]).strip()
        cleaned = re.sub(r"[ \t]{2,}", " ", cleaned)
        cleaned = re.sub(r"\n{3,}", "\n\n", cleaned).strip()
        return cleaned or text
    except Exception:
        return text

MOOD_TTL_SEC = DEFAULT_MOOD_TTL_SEC
"""情绪保留时长（适配器按配置覆盖）"""
STRIP_TAG_ON_OTHER_PLATFORMS = True
"""是否把 [happy] 这类情绪标签从 QQ 等平台的消息里去掉（只匹配这 8 个情绪词）"""


def _mood_file():
    from pathlib import Path

    try:
        from astrbot.core.utils.astrbot_path import get_astrbot_data_path

        base = Path(get_astrbot_data_path()) / "deskpet"
    except Exception:
        base = Path(__file__).resolve().parent / "data"
    base.mkdir(parents=True, exist_ok=True)
    return base / "mood.json"


MAX_IMAGE_BYTES = 4 * 1024 * 1024
"""单张图片上限；超过就不发给桌宠（避免 WS 帧过大）"""

DEBUG = False
"""由平台配置的 debug 项控制；开启后把关键步骤写入 <AstrBot data>/deskpet/debug.log"""


def set_debug(on: bool) -> None:
    global DEBUG
    DEBUG = bool(on)


def _dbg(msg: str) -> None:
    if not DEBUG:
        return
    try:
        import time

        with (_mood_file().parent / "debug.log").open("a", encoding="utf-8") as fh:
            fh.write("[" + time.strftime("%H:%M:%S") + "] " + str(msg) + chr(10))
    except Exception:
        pass


def save_mood(emotion: str) -> None:
    try:
        import time

        _mood_file().write_text(
            json.dumps({"emotion": emotion, "ts": time.time()}, ensure_ascii=False),
            encoding="utf-8",
        )
    except Exception as e:  # pragma: no cover
        logger.warning(f"[deskpet] 保存情绪失败: {e}")


def load_mood():
    """返回 (emotion, age_seconds)"""
    try:
        import time

        d = json.loads(_mood_file().read_text(encoding="utf-8"))
        emo = d.get("emotion")
        if not emo:
            return None
        return str(emo), max(0.0, time.time() - float(d.get("ts") or 0))
    except Exception:
        return None


EMOTION_KEYWORDS = [
    ("tired", ["困", "累", "睡", "疲惫", "哈欠", "没力气", "歇", "收工", "眯", "缓缓", "眼皮"]),
    ("happy", ["开心", "高兴", "笑", "哈哈", "好呀", "太好了", "喜欢", "棒"]),
    ("sad", ["难过", "伤心", "哭", "失落", "寂寞", "委屈", "抱歉", "难受", "心疼", "抱抱", "拍拍", "辛苦", "别怕", "陪你"]),
    ("angry", ["生气", "哼", "讨厌", "别烦", "过分", "气死"]),
    ("shy", ["害羞", "脸红", "别这样", "不好意思", "讨厌啦"]),
    ("surprised", ["咦", "诶", "真的吗", "居然", "竟然", "吓"]),
    ("thinking", ["让我想想", "思考", "大概", "也许", "嗯…"]),
]


def infer_emotion(text: str) -> str:
    """模型没给情绪标签时，用关键词兜底猜一个（保证桌宠总有表情可用）"""
    if not text:
        return "neutral"
    best, best_n = "neutral", 0
    for emo, words in EMOTION_KEYWORDS:
        n = sum(text.count(w) for w in words)
        if n > best_n:
            best, best_n = emo, n
    return best


EMOTION_RE = re.compile(
    r"[\[<（(](happy|joy|sad|angry|surprised|shy|thinking|tired|neutral)[\]>）)]",
    re.I,
)


# ---------------------------------------------------------------- 事件
class DeskpetMessageEvent(AstrMessageEvent):
    """把 unified_msg_origin 钉到「共享会话」，这是与 QQ 共用记忆的关键。"""

    def __init__(
        self,
        message_str: str,
        message_obj: AstrBotMessage,
        platform_meta: PlatformMetadata,
        session_id: str,
        adapter: "DeskpetAdapter",
        shared_umo: str = "",
    ) -> None:
        super().__init__(message_str, message_obj, platform_meta, session_id)
        self._adapter = adapter
        if shared_umo:
            # 基类 setter 会把它解析成 MessageSession：
            # 于是 conversation / persona / 会话变量 全部指向 QQ 那条会话
            self.unified_msg_origin = shared_umo

    async def send(self, message: MessageChain) -> None:
        await self._adapter.push_chain(message)
        await super().send(MessageChain([]))

    async def send_streaming(self, generator, use_fallback: bool = False) -> None:
        """边生成边推给桌宠，桌宠前端做打字机效果。"""
        acc = ""
        async for chain in generator:
            text = "".join(
                str(c.text) for c in getattr(chain, "chain", []) if isinstance(c, Plain)
            )
            if not text:
                continue
            acc += text
            await self._adapter.push({"type": "stream", "delta": text, "done": False})
        if acc:
            text, emotion = self._adapter.extract_emotion(acc)
            payload = {"type": "stream", "delta": "", "done": True}
            if emotion:
                payload["emotion"] = emotion
            await self._adapter.push(payload)
        self._has_send_oper = True


# ---------------------------------------------------------------- 适配器
@register_platform_adapter(
    "deskpet",
    "Live2D 桌宠",
    default_config_tmpl={
        "id": "deskpet",
        "host": "127.0.0.1",
        "port": 8765,
        "token": "",
        "shared_umo": "",
        "emotion_tag": True,
        "mark_admin": True,
        "owner_id": "",
        "mood_ttl_sec": 7200,
        "max_image_mb": 4,
        "debug": False,
    },
    adapter_display_name="Live2D 桌宠",
    support_streaming_message=True,
)
class DeskpetAdapter(Platform):
    def __init__(
        self,
        platform_config: dict,
        platform_settings: dict,
        event_queue: asyncio.Queue,
    ) -> None:
        super().__init__(platform_config, event_queue)
        self.settings = platform_settings
        self.host = self.config.get("host", "127.0.0.1")
        self.port = int(self.config.get("port", 8765) or 8765)
        self.token = self.config.get("token", "") or ""
        # 共享会话 umo：留空则桌宠使用自己的独立会话（deskpet:private:me）
        self.shared_umo = (self.config.get("shared_umo") or "").strip()
        self.emotion_tag = bool(self.config.get("emotion_tag", True))
        # 桌宠运行在用户自己的电脑上，默认按「管理员」处理：
        #   ① 绕过 AstrBot 会话白名单（需 wl_ignore_admin_on_friend / wl_ignore_admin_on_group 为 True）
        #   ② 管理员专属命令可在桌宠里使用
        self.mark_admin = bool(self.config.get("mark_admin", True))
        # 发送者 ID：留空则取 shared_umo 末尾那段（通常是 QQ 号），再兜底 "me"
        self.owner_id = str(self.config.get("owner_id") or "").strip()
        try:
            self.mood_ttl_sec = int(self.config.get("mood_ttl_sec") or DEFAULT_MOOD_TTL_SEC)
        except Exception:
            self.mood_ttl_sec = DEFAULT_MOOD_TTL_SEC
        try:
            mb = float(self.config.get("max_image_mb") or 4)
        except Exception:
            mb = 4.0
        global MAX_IMAGE_BYTES, MOOD_TTL_SEC
        MAX_IMAGE_BYTES = int(mb * 1024 * 1024)
        MOOD_TTL_SEC = self.mood_ttl_sec
        set_debug(bool(self.config.get("debug", False)))
        self.ws = None
        self._stop = False

    # ------------------------------------------------------------ 元数据
    def meta(self) -> PlatformMetadata:
        return PlatformMetadata(
            name="deskpet",
            description="Live2D 桌宠",
            id=self.config.get("id") or "deskpet",
            support_streaming_message=True,
            support_proactive_message=True,
        )

    @property
    def _url(self) -> str:
        base = f"ws://{self.host}:{self.port}/"
        return base + (f"?token={self.token}" if self.token else "")

    # ------------------------------------------------------------ 生命周期
    async def run(self) -> None:
        if websockets is None:
            logger.error("[deskpet] 缺少依赖 websockets，请先安装")
            return
        while not self._stop:
            try:
                async with websockets.connect(self._url, max_size=16 * 1024 * 1024) as ws:
                    self.ws = ws
                    logger.info(f"[deskpet] 已连接桌宠 {self._url}")
                    await ws.send(
                        json.dumps(
                            {
                                "type": "hello_ack",
                                "protocol": 1,
                                "umo": self.shared_umo
                                or f"{self.meta().id}:private:me",
                                "persona": None,
                            }
                        )
                    )
                    mood = load_mood()
                    if mood and mood[1] < MOOD_TTL_SEC:
                        try:
                            await ws.send(
                                json.dumps(
                                    {
                                        "type": "mood",
                                        "emotion": mood[0],
                                        "ageS": round(mood[1]),
                                    }
                                )
                            )
                            logger.info(
                                f"[deskpet] 续上上次情绪 {mood[0]}（{round(mood[1])} 秒前）"
                            )
                        except Exception:
                            pass
                    async for raw in ws:
                        try:
                            await self._on_raw(raw)
                        except Exception as e:  # pragma: no cover
                            logger.error(f"[deskpet] 处理消息出错: {e}")
            except asyncio.CancelledError:
                raise
            except Exception as e:
                if not self._stop:
                    logger.warning(f"[deskpet] 连接异常({e})，3 秒后重连")
                    await asyncio.sleep(3)
            finally:
                self.ws = None

    async def terminate(self) -> None:
        self._stop = True
        if self.ws is not None:
            try:
                await self.ws.close()
            except Exception:
                pass

    # ------------------------------------------------------------ 收
    async def _on_raw(self, raw) -> None:
        try:
            data = json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            return
        t = data.get("type")
        _dbg("收到 WS 消息 type=" + str(t) + " text=" + str(data.get("text"))[:40])
        if t == "ping":
            await self.push({"type": "pong"})
            return
        if t == "message":
            await self._emit(data.get("text", ""), data.get("id"), data, False)
            return
        if t == "interaction":
            # 摸头/戳/拖拽：作为一条普通用户消息进对话，让 AI 真的「记得」被摸过
            await self._emit(data.get("text") or "(互动)", data.get("id"), data, True)

    async def _emit(self, text: str, msg_id, data: dict, is_interaction: bool) -> None:
        text = (text or "").strip()
        if not text:
            return
        abm = AstrBotMessage()
        abm.type = MessageType.FRIEND_MESSAGE
        abm.self_id = self.meta().id
        abm.session_id = "me"
        abm.message_id = str(msg_id or uuid.uuid4())
        # 用共享 umo 末尾那段（QQ 号）作为发送者 id，这样人格/记忆里是同一个"人"
        _uid = self.owner_id
        if not _uid and self.shared_umo:
            _part = self.shared_umo.split(":")[-1].strip()
            if _part:
                _uid = _part
        if not _uid:
            _uid = "me"
        abm.sender = MessageMember(
            user_id=_uid, nickname=data.get("nickname") or "主人"
        )
        abm.message = [Plain(text=text)]
        abm.message_str = text
        abm.raw_message = data

        event = DeskpetMessageEvent(
            text,
            abm,
            self.meta(),
            abm.session_id,
            adapter=self,
            shared_umo=self.shared_umo,
        )
        try:
            event.set_extra(
                "deskpet",
                {"interaction": is_interaction, "area": data.get("area")},
            )
        except Exception:
            pass
        # 按配置决定是否标记管理员（见 __init__ 中 mark_admin 说明）
        if self.mark_admin:
            try:
                event.role = "admin"
            except Exception:
                pass
        _dbg("提交事件 umo=" + str(getattr(event, "unified_msg_origin", "?")) + " text=" + text[:40])
        self.commit_event(event)

    # ------------------------------------------------------------ 发
    async def send_by_session(self, session, message_chain: MessageChain) -> None:
        """插件主动推送 / 定时任务走到这里。"""
        await self.push_chain(message_chain)
        await super().send_by_session(session, message_chain)

    async def push_chain(self, message_chain: MessageChain) -> None:
        _dbg("push_chain 被调用（说明流水线走到发送了）")
        parts: list[str] = []
        segments: list[dict] = []
        images: list[dict] = []
        audio = None
        for comp in getattr(message_chain, "chain", []) or []:
            if isinstance(comp, Plain):
                parts.append(str(comp.text))
                segments.append({"type": "plain", "text": str(comp.text)})
            elif isinstance(comp, Image):
                # 图片单独走 images 字段（桌宠会真的把它显示出来），不再塞 "[图片]" 占位
                img = await self._image_payload(comp)
                if img:
                    images.append(img)
                    segments.append({"type": "image"})
            elif isinstance(comp, Record):
                audio = self._audio_payload(comp)
                segments.append({"type": "record"})
            else:
                text = getattr(comp, "text", None)
                if text:
                    parts.append(str(text))
                    segments.append(
                        {"type": type(comp).__name__, "text": str(text)}
                    )

        text = "".join(parts).strip()
        emotion = None
        if self.emotion_tag:
            text, emotion = self.extract_emotion(text)
            if not emotion:
                emotion = infer_emotion(text)  # 模型没给标签就按内容猜
        payload = {
            "type": "reply",
            "id": str(uuid.uuid4()),
            "text": text,
            "segments": segments,
            "audio": audio,
        }
        if images:
            payload["images"] = images
        if emotion:
            payload["emotion"] = emotion
            save_mood(emotion)
        await self.push(payload)

    async def _image_payload(self, comp) -> dict | None:
        """把 Image 组件变成桌宠能显示的数据（data URL 或 http URL）"""
        try:
            import base64
            import os

            path = ""
            try:
                path = await comp.convert_to_file_path()  # 网络图会先下载
            except Exception:
                path = getattr(comp, "path", "") or ""
            if path and os.path.isfile(path):
                size = os.path.getsize(path)
                if size <= MAX_IMAGE_BYTES:
                    ext = (os.path.splitext(path)[1] or ".png").lower().lstrip(".")
                    mime = "image/jpeg" if ext in ("jpg", "jpeg") else "image/" + ext
                    with open(path, "rb") as fh:
                        raw = fh.read()
                    _dbg("图片已转 dataURL: " + mime + " " + str(size) + " 字节")
                    return {"data": "data:" + mime + ";base64," + base64.b64encode(raw).decode()}
                _dbg("图片过大，跳过: " + str(size) + " 字节")
                return None
            url = getattr(comp, "url", "") or getattr(comp, "file", "") or ""
            if isinstance(url, str) and url.startswith(("http://", "https://")):
                _dbg("图片用远程 URL: " + url[:80])
                return {"url": url}
        except Exception as e:
            _dbg("图片处理失败: " + repr(e)[:120])
        return None

    def extract_emotion(self, text: str):
        text = text or ""
        m = EMOTION_RE.search(text)
        if not m:
            return text, None
        return EMOTION_RE.sub("", text).strip(), m.group(1).lower()

    def _audio_payload(self, comp) -> dict | None:
        for attr in ("file", "path", "url"):
            v = getattr(comp, attr, None)
            if not v:
                continue
            p = str(v)
            if p.startswith("http://") or p.startswith("https://"):
                return {"url": p}
            if p.startswith("file://"):
                p = p[7:]
            if os.path.isfile(p):
                try:
                    with open(p, "rb") as f:
                        return {
                            "base64": base64.b64encode(f.read()).decode("ascii"),
                            "mime": self._mime(p),
                        }
                except OSError:
                    return None
            return {"path": p}
        return None

    @staticmethod
    def _mime(p: str) -> str:
        return {
            ".mp3": "audio/mpeg",
            ".wav": "audio/wav",
            ".ogg": "audio/ogg",
            ".m4a": "audio/mp4",
            ".aac": "audio/mp4",
            ".flac": "audio/flac",
        }.get(os.path.splitext(p)[1].lower(), "audio/mpeg")

    async def push(self, obj: dict) -> None:
        _dbg("push type=" + str(obj.get("type")) + " ws=" + ("已连接" if self.ws is not None else "未连接"))
        if self.ws is None:
            return
        try:
            await self.ws.send(json.dumps(obj, ensure_ascii=False))
        except Exception as e:
            logger.warning(f"[deskpet] 发送失败: {e}")


# ---------------------------------------------------------------- 插件壳
@register(
    "astrbot_plugin_deskpet",
    "deskpet",
    "Live2D 桌宠平台适配器",
    "1.0.0",
    "",
)
class DeskpetPlugin(Star):
    def __init__(self, context: Context, config: dict | None = None):
        super().__init__(context)
        self.config = config or {}

    def _cfg(self, key: str, default=None):
        try:
            v = self.config.get(key, default)
            return default if v is None else v
        except Exception:
            return default

    @filter.on_llm_request()
    async def _inject_emotion_hint(self, event: AstrMessageEvent, req) -> None:
        """让模型在回复末尾带上情绪标签，供桌宠表情与「情绪延续」使用。

        注入位置很关键：放在「用户消息末尾的额外块」时，模型会把它当成
        当前必须完成的格式任务，偶尔把选型过程写成英文草稿泄漏进正文。
        改放 system_prompt 作为常驻输出约定，正文泄漏明显减少。
        """
        _dbg("on_llm_request 触发（说明进到 LLM 阶段了）")
        if not self._cfg("inject_emotion_hint", True):
            return
        try:
            cur = getattr(req, "system_prompt", "") or ""
            if "[happy]" in cur and "[neutral]" in cur:
                return
            _nl = chr(10)
            req.system_prompt = (cur + _nl + _nl + EMOTION_HINT) if cur else EMOTION_HINT
            _dbg("情绪指令已注入(system_prompt)")
        except Exception as e:
            _dbg("情绪指令注入失败: " + repr(e)[:120])

    @filter.on_decorating_result()
    async def _capture_mood(self, event: AstrMessageEvent):
        """从任意平台的回复里抓情绪标签；顺带清掉泄漏的选型草稿。"""
        try:
            result = event.get_result()
            chain = getattr(result, "chain", None) if result else None
            if not chain:
                return
            text = "".join(str(getattr(c, "text", "") or "") for c in chain)
            if not text:
                return
            try:
                is_deskpet = event.get_platform_name() == "deskpet"
            except Exception:
                is_deskpet = False

            m = EMOTION_RE.search(text or "")
            if m:
                save_mood(m.group(1).lower())
            elif not is_deskpet:
                # 模型漏写标签时，用关键词兜底，保证桌宠仍能「情绪延续」
                try:
                    save_mood(infer_emotion(text))
                except Exception:
                    pass

            for comp in chain:
                if not isinstance(comp, Plain) or not getattr(comp, "text", None):
                    continue
                new_text = comp.text
                if m and self._cfg("strip_tag_on_other_platforms", STRIP_TAG_ON_OTHER_PLATFORMS) and not is_deskpet:
                    new_text = EMOTION_RE.sub("", new_text)
                # 清掉 [hmm] — no, must pick from the eight. Use . 这类草稿
                new_text = strip_meta_leak(new_text)
                if new_text != comp.text:
                    comp.text = new_text.strip() or comp.text.strip()
        except Exception:
            pass

    @filter.command("deskpet")
    async def deskpet_status(self, event: AstrMessageEvent):
        """查看桌宠状态"""
        lines = [
            "Live2D 桌宠适配器已加载 ✅",
            "",
            "配置步骤：",
            "1) 面板 →「消息平台」→ 新增 → 选择「Live2D 桌宠」",
            "2) host / port 与桌宠 App 的 config.json 保持一致（默认 127.0.0.1:8765）",
            "3) 想与某个已有会话共用记忆：把 shared_umo 填成那条会话的 umo",
            "   例：QQ 私聊 default:FriendMessage:<你的QQ号>；留空则桌宠用独立会话",
            "",
            "桌宠连上后，界面左下角会显示「AstrBot：已连接」。",
        ]
        yield event.plain_result(chr(10).join(lines))
