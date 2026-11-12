'use strict';
// 设置悬浮窗逻辑（通过 preload 暴露的 window.pet 与主进程通信）
const API = window.pet;
const $ = (x) => document.getElementById(x);
const log = (m) => API.log('[settings] ' + m);

// 表情/外貌清单：**从当前模型动态生成**（不再写死任何表情名）
//   faceList / lookList / bodyList 由 renderFaceLook() 依据模型信息填充
let faceList = [];
let lookList = [];
let bodyList = [];

/** 依据模型 expressionDetails 分类填充三个清单 */
function buildExprLists() {
  faceList = [];
  lookList = [];
  bodyList = [];
  const cur = models.find((m) => m.id === currentId) || models[0];
  const details = (cur && cur.expressionDetails) || [];
  for (const d of details) {
    const ids = Object.keys((d && d.params) || {});
    if (!ids.length) continue;
    const allAppearance = ids.every((id) => /^(Clothes|Movement|Divider|Lean|Body)/i.test(id));
    // 体型类：参数名里带 Body/Clothes 且值不是 0/1 的，归为「体型」
    const isBody = ids.some((id) => /^Clothes\d+$/i.test(id)) &&
      ids.some((id) => {
        const v = Number(((d.params || {})[id]));
        return v !== 0 && v !== 1 && v !== -1;
      });
    if (isBody) bodyList.push(d.name);
    else if (allAppearance) lookList.push(d.name);
    else faceList.push(d.name);
  }
}

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
  buildExprLists();
  const ap = (cfg && cfg.appearance) || {};
  const face = ap.face || {};
  const look = ap.look || {};

  const fb = $('flist');
  fb.innerHTML = '';
  for (const name of faceList) {
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
  for (const name of lookList) {
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
  for (const name of bodyList) {
    const lab = document.createElement('label');
    lab.className = 'chk';
    const cb = document.createElement('input');
    cb.type = 'radio';
    cb.name = 'body-group';
    cb.checked = (ap.body || bodyList[0]) === name;
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
  faceList.forEach((name, i) => { if (boxes[i]) boxes[i].checked = !!face[name]; });
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
    faceList.forEach((n, i) => { if (boxes[i]) boxes[i].checked = !!faceLocal[n]; });
    const lboxes = $('llist').querySelectorAll('input');
    lookList.forEach((n, i) => { if (lboxes[i]) lboxes[i].checked = !!lookLocal[n]; });
    const rboxes = $('blist').querySelectorAll('input');
    bodyList.forEach((n, i) => { if (rboxes[i]) rboxes[i].checked = (ap.body || bodyList[0]) === n; });
  });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') API.closeSelf(); });
}

bind();
loadState().catch((e) => log('初始化失败: ' + (e && e.message)));

// 开发自检：?probe=1 时自动点几个按钮
