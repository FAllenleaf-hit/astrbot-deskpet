'use strict';
// 设置悬浮窗逻辑（通过 preload 暴露的 window.pet 与主进程通信）
const API = window.pet;
const $ = (x) => document.getElementById(x);
const log = (m) => API.log('[settings] ' + m);

// 面部表情（可叠加；参数级）
const FACE_LIST = ['爱心眼', '脸红', '流泪', '黑脸', '流冷汗', '圈圈眼', '屑屑眼', '＞＜'];
// 外貌开关（持久）
const LOOK_LIST = ['裙子切换', '胸口衣服', '脱鞋', '尾巴开关', '黑框眼镜', '单片眼镜', '钢盆', '兔牙', '前倾', '加载', '竖食指开'];
// 待机嘴型（单选）
const IDLE_MOUTH = [
  { v: 'auto', label: '自动（随机小动作）' },
  { v: 'smile', label: '微笑' },
  { v: 'smirk', label: '坏笑（单边）' },
  { v: 'pucker', label: '撅嘴' },
  { v: 'press', label: '抿嘴' },
  { v: 'open', label: '微张' },
  { v: 'tongue', label: '吐舌' },
  { v: 'off', label: '不动' },
];

// 体型（三选一）
const BODY_LIST = ['默认体型', '体型1', '体型2'];

// 情绪回应动作（与 renderer.js 的 applyBehavior 对应）
const EMOTION_ACTIONS = [
  { name: 'joy', label: '开心弹跳', emo: 'happy' },
  { name: 'droop', label: '垂头/靠肩', emo: 'sad / tired' },
  { name: 'angry', label: '生气转身甩手', emo: 'angry' },
  { name: 'curious', label: '好奇凑近', emo: 'surprised' },
  { name: 'shyBody', label: '害羞低头摇晃', emo: 'shy' },
  { name: 'ponder', label: '思考歪头比划', emo: 'thinking' },
  { name: 'ack', label: '轻点头', emo: 'neutral' },
  { name: 'nuzzle', label: '被摸头蹭手', emo: '（摸头时）' },
];

let cfg = null;
let faceLocal = {};
let lookLocal = {};
let models = [];
let currentId = null;

async function loadState() {
  cfg = await API.getConfig();
  models = await API.listModels();
  currentId = cfg.model;
  renderModels();
  renderMotions();
  renderFaceLook();
  renderEmotionActions();
  renderToggles();
}

function renderModels() {
  const box = $('models');
  box.innerHTML = '';
  if (!models.length) {
    box.innerHTML = '<div class="note">models 目录里没有模型</div>';
    return;
  }
  for (const m of models) {
    const row = document.createElement('div');
    row.className = 'm-item' + (m.id === currentId ? ' cur' : '');
    const name = document.createElement('span');
    name.textContent = m.name;
    row.appendChild(name);
    if (!m.ok) {
      const bad = document.createElement('span');
      bad.className = 'bad';
      bad.textContent = '读取失败';
      row.appendChild(bad);
    }
    row.addEventListener('click', async () => {
      if (!m.ok) return;
      currentId = m.id;
      await API.setConfig({ model: m.id });
      log('切换形象 -> ' + m.name);
      API.uiCommand('load-model:' + m.id);
      renderModels();
    });
    box.appendChild(row);
  }
}

function renderMotions() {
  const box = $('mlist');
  box.innerHTML = '';
  const cur = models.find((m) => m.id === currentId) || models[0];
  const list = (cur && cur.motions) || [];
  if (!list.length) {
    box.innerHTML = '<div class="note">这个模型没有独立动作文件（只有程序化动作）</div>';
    return;
  }
  for (const m of list) {
    const row = document.createElement('div');
    row.className = 'mv';
    row.innerHTML = '<span class="idx"></span><span class="nm"></span><span class="grp"></span>';
    row.querySelector('.idx').textContent = m.index;
    row.querySelector('.nm').textContent = m.name || ('动作 ' + m.index);
    row.querySelector('.grp').textContent = m.group;
    row.addEventListener('click', () => {
      API.uiCommand('play-motion:' + m.group + ':' + m.index);
      log('播放 ' + m.group + '#' + m.index);
    });
    box.appendChild(row);
  }
}

function renderFaceLook() {
  const ap = (cfg && cfg.appearance) || {};
  const face = ap.face || {};
  const look = ap.look || {};

  const fb = $('flist');
  fb.innerHTML = '';
  for (const name of FACE_LIST) {
    const lab = document.createElement('label');
    lab.className = 'chk';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!face[name];
    cb.addEventListener('change', () => {
      faceLocal[name] = cb.checked;
      API.uiCommand('param-override:' + JSON.stringify({ kind: 'face', name, on: cb.checked }));
    });
    lab.appendChild(cb);
    lab.appendChild(document.createTextNode(name));
    fb.appendChild(lab);
  }

  const lb = $('llist');
  lb.innerHTML = '';
  for (const name of LOOK_LIST) {
    const lab = document.createElement('label');
    lab.className = 'chk';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!look[name];
    cb.addEventListener('change', () => {
      lookLocal[name] = cb.checked;
      API.uiCommand('param-override:' + JSON.stringify({ kind: 'look', name, on: cb.checked }));
    });
    lab.appendChild(cb);
    lab.appendChild(document.createTextNode(name));
    lb.appendChild(lab);
  }

  const mb = $('mlist-idle');
  if (mb) {
    mb.innerHTML = '';
    const curMode = ((cfg && cfg.behavior) || {}).idleMouthMode || 'auto';
    for (const it of IDLE_MOUTH) {
      const lab = document.createElement('label');
      lab.className = 'chk';
      const cb = document.createElement('input');
      cb.type = 'radio';
      cb.name = 'idle-mouth';
      cb.checked = curMode === it.v;
      cb.addEventListener('change', () => patchBehavior('idleMouthMode', it.v));
      lab.appendChild(cb);
      lab.appendChild(document.createTextNode(it.label));
      mb.appendChild(lab);
    }
    const str = $('mouth-str');
    const strVal = $('mouth-str-val');
    if (str) {
      const v = ((cfg && cfg.behavior) || {}).idleMouthStrength || 0.7;
      str.value = String(v);
      if (strVal) strVal.textContent = Number(v).toFixed(2);
      str.addEventListener('input', () => { if (strVal) strVal.textContent = Number(str.value).toFixed(2); });
      str.addEventListener('change', () => patchBehavior('idleMouthStrength', Number(str.value)));
    }
  }

  const bb = $('blist');
  bb.innerHTML = '';
  for (const name of BODY_LIST) {
    const lab = document.createElement('label');
    lab.className = 'chk';
    const cb = document.createElement('input');
    cb.type = 'radio';
    cb.name = 'body-group';
    cb.checked = (ap.body || '默认体型') === name;
    cb.addEventListener('change', () => {
      API.uiCommand('param-override:' + JSON.stringify({ kind: 'body', name }));
    });
    lab.appendChild(cb);
    lab.appendChild(document.createTextNode(name));
    bb.appendChild(lab);
  }
}

function syncFaceUI() {
  const face = ((cfg && cfg.appearance) || {}).face || {};
  const boxes = $('flist').querySelectorAll('input');
  FACE_LIST.forEach((name, i) => { if (boxes[i]) boxes[i].checked = !!face[name]; });
}

function renderEmotionActions() {
  const box = $('alist');
  box.innerHTML = '';
  for (const a of EMOTION_ACTIONS) {
    const row = document.createElement('div');
    row.className = 'act-item';
    row.innerHTML = '<span class="nm"></span><span class="emo"></span>';
    row.querySelector('.nm').textContent = a.label;
    row.querySelector('.emo').textContent = a.emo;
    row.addEventListener('click', () => {
      API.uiCommand('emotion-action:' + a.name);
      log('预览情绪动作 ' + a.name);
    });
    box.appendChild(row);
  }
}

function renderToggles() {
  const b = cfg.behavior || {};
  const set = (id, v) => { const el = $(id); if (el) el.checked = !!v; };
  set('b-emotion', b.emotionAction !== false);
  set('b-nod', b.nodRhythm !== false);
  set('b-multi', b.multiAction !== false);
  set('b-night', b.nightSleepy !== false);
  set('b-yawn', b.yawns !== false);
  set('b-look', b.lookAround !== false);
  set('b-turn', b.turnBeforeSpeak !== false);
  set('b-greet', b.greetOnStart !== false);
  set('b-mouth', b.idleMouth !== false);
  set('chat-pinned', b.chatInputPinned !== false);
  set('top', cfg.alwaysOnTop);
  const sel = $('interaction');
  if (sel) sel.value = b.interactionChat || 'local';
}

async function patchBehavior(key, val) {
  const c = await API.getConfig();
  c.behavior = c.behavior || {};
  c.behavior[key] = val;
  await API.setConfig({ behavior: c.behavior });
  cfg.behavior = c.behavior;
  API.uiCommand('reload-behavior');
  log('behavior.' + key + ' = ' + val);
}

function bind() {
  $('close').addEventListener('click', () => API.closeSelf());
  $('rescan').addEventListener('click', async () => {
    models = await API.listModels();
    renderModels();
    renderMotions();
    log('已刷新（' + models.length + ' 个）');
  });
  $('open-models').addEventListener('click', () => API.openModelsDir());
  $('ov-reset').addEventListener('click', () => {
    API.uiCommand('param-override:' + JSON.stringify({ kind: 'reset' }));
    setTimeout(async () => { cfg = await API.getConfig(); renderFaceLook(); }, 200);
  });
  $('bigger').addEventListener('click', () => API.sizeStep(1.12));
  $('smaller').addEventListener('click', () => API.sizeStep(0.89));
  $('size-reset').addEventListener('click', () => API.sizeReset());
  $('collapse').addEventListener('click', () => API.collapse());
  $('top').addEventListener('change', (e) => API.setTop(e.target.checked));
  const amp = $('amp');
  const ampVal = $('amp-val');
  if (amp) {
    amp.value = String(((cfg && cfg.behavior) || {}).amplitude || 2.5);
    if (ampVal) ampVal.textContent = amp.value;
    amp.addEventListener('input', () => { if (ampVal) ampVal.textContent = amp.value; });
    amp.addEventListener('change', () => patchBehavior('amplitude', Number(amp.value)));
  }
  $('say').addEventListener('click', () => API.uiCommand('open-chat'));
  $('chat-pinned').addEventListener('change', (e) => patchBehavior('chatInputPinned', e.target.checked));
  $('interaction').addEventListener('change', (e) => patchBehavior('interactionChat', e.target.value));
  const map = {
    'b-emotion': 'emotionAction', 'b-nod': 'nodRhythm', 'b-multi': 'multiAction',
    'b-night': 'nightSleepy', 'b-yawn': 'yawns', 'b-look': 'lookAround',
    'b-turn': 'turnBeforeSpeak', 'b-greet': 'greetOnStart', 'b-mouth': 'idleMouth',
  };
  for (const [id, key] of Object.entries(map)) {
    $(id).addEventListener('change', (e) => patchBehavior(key, e.target.checked));
  }
  $('reconnect').addEventListener('click', () => { API.reconnectWs(); log('请求重连 AstrBot'); });
  $('open-config').addEventListener('click', () => API.openConfig());
  $('quit').addEventListener('click', () => API.quit());
  API.onWsStatus((s) => {
    const el = $('ws');
    if (el) el.textContent = 'AstrBot：' + (s && s.clients > 0 ? '已连接（' + s.clients + '）' : '未连接');
  });
  API.onTopState((on) => { const el = $('top'); if (el) el.checked = !!on; });
  API.onAppearanceState((ap) => {
    if (!ap) return;
    faceLocal = ap.face || {};
    lookLocal = ap.look || {};
    const boxes = $('flist').querySelectorAll('input');
    FACE_LIST.forEach((n, i) => { if (boxes[i]) boxes[i].checked = !!faceLocal[n]; });
    const lboxes = $('llist').querySelectorAll('input');
    LOOK_LIST.forEach((n, i) => { if (lboxes[i]) lboxes[i].checked = !!lookLocal[n]; });
    const rboxes = $('blist').querySelectorAll('input');
    BODY_LIST.forEach((n, i) => { if (rboxes[i]) rboxes[i].checked = (ap.body || '默认体型') === n; });
  });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') API.closeSelf(); });
}

bind();
loadState().catch((e) => log('初始化失败: ' + (e && e.message)));

// 开发自检：?probe=1 时自动点几个按钮
if (new URLSearchParams(location.search).get('probe') === '1') {
  setTimeout(() => {
    API.uiCommand('param-override:' + JSON.stringify({ kind: 'face', name: '爱心眼', on: true }));
    log('PROBE 开 爱心眼');
    setTimeout(() => {
      API.uiCommand('param-override:' + JSON.stringify({ kind: 'look', name: '脱鞋', on: true }));
      log('PROBE 开 脱鞋（应与爱心眼叠加）');
    }, 400);
    setTimeout(() => {
      API.uiCommand('param-override:' + JSON.stringify({ kind: 'face', name: '脸红', on: true }));
      log('PROBE 开 脸红（应三者共存）');
    }, 800);
    setTimeout(() => {
      API.uiCommand('param-override:' + JSON.stringify({ kind: 'face', name: '圈圈眼', on: true }));
      log('PROBE 开 圈圈眼（应自动关掉爱心眼）');
    }, 1200);
    setTimeout(() => { API.uiCommand('emotion-action:shyBody'); log('PROBE 请求情绪动作=shyBody'); }, 700);
    setTimeout(() => { API.uiCommand('reset-expressions'); log('PROBE 请求恢复默认表情'); }, 1400);
    setTimeout(() => { API.uiCommand('play-motion:Gesture:1'); log('PROBE 请求模型动作=Gesture#1'); }, 2000);
    setTimeout(() => { patchBehavior('idleMouthMode', 'tongue'); log('PROBE 切换嘴型=tongue'); }, 2600);
    setTimeout(() => { patchBehavior('idleMouthMode', 'smile'); log('PROBE 切换嘴型=smile'); }, 3400);
    setTimeout(() => { const el = $('elist'); if (el) el.scrollIntoView({ block: 'start' }); log('PROBE 已滚动到表情区'); }, 2400);
  }, 900);
}
