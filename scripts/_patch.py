import io
p = 'plugin/main.py'
s = io.open(p, encoding='utf-8').read()
n = 0
def rep(old, new):
    global s, n
    assert old in s, '未匹配: ' + old[:70].replace(chr(10), ' ')
    s = s.replace(old, new, 1)
    n += 1

rep('''"""
AstrBot 平台适配器：Live2D 桌宠 (deskpet)

已按 AstrBot v4.26.1 的真实 API 核对：''',
'''"""
AstrBot 平台适配器：Live2D 桌宠 (deskpet)

把 Live2D 桌宠作为 AstrBot 的第二个对话入口：桌宠 App 与本适配器通过 WebSocket 通信，
消息进入 AstrBot 正常流水线，因此共享同一套 provider / persona / 插件 / 长期记忆。
配合 shared_umo 可以让桌宠与某个已有会话（如 QQ 私聊）共用同一条对话上下文。

AstrBot API 依据（v4.26.x）：''')

# 常量：情绪注入开关 -> 改为 mood TTL 默认值
rep('''INJECT_EMOTION_HINT = True
"""自动在每次 LLM 请求里追加"输出情绪标签"的指令，这样不用去改 persona"""''',
'''DEFAULT_MOOD_TTL_SEC = 7200
"""情绪有效期默认值（秒）。适配器会按平台配置的 mood_ttl_sec 覆盖"""''')

# 调试开关
rep('''DEBUG_LOG = True
"""把关键步骤写进 data/deskpet/debug.log，方便定位问题（排查完可以改成 False）"""


def _dbg(msg: str) -> None:
    if not DEBUG_LOG:
        return''',
'''DEBUG = False
"""由平台配置的 debug 项控制；开启后把关键步骤写入 <AstrBot data>/deskpet/debug.log"""


def set_debug(on: bool) -> None:
    global DEBUG
    DEBUG = bool(on)


def _dbg(msg: str) -> None:
    if not DEBUG:
        return''')

rep('MOOD_TTL_SEC = 7200\n"""情绪最多保留 2 小时，太久了就不算「延续」了"""',
    'MOOD_TTL_SEC = DEFAULT_MOOD_TTL_SEC\n"""情绪保留时长（适配器按配置覆盖）"""')

# 平台配置模板
rep('''    default_config_tmpl={
        "id": "deskpet",
        "host": "127.0.0.1",
        "port": 8765,
        "token": "",
        "shared_umo": "",
        "emotion_tag": True,
    },''',
'''    default_config_tmpl={
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
    },''')

# 适配器 init
rep('''        self.emotion_tag = bool(self.config.get("emotion_tag", True))
        self.ws = None
        self._stop = False''',
'''        self.emotion_tag = bool(self.config.get("emotion_tag", True))
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
        self._stop = False''')

# 发送者 id
rep('''        _uid = "me"
        if self.shared_umo:
            _part = self.shared_umo.split(":")[-1].strip()
            if _part:
                _uid = _part''',
'''        _uid = self.owner_id
        if not _uid and self.shared_umo:
            _part = self.shared_umo.split(":")[-1].strip()
            if _part:
                _uid = _part
        if not _uid:
            _uid = "me"''')

# admin 标记
rep('''        # 桌宠运行在主人自己电脑上：标记为管理员。
        # 这同时让它绕过「会话白名单」（wl_ignore_admin_on_friend=True 时管理员私聊豁免），
        # 也让管理员专属命令能在桌宠里用。
        try:
            event.role = "admin"
        except Exception:
            pass''',
'''        # 按配置决定是否标记管理员（见 __init__ 中 mark_admin 说明）
        if self.mark_admin:
            try:
                event.role = "admin"
            except Exception:
                pass''')

# Star 插件接收 config
rep('''class DeskpetPlugin(Star):
    def __init__(self, context: Context):
        super().__init__(context)''',
'''class DeskpetPlugin(Star):
    def __init__(self, context: Context, config: dict | None = None):
        super().__init__(context)
        self.config = config or {}

    def _cfg(self, key: str, default=None):
        try:
            v = self.config.get(key, default)
            return default if v is None else v
        except Exception:
            return default''')

# 情绪注入读配置
rep('''        _dbg("on_llm_request 触发（说明进到 LLM 阶段了）")
        if not INJECT_EMOTION_HINT:
            return''',
'''        _dbg("on_llm_request 触发（说明进到 LLM 阶段了）")
        if not self._cfg("inject_emotion_hint", True):
            return''')

# 标签剥离读配置
rep('                if m and STRIP_TAG_ON_OTHER_PLATFORMS and not is_deskpet:',
    '                if m and self._cfg("strip_tag_on_other_platforms", True) and not is_deskpet:')

# 状态命令文案
rep('''        yield event.plain_result(
            "桌宠适配器已加载。请在面板「消息平台」里新增 deskpet 平台，"
            "host/port 与桌宠 config.json 保持一致（默认 127.0.0.1:8765）。"
        )''',
'''        lines = [
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
        yield event.plain_result(chr(10).join(lines))''')

io.open(p, 'w', encoding='utf-8').write(s)
print('✅ 替换成功片段:', n)
