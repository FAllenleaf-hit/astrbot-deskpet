'use strict';
/**
 * AstrBot Live2D 桌宠 —— 主进程
 * 1) 透明/无边框/置顶窗口  2) 扫描 models/ 目录  3) deskpet:// 自定义协议
 * 4) 内置 WebSocket 服务端（AstrBot 的 deskpet 平台适配器连进来）
 * 5) 配置持久化 / 托盘菜单 / 点击穿透
 */
const {
  app, BrowserWindow, ipcMain, Tray, Menu, nativeImage,
  protocol, net, screen, shell,
} = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { WebSocketServer } = require('ws');

const ROOT = path.resolve(__dirname, '..');
const MODELS_DIR = path.join(ROOT, 'models');
const RENDERER_DIR = path.join(__dirname, 'renderer');
const CONFIG_PATH = path.join(ROOT, 'config.json');
const SHOT_DIR = path.join(ROOT, 'shots');

const argv = process.argv.slice(1);
const IS_SHOT = argv.includes('--screenshot');
const IS_DEMO = argv.includes('--demo');
const FORCE_MODEL = (() => { const i = argv.indexOf('--model'); return i >= 0 ? argv[i + 1] : null; })();
const SHOT_ALPHA = argv.includes('--transparent');
const SHOT_BG = (() => { const i = argv.indexOf('--bg'); return i >= 0 ? argv[i + 1] : null; })();
const SHOT_DELAY = (() => { const i = argv.indexOf('--shot-delay'); return i >= 0 ? Number(argv[i + 1]) || 2600 : 2600; })();
const SHOT_PATH = (() => {
  const i = argv.indexOf('--screenshot');
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
})();

const FORCE_GPU = process.env.DESKPET_GPU === '1';
if (!FORCE_GPU && (process.env.DESKPET_SOFTWARE_GL === '1' || IS_SHOT)) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('use-angle', 'swiftshader');
  app.commandLine.appendSwitch('enable-unsafe-swiftshader');
}

// 桌宠需要持续动画：关掉 Chromium 对遮挡/后台窗口的节流
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

const log = (...a) => console.log('[deskpet]', ...a);

const DEFAULT_CONFIG = {
  model: '',
  scale: 1.0,
  fill: 0.9,
  renderScale: 1.5,
  clippingMaskSize: 2048,
  autoHideBlendColor: false,
  glMipmapPatch: false,
  alwaysOnTop: true,
  showInTaskbar: true,
  clickThrough: true,
  window: { width: 380, height: 680, x: null, y: null },
  ws: { enabled: true, host: '127.0.0.1', port: 8765, token: '' },
  bubble: { ttlMs: 15000, width: 320 },
  idle: { minSec: 18, maxSec: 45, enabled: true },
  behavior: { enabled: true, nightSleepy: true, yawns: true, lookAround: true, turnBeforeSpeak: true, greetOnStart: true, interactionChat: "local", chatInputPinned: true, emotionAction: true, amplitude: 2.5, idleMouth: true, idleMouthMode: "auto", idleMouthStrength: 0.7, nodRhythm: true, multiAction: true },
  proceduralIdle: { enabled: true, breath: true, headSway: true, bodySway: true, intensity: 1.0 },
  emotionExpressions: {},
  petName: '桌宠',
};

function deepMerge(base, patch) {
  if (patch === null || patch === undefined) return base;
  if (Array.isArray(base) || typeof base !== 'object') return patch;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])
      ? deepMerge(base[k], v) : v;
  }
  return out;
}

let config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
try {
  if (fs.existsSync(CONFIG_PATH)) config = deepMerge(config, JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')));
} catch (e) { log('config.json 解析失败，使用默认配置：', e.message); }

let saveTimer = null;
function saveConfig() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8'); }
    catch (e) { log('保存配置失败：', e.message); }
  }, 200);
}

const BS = String.fromCharCode(92);
const normPath = (x) => String(x).split(BS).join('/');

// ---------------------------------------------------------------- 模型扫描
function readModel3(file) {
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  const refs = j.FileReferences || {};
  const textures = (refs.Textures || []).map(normPath);
  const lip = (j.Groups || []).find((g) => g.Name === 'LipSync');
  return {
    type: 'cubism4',
    texture: textures[0] || null,
    textures,
    expressions: (refs.Expressions || []).map((e) => e.Name),
    motionGroups: Object.keys(refs.Motions || {}),
    motions: Object.entries(refs.Motions || {}).flatMap(([g, arr]) =>
      (arr || []).map((m, i) => ({
        group: g,
        index: i,
        name: String((m && m.File) || '').split('/').pop().replace(/\.motion3\.json$/i, '').replace(/\.json$/i, ''),
      }))),
    hitAreas: (j.HitAreas || []).map((h) => h.Id),
    lipSyncParam: lip && lip.Ids && lip.Ids.length ? lip.Ids[0] : null,
  };
}

function readModel2(file) {
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  const textures = (j.textures || []).map(normPath);
  return {
    type: 'cubism2',
    texture: textures[0] || null,
    textures,
    expressions: (j.expressions || []).map((e, i) => e.name || ('exp_' + i)),
    motionGroups: Object.keys(j.motions || {}),
    hitAreas: (j.hit_areas || []).map((h) => h.name),
    lipSyncParam: 'ParamMouthOpenY',
  };
}

function walk(dir, depth, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (depth > 0 && !e.name.startsWith('.')) walk(full, depth - 1, out); }
    else if (/\.model3?\.json$/i.test(e.name)) out.push(full);
  }
}

function scanModels() {
  const files = [];
  walk(MODELS_DIR, 3, files);
  const models = [];
  for (const file of files) {
    const dir = path.dirname(file);
    const rel = path.relative(MODELS_DIR, file).split(path.sep).join('/');
    try {
      const info = /\.model3\.json$/i.test(file) ? readModel3(file) : readModel2(file);
      const name = path.basename(file).replace(/\.model3?\.json$/i, '');
      const thumbRel = info.texture || '';
      const hasThumb = thumbRel && fs.existsSync(path.join(dir, thumbRel));
      const dirRel = path.relative(MODELS_DIR, dir).split(path.sep).join('/');
      models.push({
        id: rel, name, type: info.type, file: rel,
        thumbnail: hasThumb ? (dirRel ? dirRel + '/' + thumbRel : thumbRel) : null,
        expressions: info.expressions,
        motionGroups: info.motionGroups,
        motions: info.motions || [],
        hitAreas: info.hitAreas,
        lipSyncParam: info.lipSyncParam,
        ok: true,
      });
    } catch (e) {
      models.push({ id: rel, name: path.basename(file), type: 'unknown', file: rel, ok: false, error: e.message });
    }
  }
  models.sort((a, b) => a.name.localeCompare(b.name));
  return models;
}

// ---------------------------------------------------------------- WebSocket 服务端
const WS = { server: null, clients: new Set(), status: { listening: false, port: null, clients: 0, error: null } };

function wsBroadcast(obj) {
  const raw = JSON.stringify(obj);
  for (const c of WS.clients) {
    if (c.readyState === 1) { try { c.send(raw); } catch { /* ignore */ } }
  }
}

function pushWsStatus(extra) {
  WS.status.clients = WS.clients.size;
  if (extra) Object.assign(WS.status, extra);
  if (win && !win.isDestroyed()) win.webContents.send('ws:status', WS.status);
  if (tray) refreshTrayMenu();
}

function stopWsServer() {
  if (WS.server) {
    try { WS.server.close(); } catch { /* ignore */ }
    for (const c of WS.clients) { try { c.terminate(); } catch { /* ignore */ } }
    WS.clients.clear();
    WS.server = null;
  }
}

function startWsServer() {
  if (!config.ws || !config.ws.enabled) { pushWsStatus({ listening: false, error: 'disabled' }); return; }
  stopWsServer();
  const port = Number(config.ws.port) || 8765;
  const host = config.ws.host || '127.0.0.1';
  let server;
  try { server = new WebSocketServer({ host, port }); }
  catch (e) { log('WS 启动失败：' + e.message); pushWsStatus({ listening: false, error: e.message }); return; }
  WS.server = server;
  server.on('listening', () => {
    log('WS 服务端已启动 ws://' + host + ':' + port);
    pushWsStatus({ listening: true, port, error: null });
  });
  server.on('error', (e) => {
    log('WS 错误：' + e.message);
    pushWsStatus({ listening: false, error: e.message });
  });
  server.on('connection', (socket, req) => {
    // 注意：客户端可能发来 "//" 这种路径，new URL 会抛 Invalid URL，
    // 这里必须兜住，否则未捕获异常会直接崩掉主进程。
    let token = '';
    try {
      const rawUrl = typeof req.url === 'string' && req.url.length ? req.url : '/';
      const u = new URL(rawUrl.startsWith('/') ? 'http://127.0.0.1' + rawUrl : rawUrl);
      token = u.searchParams.get('token') || '';
    } catch (e) {
      log('WS 握手 URL 解析失败（已忽略）：' + req.url);
      token = '';
    }
    if (config.ws.token && token !== config.ws.token) {
      log('WS 连接被拒绝：token 不匹配');
      try { socket.close(4001, 'bad token'); } catch { /* ignore */ }
      return;
    }
    try {
    WS.clients.add(socket);
    log('AstrBot 适配器已连接');
    try {
      socket.send(JSON.stringify({
        type: 'hello', protocol: 1, app: 'deskpet', version: app.getVersion(),
        current: currentModelId,
        models: scanModels().map((m) => ({ id: m.id, name: m.name, type: m.type })),
      }));
    } catch { /* ignore */ }
    pushWsStatus();
    if (win && !win.isDestroyed()) win.webContents.send('ws:peer', { connected: true });

    socket.on('message', async (data) => {
      let msg;
      try { msg = JSON.parse(data.toString('utf8')); } catch { return; }
      if (msg && msg.type === 'ping') { try { socket.send(JSON.stringify({ type: 'pong' })); } catch { /* ignore */ } return; }
      normIncoming(msg);
      if (win && !win.isDestroyed()) win.webContents.send('ws:message', msg);
    });
    socket.on('close', () => {
      WS.clients.delete(socket);
      log('AstrBot 适配器断开');
      pushWsStatus();
      if (win && !win.isDestroyed()) win.webContents.send('ws:peer', { connected: false });
    });
    socket.on('error', () => { /* ignore */ });
    } catch (e) {
      log('WS 连接处理异常（已兜住）：' + (e && e.message));
      try { socket.close(1011, 'internal error'); } catch { /* ignore */ }
    }
  });
}

function guessMime(p) {
  const ext = path.extname(String(p)).toLowerCase();
  if (ext === '.mp3') return 'audio/mpeg';
  if (ext === '.wav') return 'audio/wav';
  if (ext === '.ogg') return 'audio/ogg';
  if (ext === '.m4a' || ext === '.aac') return 'audio/mp4';
  if (ext === '.flac') return 'audio/flac';
  return 'audio/mpeg';
}

/** AstrBot 侧可能把 TTS 音频给成本地路径，统一转 base64 交给渲染进程 */
function normIncoming(msg) {
  if (!msg || typeof msg !== 'object') return;
  const a = msg.audio;
  if (a && typeof a === 'object' && !a.base64 && a.path) {
    try {
      msg.audio = { base64: fs.readFileSync(a.path).toString('base64'), mime: a.mime || guessMime(a.path) };
    } catch (e) {
      msg.audio = null;
      msg.audioError = '读不到音频文件：' + a.path;
    }
  }
}

// ---------------------------------------------------------------- 窗口
const MIN_W = 180;
const MIN_H = 200;

let win = null;
let tray = null;
let currentModelId = config.model || '';

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function pageQuery() {
  if (argv.includes('--opdiff')) return '?opdiff=1';
  if (argv.includes('--freeze')) return '?freeze=1&sweep=1';
  if (argv.includes('--sweep')) return '?sweep=1';
  const hi2 = argv.indexOf('--hold');
  if (hi2 >= 0) return '?hold=' + encodeURIComponent(argv[hi2+1] || 'curious');
  if (argv.includes('--frametest')) return '?frametest=1';
  if (argv.includes('--pumplean')) return '?pumplean=1';
  if (argv.includes('--lean4')) return '?lean4=1';
  if (argv.includes('--mcap')) return '?mcap=1';
  if (argv.includes('--mouthlog')) return '?mouthlog=1';
  if (argv.includes('--mparamab')) return '?mparamab=1';
  if (argv.includes('--mouthab')) return '?mouthab=1';
  if (argv.includes('--mouthtest')) return '?mouthtest=1';
  if (argv.includes('--params')) return '?params=1';
  if (argv.includes('--lean2')) return '?lean2=1';
  if (argv.includes('--leantest')) return '?leantest=1';
  if (argv.includes('--ranges')) return '?ranges=1';
  if (argv.includes('--paramrange')) return '?paramrange=1';
  if (argv.includes('--emotest')) return '?emotest=1';
  if (argv.includes('--k4diff')) return '?k4diff=1';
  const ei = argv.indexOf('--exprtest');
  if (ei >= 0) return '?exprtest=' + encodeURIComponent(argv[ei+1] || '爱心眼');
  if (argv.includes('--key4test')) return '?key4test=1';
  const ovi = argv.indexOf('--ovtest');
  if (ovi >= 0) return '?ovtest=' + (argv[ovi + 1] || 'all');
  if (argv.includes('--settingstest')) return '?settingstest=1';
  if (argv.includes('--settings')) return '?settings=1';
  if (argv.includes('--mpopen')) return '?mpopen=1';
  if (argv.includes('--mottest')) return '?mottest=1';
  if (argv.includes('--plain')) return '?plain=1';
  if (argv.includes('--pantest')) return '?pantest=1';
  if (argv.includes('--pump')) return '?pump=1';
  if (argv.includes('--diag')) return '?diag=1';
  if (argv.includes('--nomul')) return '?nomul=1';
  const hi = argv.indexOf('--hide');
  if (hi >= 0 && argv[hi + 1]) return '?hide=' + argv[hi + 1];
  return '';
}

function createWindow() {
  const area0 = screen.getPrimaryDisplay().workAreaSize;
  const maxW = Math.max(240, Math.floor(area0.width / 2));   // 不超过半屏
  let w = Math.max(200, Number(config.window.width) || DEFAULT_CONFIG.window.width);
  if (w > maxW) {
    log('窗口宽度 ' + w + ' 超过半屏（' + maxW + '），已收窄');
    w = maxW;
    config.window.width = w;
  }
  const h = Math.max(200, Number(config.window.height) || DEFAULT_CONFIG.window.height);
  let x = config.window.x;
  let y = config.window.y;
  if (x === null || y === null || x === undefined || y === undefined) {
    const area = screen.getPrimaryDisplay().workAreaSize;
    x = area.width - w - 40;
    y = area.height - h - 40;
  }

  win = new BrowserWindow({
    width: w, height: h, x: Math.round(x), y: Math.round(y),
    frame: false,
    transparent: SHOT_ALPHA || (!IS_SHOT && !SHOT_BG),
    backgroundColor: SHOT_ALPHA ? '#00000000' : (SHOT_BG || (IS_SHOT ? '#20202a' : '#00000000')),
    hasShadow: false,
    resizable: true,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: !config.showInTaskbar,
    alwaysOnTop: !!config.alwaysOnTop,
    show: false,
    title: 'AstrBot Deskpet',
    icon: path.join(ROOT, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  if (config.alwaysOnTop) win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  const pageArg = argv.indexOf('--page');
  const page = pageArg >= 0 && argv[pageArg + 1] ? argv[pageArg + 1] : 'index.html';
  win.loadURL('deskpet://app/' + page + pageQuery());

  win.once('ready-to-show', () => {
    win.show();
    if (config.alwaysOnTop) win.setAlwaysOnTop(true, 'screen-saver');
  });
  win.webContents.on('console-message', (_e, level, message) => {
    console.log('[renderer:' + (['debug', 'info', 'warn', 'error'][level] || 'log') + '] ' + message);
  });
  win.webContents.on('render-process-gone', (_e, d) => log('渲染进程异常退出：' + JSON.stringify(d)));
  win.webContents.on('did-fail-load', (_e, code, desc, url) => log('页面加载失败：' + code + ' ' + desc + ' ' + url));

  let moveTimer = null;
  win.on('move', () => {
    if (!win || win.isDestroyed()) return;
    clearTimeout(moveTimer);
    moveTimer = setTimeout(() => {
      const [nx, ny] = win.getPosition();
      config.window.x = nx; config.window.y = ny; saveConfig();
    }, 300);
  });
  win.on('resize', () => {
    if (!win || win.isDestroyed()) return;
    const [nw, nh] = win.getSize();
    config.window.width = nw; config.window.height = nh; saveConfig();
  });
  win.on('minimize', () => { if (!config.showInTaskbar) win.hide(); });
  win.on('closed', () => { win = null; });
}

function buildTrayIcon() {
  const size = 16;
  const buf = Buffer.alloc(size * size * 4);
  const c = size / 2 - 0.5;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, y - c);
      const a = d < 6.2 ? 255 : d < 7.4 ? Math.round(((7.4 - d) / 1.2) * 255) : 0;
      const i = (y * size + x) * 4;
      buf[i] = 0xd6; buf[i + 1] = 0x8a; buf[i + 2] = 0xf5; buf[i + 3] = a;
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

function switchModel(id) {
  const m = scanModels().find((x) => x.id === id);
  if (!m || !m.ok) { log('模型不存在或读取失败：' + id); return; }
  currentModelId = id;
  config.model = id;
  saveConfig();
  send('ui:load-model', m);
  refreshTrayMenu();
}

function refreshTrayMenu() {
  if (!tray) return;
  const models = scanModels();
  const items = models.map((m) => ({
    label: m.name + (m.ok ? '' : '（读取失败）'),
    type: 'radio',
    checked: m.id === currentModelId,
    enabled: m.ok,
    click: () => switchModel(m.id),
  }));
  if (!items.length) items.push({ label: '（models 目录里没有模型）', enabled: false });
  const visible = !!(win && win.isVisible());
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: visible ? '收起（隐藏到托盘）' : '显示桌宠', click: () => { if (!win) return; win.isVisible() ? win.hide() : win.show(); refreshTrayMenu(); } },
    { label: '始终置顶', type: 'checkbox', checked: !!config.alwaysOnTop, click: () => setAlwaysOnTop(!config.alwaysOnTop) },
    { type: 'separator' },
    { label: '切换 Live2D 形象', submenu: items },
    { label: '打开形象选择面板', click: () => send('ui:open-picker') },
    { label: '🎬 动作一览（逐个播放）', submenu: safeMotionMenu() },
    { label: '打开动作面板 (Ctrl+Alt+M)', click: () => send('ui:open-motion-picker') },
    { label: '刷新模型列表', click: () => { refreshTrayMenu(); send('ui:rescan'); } },
    { type: 'separator' },
    {
      label: '窗口大小',
      submenu: [
        { label: '放大', click: () => stepWindowSize(1.12) },
        { label: '缩小', click: () => stepWindowSize(0.89) },
        { label: '恢复默认', click: () => {
          if (!win) return;
          const w = DEFAULT_CONFIG.window.width;
          const h = DEFAULT_CONFIG.window.height;
          const [x, y] = win.getPosition();
          const [ow, oh] = win.getSize();
          win.setBounds({ x: Math.round(x + (ow - w) / 2), y: Math.round(y + (oh - h)), width: w, height: h });
        } },
      ],
    },
    { label: '说点什么…', click: () => send('ui:open-chat') },
    { label: (WS.clients.size ? 'AstrBot：已连接' : 'AstrBot：未连接'), enabled: false },
    { label: '重连 AstrBot', click: () => startWsServer() },
    { type: 'separator' },
    { label: '打开 models 文件夹', click: () => shell.openPath(MODELS_DIR) },
    { label: '打开 config.json', click: () => shell.openPath(CONFIG_PATH) },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]));
}

function safeMotionMenu() {
  try {
    return buildMotionMenu();
  } catch (e) {
    log('构建动作菜单失败: ' + (e && e.message));
    return [{ label: '（动作菜单构建失败，详见日志）', enabled: false }];
  }
}

function buildMotionMenu() {
  const all = scanModels();
  const cur = all.find((m) => m && m.id === currentModelId) || all[0];
  const list = (cur && cur.motions) || [];
  if (!list.length) return [{ label: '（这个模型没有动作文件）', enabled: false }];
  const byGroup = new Map();
  for (const m of list) {
    if (!byGroup.has(m.group)) byGroup.set(m.group, []);
    byGroup.get(m.group).push(m);
  }
  const out = [];
  for (const [g, arr] of byGroup) {
    out.push({
      label: g + '（' + arr.length + '）',
      submenu: arr.map((m) => ({
        label: '#' + m.index + '  ' + (m.name || ''),
        click: () => {
          send('ui:play-motion', { group: m.group, index: m.index, name: m.name });
          log('播放动作: ' + m.group + '#' + m.index + ' ' + (m.name || ''));
        },
      })),
    });
  }
  return out;
}


// ---------------------------------------------------------------- 设置悬浮窗
let settingsWin = null;

function settingsBounds() {
  const sw = (config.settingsWindow && Number(config.settingsWindow.width)) || 380;
  const sh = (config.settingsWindow && Number(config.settingsWindow.height)) || 680;
  return { sw, sh };
}

function openSettingsWindow() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    return;
  }
  const { sw, sh } = settingsBounds();
  const area = screen.getPrimaryDisplay().workAreaSize;
  let sx = config.settingsWindow && config.settingsWindow.x;
  let sy = config.settingsWindow && config.settingsWindow.y;
  if (sx === null || sy === null || sx === undefined || sy === undefined) {
    if (win) {
      const pb = win.getBounds();
      const px = pb.x, py = pb.y, pw = pb.width, ph = pb.height;
      sx = px - sw - 12;                                  // 优先放桌宠左边
      if (sx < 8) sx = px + pw + 12;                      // 左边不够就放右边
      if (sx + sw > area.width - 8) {                     // 两边都不够就贴着桌宠居中
        sx = Math.max(8, Math.min(area.width - sw - 8, Math.round(px + pw / 2 - sw / 2)));
      }
      sy = Math.max(8, Math.min(area.height - sh - 8, py));
    } else {
      sx = Math.round((area.width - sw) / 2);
      sy = Math.round((area.height - sh) / 2);
    }
  }
  settingsWin = new BrowserWindow({
    x: Math.round(sx), y: Math.round(sy), width: sw, height: sh,
    frame: false,
    resizable: true,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    title: '桌宠设置',
    backgroundColor: '#1b1b24',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  const probe = process.argv.includes('--probe');
  log('设置窗 probe=' + probe);
  if (probe) settingsWin.loadFile(path.join(__dirname, 'renderer', 'settings.html'), { query: { probe: '1' } });
  else settingsWin.loadFile(path.join(__dirname, 'renderer', 'settings.html'));
  settingsWin.once('ready-to-show', () => settingsWin.show());
  settingsWin.on('close', () => {
    try {
      const b = settingsWin.getBounds();
      config.settingsWindow = { x: b.x, y: b.y, width: b.width, height: b.height };
      saveConfig();
    } catch (e) { /* ignore */ }
  });
  settingsWin.on('closed', () => { settingsWin = null; });
  log('打开设置悬浮窗');
}

ipcMain.on('win:open-settings', () => openSettingsWindow());
ipcMain.on('win:close-self', () => { if (settingsWin && !settingsWin.isDestroyed()) settingsWin.close(); });
ipcMain.on('ui:command', (_e, cmd) => {
  const s = String(cmd || '');
  if (s === 'open-chat') return send('ui:open-chat');
  if (s === 'reload-behavior') return send('ui:reload-behavior');
  if (s === 'open-picker') return send('ui:open-picker');
  if (s === 'open-motion-picker') return send('ui:open-motion-picker');
  if (s.startsWith('play-motion:')) {
    const [, group, index] = s.split(':');
    return send('ui:play-motion', { group, index: Number(index) });
  }
  if (s.startsWith('param-override:')) {
    try {
      const payload = JSON.parse(s.slice('param-override:'.length));
      return send('ui:param-override', payload);
    } catch (e) { return; }
  }
  if (s.startsWith('set-expression:')) return send('ui:set-expression', s.slice('set-expression:'.length));
  if (s === 'reset-expressions') return send('ui:reset-expressions');
  if (s.startsWith('emotion-action:')) return send('ui:emotion-action', s.slice('emotion-action:'.length));
  if (s.startsWith('load-model:')) {
    const id = s.slice('load-model:'.length);
    return switchModel(id);
  }
});

function createTray() {
  tray = new Tray(buildTrayIcon());
  tray.setToolTip('AstrBot 桌宠');
  refreshTrayMenu();
  tray.on('click', () => { if (!win) return; win.isVisible() ? win.hide() : win.show(); refreshTrayMenu(); });
}

// ---------------------------------------------------------------- 自定义协议
protocol.registerSchemesAsPrivileged([{
  scheme: 'deskpet',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
}]);

function registerProtocol() {
  protocol.handle('deskpet', async (request) => {
    const u = new URL(request.url);
    const host = u.hostname;
    const base = host === 'models' ? MODELS_DIR : host === 'app' ? RENDERER_DIR : null;
    if (!base) return new Response('not found', { status: 404 });
    const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
    const abs = path.normalize(path.join(base, rel));
    if (!abs.startsWith(base)) return new Response('forbidden', { status: 403 });
    try {
      return await net.fetch(pathToFileURL(abs).toString());
    } catch (e) {
      return new Response('not found: ' + rel, { status: 404 });
    }
  });
}

// ---------------------------------------------------------------- IPC
ipcMain.handle('models:list', () => scanModels());
ipcMain.on('app:open-config', () => shell.openPath(CONFIG_PATH));
ipcMain.on('ws:reconnect', () => { log('手动重连 AstrBot'); startWsServer(); });
ipcMain.handle('config:get', () => config);
ipcMain.handle('config:set', (_e, patch) => {
  config = deepMerge(config, patch || {});
  saveConfig();
  if (patch && patch.alwaysOnTop !== undefined && win) win.setAlwaysOnTop(!!config.alwaysOnTop, 'screen-saver');
  if (patch && patch.ws) startWsServer();
  return config;
});
ipcMain.on('ws:send', (_e, msg) => wsBroadcast(msg));
ipcMain.on('win:ignore-mouse', (_e, ignore) => {
  if (!win) return;
  if (!config.clickThrough) { win.setIgnoreMouseEvents(false); return; }
  win.setIgnoreMouseEvents(!!ignore, { forward: true });
});
ipcMain.on('win:drag-start', (_e, p) => {
  if (!win) return;
  const [wx, wy] = win.getPosition();
  dragOrigin = { wx, wy, sx: p.screenX, sy: p.screenY };
});
ipcMain.on('win:drag-move', (_e, p) => {
  if (!win || !dragOrigin) return;
  win.setPosition(Math.round(dragOrigin.wx + (p.screenX - dragOrigin.sx)), Math.round(dragOrigin.wy + (p.screenY - dragOrigin.sy)));
});
ipcMain.on('win:drag-end', () => { dragOrigin = null; });

// ---- 窗口缩放 ----
let resizeOrigin = null;
ipcMain.on('win:resize-start', (_e, p) => {
  if (!win) return;
  const [w, h] = win.getSize();
  resizeOrigin = { w, h, sx: p.screenX, sy: p.screenY };
});
ipcMain.on('win:resize-move', (_e, p) => {
  if (!win || !resizeOrigin) return;
  const nw = Math.max(MIN_W, Math.round(resizeOrigin.w + (p.screenX - resizeOrigin.sx)));
  const nh = Math.max(MIN_H, Math.round(resizeOrigin.h + (p.screenY - resizeOrigin.sy)));
  win.setSize(nw, nh);
});
ipcMain.on('win:resize-end', () => { resizeOrigin = null; });

/** 按比例缩放窗口，保持「角色脚底中心」不动 */
function stepWindowSize(factor) {
  const area = screen.getPrimaryDisplay().workAreaSize;
  const maxW = Math.max(240, Math.floor(area.width / 2));
  if (!win) return;
  const [w, h] = win.getSize();
  const [x, y] = win.getPosition();
  const nw = Math.min(maxW, Math.max(MIN_W, Math.round(w * factor)));
  const nh = Math.max(MIN_H, Math.round(h * factor));
  win.setBounds({
    x: Math.round(x + (w - nw) / 2),
    y: Math.round(y + (h - nh)),
    width: nw,
    height: nh,
  });
}
function setAlwaysOnTop(on) {
  config.alwaysOnTop = !!on;
  saveConfig();
  if (win) win.setAlwaysOnTop(!!on, 'screen-saver');
  send('ui:top-state', !!on);
  refreshTrayMenu();
}
ipcMain.on('win:toggle-top', () => setAlwaysOnTop(!config.alwaysOnTop));
ipcMain.on('win:set-top', (_e, on) => setAlwaysOnTop(!!on));
ipcMain.on('win:collapse', () => {
  if (!win) return;
  win.hide();
  refreshTrayMenu();
});
ipcMain.on('win:size-step', (_e, factor) => stepWindowSize(Number(factor) || 1));
ipcMain.on('win:size-reset', () => {
  if (!win) return;
  const w = DEFAULT_CONFIG.window.width;
  const h = DEFAULT_CONFIG.window.height;
  const [x, y] = win.getPosition();
  const [ow, oh] = win.getSize();
  win.setBounds({ x: Math.round(x + (ow - w) / 2), y: Math.round(y + (oh - h)), width: w, height: h });
});
ipcMain.on('app:open-models', () => shell.openPath(MODELS_DIR));
ipcMain.on('app:quit', () => app.quit());
ipcMain.on('appearance:broadcast', (_e, ap) => {
  try { if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('appearance:state', ap); } catch (e) { /* ignore */ }
});

ipcMain.on('test:capture', async (_e, name) => {
  try {
    if (!win) return;
    const img = await win.webContents.capturePage();
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    const out = path.resolve(ROOT, 'shots', String(name || 'cap') + '.png');
    fs.writeFileSync(out, img.toPNG());
    log('已抓图 ' + out);
  } catch (e) { log('抓图失败: ' + e.message); }
});

ipcMain.on('renderer:log', (_e, m) => console.log('[renderer] ' + m));

ipcMain.on('renderer:model-loaded', (_e, id) => {
  currentModelId = id;
  config.model = id;
  saveConfig();
  refreshTrayMenu();
});

ipcMain.on('renderer:ready', async (_e, info) => {
  log('渲染进程就绪：' + JSON.stringify(info));
  if (FORCE_MODEL) {
    const fm = scanModels().find((x) => x.id === FORCE_MODEL || x.name === FORCE_MODEL);
    if (fm) send('ui:load-model', fm);
  }
  if (!IS_SHOT) return;
  if (IS_DEMO) send('ui:demo');
  if (argv.includes('--chat')) setTimeout(() => send('ui:open-chat'), 800);
  if (argv.includes('--picker')) send('ui:open-picker');
  const si = argv.indexOf('--say');
  const sdi = argv.indexOf('--say-delay');
  const sayDelay = sdi >= 0 ? Number(argv[sdi + 1]) || 1200 : 1200;
  if (si >= 0 && argv[si + 1]) setTimeout(() => { log('发送测试语句（等待 ' + sayDelay + 'ms 后）'); send('ui:say', argv[si + 1]); }, sayDelay);
  setTimeout(async () => {
    try {
      const img = await win.webContents.capturePage();
      fs.mkdirSync(SHOT_DIR, { recursive: true });
      const out = path.resolve(ROOT, SHOT_PATH || path.join('shots', 'shot-' + Date.now() + '.png'));
      fs.writeFileSync(out, img.toPNG());
      log('截图已保存：' + out);
    } catch (e) {
      log('截图失败：' + e.message);
    }
    setTimeout(() => app.quit(), 300);
  }, SHOT_DELAY);
});

// ---------------------------------------------------------------- 生命周期
let dragOrigin = null;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { win.show(); win.focus(); } });
  app.whenReady().then(() => {
    registerProtocol();
    createWindow();
    createTray();
    try {
      const { globalShortcut } = require('electron');
      globalShortcut.register('Control+Alt+M', () => send('ui:open-motion-picker'));
      app.on('will-quit', () => { try { globalShortcut.unregisterAll(); } catch (e) { /* ignore */ } });
    } catch (e) { log('注册快捷键失败: ' + (e && e.message)); }
    startWsServer();
    // 开发自检：截图设置悬浮窗
    log('argv = ' + argv.join(' | '));
    if (argv.includes('--ovtest')) { const i = argv.indexOf('--ovtest'); return '?ovtest=' + (argv[i+1] || 'all'); }
  if (argv.includes('--shotsettings')) {
      log('检测到 --shotsettings，1.5 秒后打开设置窗');
      setTimeout(() => {
        try { openSettingsWindow(); } catch (e) { log('打开设置窗抛错: ' + (e && e.stack ? e.stack : e)); }
        setTimeout(async () => {
          try {
            if (!settingsWin) { log('设置窗未创建'); return; }
            const img = await settingsWin.webContents.capturePage();
            fs.mkdirSync(SHOT_DIR, { recursive: true });
            const out = path.resolve(ROOT, 'shots', 'settings_win.png');
            fs.writeFileSync(out, img.toPNG());
            const b = settingsWin.getBounds();
            log('设置窗截图: ' + out + '  bounds=' + b.x + ',' + b.y + ' ' + b.width + 'x' + b.height);
          } catch (e) { log('设置窗截图失败: ' + e.message); }
        }, 2600);
      }, 1500);
    }
  });
  // 主进程兜底：任何未捕获异常只记录日志，不弹 Electron 的红色报错框（否则桌宠直接卡死）
process.on('uncaughtException', (e) => {
  log('主进程未捕获异常: ' + (e && e.stack ? e.stack : e));
});
process.on('unhandledRejection', (e) => {
  log('主进程未处理的 Promise 拒绝: ' + (e && e.stack ? e.stack : e));
});

app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => {
    try { if (settingsWin && !settingsWin.isDestroyed()) settingsWin.destroy(); } catch (e) { /* ignore */ }
    stopWsServer();
    saveConfig();
  });
}
