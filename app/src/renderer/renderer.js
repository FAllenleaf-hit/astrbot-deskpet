'use strict';
/* AstrBot Live2D 桌宠 —— 渲染进程 */
const API = window.pet;
const $ = (id) => document.getElementById(id);
const log = (...a) => API.log(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));



const state = {
  cfg: null,
  models: [],
  info: null,
  currentId: '',
  connected: false,
  chatOpen: false,
  pickerOpen: false,
  typing: false,
  speaking: false,
  dragging: false,
  downAt: null,
  moved: 0,
  pointer: { x: -9999, y: -9999 },
  lastActivity: Date.now(),
  angryUntil: 0,
  nextDodge: 0,
  greeted: false,
  mood: null,
  pan: { x: 0, y: 0 },
  bubbleAt: 0,
  motionPickerOpen: false,
  settingsOpen: false,
  appearance: { face: {}, look: {}, body: '' },
  emotion: null,
  emotionUntil: 0,
};

let app = null;
let model = null;
let lipParam = null;
let mouthLevel = 0;
let audioCtx = null;
let analyser = null;
let analyserData = null;
let bubbleTimer = null;
let typeTimer = null;
let idleTimer = null;
let emotionTimer = null;

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const modelUrl = (rel) => 'deskpet://models/' + rel.split('/').map(encodeURIComponent).join('/');

// ------------------------------------------------------------------ 启动问候 / 情绪延续
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

const MOOD_WORD = {
  happy: '看起来心情不错', sad: '好像有点低落', angry: '好像还在生气',
  shy: '有点不好意思', surprised: '好像有点惊讶', thinking: '在想事情',
  tired: '看起来有点累', neutral: '',
};

function greetingText() {
  const h = new Date().getHours();
  let base;
  if (h >= 5 && h < 11) base = pick(['早上好呀～', '早！昨晚睡得好吗？', '早上好，今天也一起加油']);
  else if (h >= 11 && h < 13) base = pick(['中午好，吃饭了吗？', '中午啦，记得吃点东西']);
  else if (h >= 13 && h < 18) base = pick(['下午好～', '下午啦，要不要歇一会儿']);
  else if (h >= 18 && h < 22) base = pick(['晚上好呀', '晚上好，今天过得怎么样？']);
  else if (h >= 22 || h < 2) base = pick(['这么晚还不睡呀…', '夜深了，别熬太晚哦']);
  else base = pick(['你还没睡？我都困了…', '凌晨了，快去睡觉吧']);
  const w = MOOD_WORD[state.mood] || '';
  return w ? base + '（' + w + '）' : base;
}

function greet() {
  if (state.greeted) return;
  if (state.cfg.behavior && state.cfg.behavior.greetOnStart === false) return;
  state.greeted = true;
  triggerBehavior('turn');
  setTimeout(() => {
    const gt = greetingText();
    log('启动问候: ' + gt);
    showBubble(gt, { instant: true, ttlMs: 9000 });
    triggerBehavior('nod', { dur: 1.3 });
  }, 520);
}

/** AstrBot 带过来的情绪：桌宠刚启动/刚连上时继续沿用 */
function applyMood(emotion, ageS) {
  if (!emotion) return;
  const age = Number(ageS);
  if (Number.isFinite(age) && age > 7200) return; // 超过 2 小时就不要了
  state.mood = emotion;
  setEmotion(emotion, Number.isFinite(age) && age < 1800 ? 9000 : 5000);
  log('延续情绪: ' + emotion + (Number.isFinite(age) ? '（' + Math.round(age) + ' 秒前）' : ''));
}

function rememberMood(emotion) {
  if (!emotion) return;
  state.mood = emotion;
  API.setConfig({ lastMood: { emotion, ts: Date.now() } });
}

// ------------------------------------------------------------------ 启动
function dumpDrawables() {
  try {
    const cm = model.internalModel.coreModel;
    const core = cm._model || cm;
    const d = core.drawables;
    const info = core.canvasinfo || {};
    const U = window.Live2DCubismCore.Utils || {};
    API.log('UTILS ' + Object.keys(U).join(','));
    API.log('CANVAS ' + JSON.stringify({
      w: info.CanvasWidth, h: info.CanvasHeight, ppu: info.PixelsPerUnit,
      ox: info.CanvasOriginX, oy: info.CanvasOriginY,
    }));
    const n = d.ids.length;
    const rows = [];
    for (let i = 0; i < n; i++) {
      const pos = d.vertexPositions[i];
      const uvs = d.vertexUvs[i];
      const vc = d.vertexCounts[i];
      let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
      let u0 = 1e9, v0 = 1e9, u1 = -1e9, v1 = -1e9;
      for (let k = 0; k < vc; k++) {
        const px = pos[k * 2], py = pos[k * 2 + 1];
        const uu = uvs[k * 2], vv = uvs[k * 2 + 1];
        if (px < minX) minX = px; if (px > maxX) maxX = px;
        if (py < minY) minY = py; if (py > maxY) maxY = py;
        if (uu < u0) u0 = uu; if (uu > u1) u1 = uu;
        if (vv < v0) v0 = vv; if (vv > v1) v1 = vv;
      }
      rows.push({
        i, id: d.ids[i], tex: d.textureIndices[i], vc,
        x: [+minX.toFixed(3), +maxX.toFixed(3)],
        y: [+minY.toFixed(3), +maxY.toFixed(3)],
        uv: [+u0.toFixed(4), +v0.toFixed(4), +u1.toFixed(4), +v1.toFixed(4)],
        masks: d.maskCounts ? d.maskCounts[i] : 0,
        op: +Number(d.opacities[i]).toFixed(3),
        part: d.parentPartIndices ? d.parentPartIndices[i] : -1,
        partOp: (cm.getPartOpacityByIndex && d.parentPartIndices) ? +Number(cm.getPartOpacityByIndex(d.parentPartIndices[i])).toFixed(3) : -1,
        blend: (U.hasBlendMultiplicativeBit && U.hasBlendMultiplicativeBit(d.constantFlags[i])) ? 'mul' : ((U.hasBlendAdditiveBit && U.hasBlendAdditiveBit(d.constantFlags[i])) ? 'add' : 'normal'),
        flags: d.constantFlags ? d.constantFlags[i] : 0,
      });
    }
    for (const i of [513,514,520,521,647,0,1]) {
      const mc = d.multiplyColors ? [d.multiplyColors[i*4],d.multiplyColors[i*4+1],d.multiplyColors[i*4+2],d.multiplyColors[i*4+3]] : null;
      const sc = d.screenColors ? [d.screenColors[i*4],d.screenColors[i*4+1],d.screenColors[i*4+2],d.screenColors[i*4+3]] : null;
      API.log('MULTCOLOR ' + i + ' mul=' + JSON.stringify(mc) + ' screen=' + JSON.stringify(sc) + ' renderOrder=' + (d.renderOrders?d.renderOrders[i]:'?') + ' drawOrder=' + (d.drawOrders?d.drawOrders[i]:'?'));
    }
    let aff = 0;
    for (let i = 0; i < n; i++) {
      const m0 = d.multiplyColors[i*4], m1 = d.multiplyColors[i*4+1], m2 = d.multiplyColors[i*4+2];
      const s0 = d.screenColors[i*4], s1 = d.screenColors[i*4+1], s2 = d.screenColors[i*4+2];
      const blackMul = m0 < 0.05 && m1 < 0.05 && m2 < 0.05;
      const someScr = s0 > 0.05 || s1 > 0.05 || s2 > 0.05;
      if (blackMul && someScr) {
        aff++;
        const uv = d.vertexUvs[i];
        const poly = [];
        for (let k = 0; k < uv.length; k += 2) poly.push([+uv[k].toFixed(5), +uv[k+1].toFixed(5)]);
        API.log('BLENDFIX ' + JSON.stringify({
          i, tex: d.textureIndices[i], op: +d.opacities[i].toFixed(2),
          scr: [+s0.toFixed(4), +s1.toFixed(4), +s2.toFixed(4)],
          poly,
          idx: (() => { try { const raw = d.indices[i] || d.indices; const c = d.indexCounts[i]; return Array.from(raw && raw.length !== undefined ? raw : []).slice(0, c); } catch (e) { return []; } })(),
        }));
      }
    }
    API.log('AFFECTED_TOTAL ' + aff);
    API.log('DRAWABLES_TOTAL ' + n);
    for (const row of rows) API.log('DW ' + JSON.stringify(row));
  } catch (e) {
    API.log('dump 失败: ' + (e && e.message));
  }
}

async function boot() {
  state.cfg = await API.getConfig();
  state.appearance = Object.assign({ face: {}, look: {}, body: '' }, state.cfg.appearance || {});
  state.appearance.face = state.appearance.face || {};
  state.appearance.look = state.appearance.look || {};
  await initPixi();
  state.models = await API.listModels();
  log('发现模型 ' + state.models.length + ' 个');
  setConnected(false);
  $('hud-text').textContent = '本地模式';

  if (!window.PIXI || !PIXI.live2d) throw new Error('Pixi / pixi-live2d-display 未加载');
  PIXI.live2d.Live2DModel.registerTicker(PIXI.Ticker);

  const wanted = state.cfg.model || state.models.find((m) => m.ok)?.id;
  const target = state.models.find((m) => m.id === wanted && m.ok) || state.models.find((m) => m.ok);
  if (!target) {
    $('loading').textContent = 'models 目录里没有可用模型，请放入 Cubism 3/4 模型文件夹';
    return;
  }
  await loadModel(target);
  startIdleLoop();
  const q = new URLSearchParams(location.search);
  if (q.get('diag')) dumpDrawables();
  if (q.get('pump')) {
    setTimeout(() => {
      window.__probeBehavior = true;
      PROC.awakeUntil = performance.now() + 3600e3; // 自检期间关掉昼夜调度，逐个测行为
      PROC.nextLook = performance.now() + 3600e3;
      PROC.nextYawn = performance.now() + 3600e3;
      let tm = performance.now();
      const step = (n) => { for (let i = 0; i < n; i++) { tm += 16.7; app.ticker.deltaMS = 16.7; try { postTick(); } catch (e) { /* ignore */ } } };
      const run = (name, frames, opts) => {
        API.log('=== 触发行为 ' + name + ' ===');
        triggerBehavior(name, opts);
        step(frames);
        PROC.behaviors = [];
        step(20);
      };
      API.log('=== 触发行为 dodge ===');
      triggerBehavior('dodge', { data: { dir: 1 } });
      step(80);
      PROC.behaviors = [];
      step(20);
      run('turn', 60);
      run('yawn', 175);
      run('lookAround', 310, { data: makeLookTargets() });
      run('dizzy', 165);
      run('angry', 105);
      API.log('=== 逐个情绪动作检查 ===');
      for (const emo of ['happy','sad','angry','surprised','shy','thinking','tired','neutral']) {
        API.log('--- 情绪 ' + emo + ' -> ' + (EMOTION_ACTION[emo] || 'ack'));
        lastActionAt[EMOTION_ACTION[emo] || 'ack'] = 0;
        playEmotionAction(emo);
        step(26);
        PROC.behaviors = [];
        step(10);
      }
      API.log('=== 气泡位置回归检查 ===');
      showBubble('这是一条比较长的测试消息，用来验证气泡变宽以后会不会挡住角色的脸，如果会挡就说明位置算法还需要调整。', { instant: true, ttlMs: 60000 });
      {
        const r = document.getElementById('bubble').getBoundingClientRect();
        const b = model.getBounds();
        const faceW = Math.max(96, b.width * 0.34);
        const faceL = b.x + b.width / 2 - faceW / 2, faceR = b.x + b.width / 2 + faceW / 2;
        const faceT = b.y + b.height * 0.06, faceB = b.y + b.height * 0.32;
        const overX = Math.max(0, Math.min(r.right, faceR) - Math.max(r.left, faceL));
        const overY = Math.max(0, Math.min(r.bottom, faceB) - Math.max(r.top, faceT));
        API.log('CHECK 气泡=[' + Math.round(r.left) + ',' + Math.round(r.top) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height) + ']' +
          ' 脸=[' + Math.round(faceL) + ',' + Math.round(faceT) + ' ' + Math.round(faceW) + 'x' + Math.round(faceB - faceT) + ']' +
          ' 压脸面积=' + Math.round(overX * overY) + 'px²' + (overX > 0 && overY > 0 ? ' ❌ 挡脸了' : ' ✅ 没挡脸'));
      }
      showBubble('短消息', { instant: true, ttlMs: 60000 });
      {
        const r2 = document.getElementById('bubble').getBoundingClientRect();
        API.log('CHECK2 短气泡=[' + Math.round(r2.left) + ',' + Math.round(r2.top) + ' ' + Math.round(r2.width) + 'x' + Math.round(r2.height) + ']');
      }
      API.log('=== 戳头反应 ===');
      const mw0 = model.width, mh0 = model.height, sc0 = model.scale.y;
      reportInteraction('pat', '（戳了戳你）');
      const br = document.getElementById('bubble').getBoundingClientRect();
      const mb = model.getBounds();
      API.log('BUBBLE 气泡=[' + Math.round(br.x) + ',' + Math.round(br.y) + ' ' + Math.round(br.width) + 'x' + Math.round(br.height) + ']' +
        ' 模型=[' + Math.round(mb.x) + ',' + Math.round(mb.y) + ' ' + Math.round(mb.width) + 'x' + Math.round(mb.height) + ']' +
        ' class=' + document.getElementById('bubble').className);
      API.log('模型尺寸 前=' + Math.round(mw0) + 'x' + Math.round(mh0) + ' 后=' + Math.round(model.width) + 'x' + Math.round(model.height) + ' 缩放恒定=' + (Math.abs(sc0 - model.scale.y) < 1e-6));
      API.log('=== 戳头反应 ===');
      playTapMotion(['HitAreaHead']);
      step(24);
      API.log('=== 戳身体反应 ===');
      playTapMotion(['HitAreaBody']);
      step(24);
      API.log('=== 模拟打字歪头 ===');
      PROC.typingUntil = performance.now() + 60000;
      step(30);
      PROC.typingUntil = 0;
      step(20);
      API.log('=== 模拟生气后躲手 ===');
      run('dodge', 80, { data: { dir: 1 } });
      PROC.behaviors = [];
      step(60);
      API.log('=== 静置 1 秒后（应回到基线）===');
      window.__probeBehavior = true;
      step(1);
      API.log('=== PUMP 自检完成 ===');
    }, 1500);
  }
  API.ready({ model: state.currentId, models: state.models.length });
}

/**
 * Cubism「混合颜色」支持：
 * 结果 = 贴图 × multiplyColor + screenColor × alpha
 * pixi-live2d-display 没实现这个特性，我们给它的 shader 打了补丁，
 * 这里负责在每次绘制 drawable 前把该图层的两个颜色传进去。
 */
globalThis.__dpSetBlendColor = function (gl, shaderSet) {
  try {
    const prog = shaderSet && shaderSet.shaderProgram;
    if (!prog) return;
    if (shaderSet.__mulLoc === undefined) {
      shaderSet.__mulLoc = gl.getUniformLocation(prog, 'u_mulColor');
      shaderSet.__scrLoc = gl.getUniformLocation(prog, 'u_scrColor');
    }
    // 该着色器没有这两个 uniform（比如遮罩着色器）就跳过
    if (shaderSet.__mulLoc === null && shaderSet.__scrLoc === null) return;
    const d = globalThis.__dpDrawables;
    const idx = globalThis.__dpDrawable;
    let m = [1, 1, 1, 1], sc = [0, 0, 0, 0];
    if (d && typeof idx === 'number' && idx >= 0 && idx * 4 < d.multiplyColors.length) {
      const i4 = idx * 4;
      m = [d.multiplyColors[i4], d.multiplyColors[i4 + 1], d.multiplyColors[i4 + 2], d.multiplyColors[i4 + 3]];
      sc = [d.screenColors[i4], d.screenColors[i4 + 1], d.screenColors[i4 + 2], d.screenColors[i4 + 3]];
    }
    if (shaderSet.__mulLoc) gl.uniform4f(shaderSet.__mulLoc, m[0], m[1], m[2], m[3]);
    if (shaderSet.__scrLoc) gl.uniform4f(shaderSet.__scrLoc, sc[0], sc[1], sc[2], sc[3]);
  } catch { /* ignore */ }
};

async function initPixi() {
  // 关键：4096 贴图缩到 ~0.1 倍显示，必须开 mipmap + 各向异性过滤，
  // 否则细边缘（比如尾巴）会出现锯齿/闪烁。
  try {
    PIXI.settings.SCALE_MODE = PIXI.SCALE_MODES.LINEAR;
    PIXI.settings.MIPMAP_TEXTURES = PIXI.MIPMAP_MODES.ON;
    PIXI.settings.ANISOTROPIC_LEVEL = 8;
    PIXI.settings.FAIL_IF_MAJOR_PERFORMANCE_CAVEAT = false;
    log('Pixi 贴图设置: mipmap=' + PIXI.settings.MIPMAP_TEXTURES + ' aniso=' + PIXI.settings.ANISOTROPIC_LEVEL);
  } catch (e) {
    log('Pixi 贴图设置失败: ' + (e && e.message));
  }
  app = new PIXI.Application({
    view: $('stage'),
    width: window.innerWidth,
    height: window.innerHeight,
    backgroundAlpha: 0,
    antialias: true,
    autoDensity: true,
    // 超采样：贴图很大而显示很小，用 1.5x 分辨率渲染再缩回，能明显改善细边缘锯齿
    resolution: (window.devicePixelRatio || 1) * (Number((state.cfg && state.cfg.renderScale)) || 1.5),
    powerPreference: 'high-performance',
  });
  window.addEventListener('resize', () => {
    app.renderer.resize(window.innerWidth, window.innerHeight);
    fitModel();
    positionBubble();
  });
  const PLAIN = new URLSearchParams(location.search).get('plain') === '1'
    || !(state.cfg && state.cfg.glMipmapPatch === true);
  if (PLAIN) { log('GL mipmap 补丁：关闭'); }
  // ---- 关键修复：给 Live2D 的 GL 贴图补上 mipmap ----
  // pixi-live2d-display 自己创建 GL 贴图时只设了 LINEAR，从不调用 generateMipmap，
  // 4096 贴图被缩小 10 倍以上采样 → 细边缘严重锯齿（硬 alpha 素材尤其明显）。
  if (!PLAIN) try {
    const gl = app.renderer.gl;
    const AnisoExt = gl.getExtension('EXT_texture_filter_anisotropic')
      || gl.getExtension('WEBKIT_EXT_texture_filter_anisotropic')
      || gl.getExtension('MOZ_EXT_texture_filter_anisotropic');
    const maxAniso = AnisoExt ? gl.getParameter(AnisoExt.MAX_TEXTURE_MAX_ANISOTROPY_EXT) : 0;

    window.__mip = { img: 0, ok: 0, fail: 0, err: '', texs: [] };
    const origTexImage = gl.texImage2D.bind(gl);
    const origTexParam = gl.texParameteri.bind(gl);
    const renderTargets = new Set();   // 被用作渲染目标的纹理（遮罩缓冲等）

    // 任何被 attach 到 framebuffer 的纹理 = 渲染目标，不能加 mipmap 过滤
    const origFboTex = gl.framebufferTexture2D.bind(gl);
    gl.framebufferTexture2D = function (target, attachment, textarget, texture, level) {
      try { if (texture) renderTargets.add(texture); } catch { /* ignore */ }
      return origFboTex(target, attachment, textarget, texture, level);
    };

    gl.texImage2D = function (...args) {
      const r = origTexImage(...args);
      try {
        const tex = gl.getParameter(gl.TEXTURE_BINDING_2D);
        // 第 9 个参数是 null ⇒ 空贴图（渲染目标），不做 mipmap
        const isEmpty = args.length >= 9 && (args[8] === null || args[8] === undefined);
        if (isEmpty) {
          if (tex) renderTargets.add(tex);
          origTexParam(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        } else {
          gl.generateMipmap(gl.TEXTURE_2D);
          origTexParam(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
          if (AnisoExt && maxAniso) {
            gl.texParameterf(gl.TEXTURE_2D, AnisoExt.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, maxAniso));
          }
        }
      } catch (e) { /* ignore */ }
      return r;
    };

    // 库自己设置过滤时：渲染目标一律保持 LINEAR（否则会采样到空的 mip 层 → 变黑）
    gl.texParameteri = function (target, pname, param) {
      try {
        const tex = gl.getParameter(gl.TEXTURE_BINDING_2D);
        if (pname === gl.TEXTURE_MIN_FILTER && param === gl.LINEAR && !(tex && renderTargets.has(tex))) {
          param = gl.LINEAR_MIPMAP_LINEAR;
        }
      } catch { /* ignore */ }
      return origTexParam(target, pname, param);
    };
    window.__glRenderTargets = renderTargets;
    log('已给 GL 贴图启用 mipmap（三线性）+ 各向异性=' + Math.min(8, maxAniso || 0));
  } catch (e) {
    log('GL mipmap 补丁失败: ' + (e && e.message));
  }

  app.ticker.add(onTick);
  app.ticker.add(postTick, null, PIXI.UPDATE_PRIORITY.LOW);
}

// ------------------------------------------------------------------ 模型加载
async function loadModel(info) {
  $('loading').classList.remove('hidden');
  $('loading').textContent = '正在加载 ' + info.name + ' …';
  try {
    if (model) {
      app.stage.removeChild(model);
      model.destroy({ children: true, texture: true, baseTexture: true });
      model = null;
    }
    const m = await PIXI.live2d.Live2DModel.from(modelUrl(info.file), {
      autoInteract: false,
      idleMotionGroup: info.motionGroups && info.motionGroups.includes('Idle') ? 'Idle' : undefined,
    });
    m.anchor.set(0.5, 1);
    m.eventMode = 'none';
    app.stage.addChild(m);
    model = m;
    state.info = info;
    state.currentId = info.id;
    lipParam = info.lipSyncParam || 'ParamMouthOpenY';
    fitModel();
    lastOffsets.clear();
    initProcedural();
    const lm = state.cfg.lastMood;
    if (lm && lm.emotion && Date.now() - (lm.ts || 0) < 3 * 3600 * 1000) {
      state.mood = lm.emotion;
      setEmotion(lm.emotion, 8000);
    }
    if (state.cfg.behavior && state.cfg.behavior.chatInputPinned !== false) toggleChat(true, true);
    setTimeout(() => greet(), 1500);
    tryRandomIdle();
    // 再对每张贴图兜一遍 mipmap / 各向异性过滤
    try {
      const tm = m.internalModel.textureManager;
      let n = 0;
      if (tm && typeof tm.getTexture === 'function') {
        for (let i = 0; i < 8; i++) {
          const tex = tm.getTexture(i);
          if (!tex || !tex.baseTexture) continue;
          const bt = tex.baseTexture;
          bt.mipmap = PIXI.MIPMAP_MODES.ON;
          bt.anisotropicLevel = 8;
          bt.update();
          n++;
        }
      }
      log('贴图过滤已加强: ' + n + ' 张');
    } catch (e) {
      log('贴图过滤调整失败: ' + (e && e.message));
    }
    // 关键修复：Cubism 的裁剪遮罩缓冲默认只有 256x256，
    // 所有用遮罩的图层边缘会在 256 的网格上算出来，再贴到 1400x1560 的画面上，
    // 每个遮罩像素≈5 个屏幕像素 → 边缘出现大块方形台阶。
    try {
      const r = model.internalModel.renderer;
      const PLAIN2 = new URLSearchParams(location.search).get('plain') === '1';
      const wantSize = PLAIN2 ? 256 : (Number((state.cfg && state.cfg.clippingMaskSize) || 2048));
      if (r && typeof r.setClippingMaskBufferSize === 'function') {
        const before = r.getClippingMaskBufferSize ? r.getClippingMaskBufferSize() : '?';
        r.setClippingMaskBufferSize(wantSize);
        log('遮罩缓冲: ' + before + ' -> ' + wantSize);
      }
    } catch (e) {
      log('遮罩缓冲调整失败: ' + (e && e.message));
    }
    // ---- 自动隐藏「混合颜色」异常图层 ----
    // 这类图层的 multiplyColor 是纯黑、screenColor 是某个纯色，
    // 按 Cubism 公式算出来就是一整块纯色（白方块 / 黑碗），而那显然是画师的辅助层，
    // 正确做法是隐藏它们，让下面的正稿显示出来。
    try {
      const core = model.internalModel.coreModel._model || model.internalModel.coreModel;
      const d = core.drawables;
      const hide = [];
      for (let i = 0; i < d.ids.length; i++) {
        const m0 = d.multiplyColors[i * 4], m1 = d.multiplyColors[i * 4 + 1], m2 = d.multiplyColors[i * 4 + 2];
        const s0 = d.screenColors[i * 4], s1 = d.screenColors[i * 4 + 1], s2 = d.screenColors[i * 4 + 2];
        const blackMul = m0 < 0.05 && m1 < 0.05 && m2 < 0.05;
        const someScr = s0 > 0.05 || s1 > 0.05 || s2 > 0.05;
        if (blackMul && someScr && d.opacities[i] > 0.01) hide.push(i);
      }
      const enableHide = !!(state.cfg && state.cfg.autoHideBlendColor === true);
      state.hideDrawables = enableHide ? hide : [];
      log('混合色图层候选: ' + JSON.stringify(hide) + '，自动隐藏=' + enableHide);
    } catch (e) {
      log('自动识别混合色图层失败: ' + (e && e.message));
      state.hideDrawables = [];
    }
    try {
      globalThis.__dpDrawables = model.internalModel.coreModel._model.drawables;
      log('混合颜色 shader 已就绪（drawables=' + window.__dpDrawables.ids.length + '）');
    } catch (e) {
      log('混合颜色初始化失败: ' + (e && e.message));
    }
    // 记录各参数默认值（表情"关闭"时要写回这些值）
    try {
      const m = model.internalModel.coreModel._model || model.internalModel.coreModel;
      const ids = m.parameters.ids;
      const dv = m.parameters.defaultValues;
      const defs = {};
      for (let i = 0; i < ids.length; i++) defs[ids[i]] = dv[i];
      PROC.paramDefaults = defs;
    } catch (e) { log('读取参数默认值失败: ' + (e && e.message)); }
    state.info = info;
    buildExprTable();
    API.modelLoaded(info.id);
    try {
      const mm = info.motions || [];
      log('动作清单: ' + mm.length + ' 个 -> ' + mm.map((x) => x.group + '#' + x.index + ':' + x.name).join(' | '));
      state.info = info;
      if (new URLSearchParams(location.search).get('settings')) {
        setTimeout(() => openSettings(), 700);
      }
      if (new URLSearchParams(location.search).get('mpopen')) {
        setTimeout(() => { openMotionPicker(); selectMotion(2); }, 900);
      }
    } catch (e) { log('动作清单输出失败: ' + (e && e.message)); }
    log('已加载 ' + info.name + ' | 表情:' + JSON.stringify(info.expressions) + ' | 动作:' + JSON.stringify(info.motionGroups) + ' | 口型参数:' + lipParam);
    $('loading').classList.add('hidden');
  } catch (e) {
    log('加载失败：' + (e && e.stack ? e.stack : e));
    $('loading').textContent = '加载失败：' + (e && e.message ? e.message : e);
  }
}

function fitModel() {
  if (!model) return;
  const H = window.innerHeight;
  const W = window.innerWidth;
  const fill = Number(state.cfg.fill) || 0.84; // 模型大小只由用户控制
  const scale = Number(state.cfg.scale) || 1;
  const natural = model.internalModel.height || model.height || 1;
  const k = ((H * fill) / natural) * scale;
  state.baseK = k;
  model.scale.set(k * (1 + (PROC.scaleBoost || 0)));

  // 放大后允许平移浏览；平移量钳制，不会把角色拖出画面
  const mw = model.width;
  const mh = model.height;
  const maxPanY = Math.max(0, mh - H + 2);
  const maxPanX = Math.max(12, (mw - W) / 2 + 12);
  if (!state.pan) state.pan = { x: 0, y: 0 };
  // 自动取景：放大溢出时把镜头对准上半身（头顶对齐窗口顶部）
  // pan.y 约定：0 = 贴底（看脚），maxPanY = 顶对齐（看头）
  if (state.panAuto !== false) {
    state.pan.y = mh > H + 2 ? (mh - H + 2) : 0;
  }
  state.pan.x = Math.max(-maxPanX, Math.min(maxPanX, state.pan.x));
  state.pan.y = Math.max(0, Math.min(maxPanY, state.pan.y));

  model.x = W / 2 + state.pan.x;
  model.y = H + 2 + state.pan.y;
  updateScrollbars();
}

/** 放大到超出窗口时显示平移滚动条 */
function updateScrollbars() {
  const vb = $('vbar');
  const hb = $('hbar');
  if (!vb || !hb || !model) return;
  const W = window.innerWidth;
  const H = window.innerHeight;
  const mw = model.width;
  const mh = model.height;
  const canV = mh > H + 2;
  const canH = mw > W + 2;
  vb.classList.toggle('hidden', !canV);
  hb.classList.toggle('hidden', !canH);
  if (canV) {
    const trackH = Math.max(1, vb.clientHeight - 2);
    const thumbH = Math.max(24, Math.round(trackH * (H / mh)));
    const vt = $('vthumb');
    vt.style.height = thumbH + 'px';
    const maxPanY = mh - H + 2;
    // pan.y=0 看脚（滑块在底）；pan.y=maxPanY 看头（滑块在顶）
    const viewUp = maxPanY > 0 ? (state.pan.y / maxPanY) : 1;
    const posRatio = 1 - Math.max(0, Math.min(1, viewUp));
    vt.style.top = Math.round((trackH - thumbH) * posRatio) + 'px';
  }
  if (canH) {
    const trackW = Math.max(1, hb.clientWidth - 2);
    const thumbW = Math.max(24, Math.round(trackW * (W / mw)));
    const ht = $('hthumb');
    ht.style.width = thumbW + 'px';
    const maxPanX = Math.max(12, (mw - W) / 2 + 12);
    const ratio = (state.pan.x + maxPanX) / (2 * maxPanX || 1);
    ht.style.left = Math.round((trackW - thumbW) * Math.max(0, Math.min(1, ratio))) + 'px';
  }
}

// ------------------------------------------------------------------ 每帧
const HIDE_LIST = (() => { const v = new URLSearchParams(location.search).get('hide'); return v ? v.split(',').map(Number) : []; })();

function onTick() {
  if (!model) return;
  if (HIDE_LIST.length) {
    try {
      const dd = model.internalModel.coreModel._model.drawables;
      for (const i of HIDE_LIST) dd.opacities[i] = 0;
    } catch { /* ignore */ }
  }
  const now = performance.now();

  // 视线跟随：做动作/表情/说话/打字时不跟鼠标，否则眼神会乱飘显得诡异
  const nowMs = performance.now();
  const acting = PROC.behaviors.length > 0;
  const suppress = acting || nowMs < (PROC.focusPauseUntil || 0) || PROC.typingUntil > nowMs || state.speaking;
  if (suppress) {
    // 把视线拉回正前方（对着你），交给动作自己去控制眼球
    try {
      const b = model.getBounds();
      model.focus(b.x + b.width / 2, b.y + b.height * 0.08);
    } catch { /* ignore */ }
  } else {
    const idle = Date.now() - state.lastActivity > 4000;
    if (!idle && state.pointer.x > -1000) {
      model.focus(state.pointer.x, state.pointer.y);
    }
  }

  // 口型
  let level = 0;
  if (state.speaking && analyser && analyserData) {
    analyser.getByteTimeDomainData(analyserData);
    let sum = 0;
    for (let i = 0; i < analyserData.length; i++) {
      const v = (analyserData[i] - 128) / 128;
      sum += v * v;
    }
    level = Math.min(1, Math.sqrt(sum / analyserData.length) * 3.2);
  } else if (state.typing) {
    level = 0.12 + 0.35 * Math.abs(Math.sin(now / 90));
  }
  mouthLevel += (level - mouthLevel) * 0.45;
  if (mouthLevel > 0.02 && lipParam) {
    try { model.internalModel.coreModel.setParameterValueById(lipParam, mouthLevel); } catch { /* ignore */ }
  }
}

// ------------------------------------------------------------------ 设置面板

const $id = (x) => document.getElementById(x);

function openSettings() {
  const box = $id('settings');
  if (!box) return;
  box.classList.remove('hidden');
  state.settingsOpen = true;
  updateIgnoreMouse();
  refreshSettings();
}

function closeSettings() {
  const box = $id('settings');
  if (box) box.classList.add('hidden');
  state.settingsOpen = false;
  updateIgnoreMouse();
}

function toggleSettings(force) {
  const want = force === undefined ? !state.settingsOpen : !!force;
  if (want) openSettings(); else closeSettings();
}

/** 把当前 config 同步到面板控件 */
async function refreshSettings() {
  try {
    state.cfg = await API.getConfig();
    const b = state.cfg.behavior || {};
    const set = (id, v) => { const el = $id(id); if (el) el.checked = !!v; };
    set('set-b-emotion', b.emotionAction !== false);
    set('set-b-nod', b.nodRhythm !== false);
    set('set-b-multi', b.multiAction !== false);
    set('set-b-night', b.nightSleepy !== false);
    set('set-b-yawn', b.yawns !== false);
    set('set-b-look', b.lookAround !== false);
    set('set-b-turn', b.turnBeforeSpeak !== false);
    set('set-b-greet', b.greetOnStart !== false);
    set('set-chat-pinned', b.chatInputPinned !== false);
    const sel = $id('set-interaction');
    if (sel) sel.value = b.interactionChat || 'local';
    if (state.info) $id('set-model-name').textContent = '当前：' + state.info.name;
  } catch (e) { log('读取设置失败: ' + (e && e.message)); }
}

/** 行为开关 -> config.behavior.xxx */
function bindBehaviorToggle(id, key) {
  const el = $id(id);
  if (!el) return;
  el.addEventListener('change', async () => {
    const cfg = await API.getConfig();
    cfg.behavior = cfg.behavior || {};
    cfg.behavior[key] = el.checked;
    await API.setConfig({ behavior: cfg.behavior });
    state.cfg.behavior = cfg.behavior;
    applyBehaviorConfig();
    log('设置 ' + key + ' = ' + el.checked);
  });
}

function applyBehaviorConfig() {
  const b = (state.cfg && state.cfg.behavior) || {};
  PROC.on = b.enabled !== false;
  PROC.yawns = b.yawns !== false;
  PROC.lookAround = b.lookAround !== false;
  PROC.nightSleepy = b.nightSleepy !== false;
}

function bindSettings() {
  const on = (id, fn) => { const el = $id(id); if (el) el.addEventListener('click', fn); };
  on('btn-settings', () => API.openSettings());
  on('set-close', () => closeSettings());
  on('set-picker', () => { closeSettings(); togglePicker(true); });
  on('set-rescan', async () => { await rescan(); log('已刷新形象列表（' + (state.models || []).length + ' 个）'); });
  on('set-open-models', () => API.openModelsDir());
  on('set-motions', () => { closeSettings(); openMotionPicker(); });
  on('set-bigger', () => API.sizeStep(1.12));
  on('set-smaller', () => API.sizeStep(0.89));
  on('set-size-reset', () => API.sizeReset());
  on('set-collapse', () => { closeSettings(); API.collapse(); });
  on('set-top', () => {});
  const top = $id('set-top');
  if (top) {
    top.checked = !!(state.cfg && state.cfg.alwaysOnTop);
    top.addEventListener('change', () => API.setTop(top.checked));
  }
  on('set-say', () => { closeSettings(); toggleChat(true); });
  on('set-reconnect', () => { API.reconnectWs(); log('已请求重连 AstrBot'); });
  on('set-open-config', () => API.openConfig());
  on('set-quit', () => API.quit());

  bindBehaviorToggle('set-b-emotion', 'emotionAction');
  bindBehaviorToggle('set-b-nod', 'nodRhythm');
  bindBehaviorToggle('set-b-multi', 'multiAction');
  bindBehaviorToggle('set-b-night', 'nightSleepy');
  bindBehaviorToggle('set-b-yawn', 'yawns');
  bindBehaviorToggle('set-b-look', 'lookAround');
  bindBehaviorToggle('set-b-turn', 'turnBeforeSpeak');
  bindBehaviorToggle('set-b-greet', 'greetOnStart');

  const pinned = $id('set-chat-pinned');
  if (pinned) pinned.addEventListener('change', async () => {
    const cfg = await API.getConfig();
    cfg.behavior = cfg.behavior || {};
    cfg.behavior.chatInputPinned = pinned.checked;
    await API.setConfig({ behavior: cfg.behavior });
    state.cfg.behavior = cfg.behavior;
    toggleChat(pinned.checked, true);
  });

  const inter = $id('set-interaction');
  if (inter) inter.addEventListener('change', async () => {
    const cfg = await API.getConfig();
    cfg.behavior = cfg.behavior || {};
    cfg.behavior.interactionChat = inter.value;
    await API.setConfig({ behavior: cfg.behavior });
    state.cfg.behavior = cfg.behavior;
    log('戳互动模式 = ' + inter.value);
  });

  // AstrBot 连接状态同步到面板
  API.onWsStatus((st) => {
    const el = $id('set-ws');
    if (el) el.textContent = 'AstrBot：' + (st && st.clients > 0 ? '已连接（' + st.clients + '）' : '未连接');
  });
}


// ---------------------------------------------------------------- 参数级表情/外貌覆盖层
// 直接从 .exp3.json 的实参整理出来（参数名来自模型作者）
// 不同表情用不同参数就能叠加；共用同一参数的会自动互斥（由 faceConflicts 判定）
// 外观/表情表：**从模型自身的 .exp3.json 动态生成**（没有任何写死的表情名）
//   EXPR_TABLE[name] = { params: {参数: 值}, off: {参数: 关值} | null }
// off：若该参数默认值不是 0，关闭时要写回默认值（避免"关不掉"）
const EXPR_TABLE = {};

/** 由模型信息重建表情表；在模型加载后调用 */
function buildExprTable() {
  for (const k of Object.keys(EXPR_TABLE)) delete EXPR_TABLE[k];
  const details = (state.info && state.info.expressionDetails) || [];
  const defaults = PROC.paramDefaults || {};
  for (const d of details) {
    const params = d && d.params ? d.params : {};
    const ids = Object.keys(params);
    if (!ids.length) continue;
    // 关掉时：把参数写回模型默认值（多数是 0，个别服装参数默认值不是 0）
    const off = {};
    for (const id of ids) off[id] = Number(defaults[id] || 0);
    EXPR_TABLE[d.name] = { params, off };
  }
  log('已从模型解析表情表: ' + Object.keys(EXPR_TABLE).length + ' 个');
}

function exprParamsOf(name) {
  const t = EXPR_TABLE[String(name || '')];
  return t ? Object.assign({}, t.params) : null;
}

/** 判断某表情是否属于「外貌类」（改的是服装/道具/体型参数） */
function isAppearanceExpr(name) {
  const p = exprParamsOf(name);
  if (!p) return false;
  const ids = Object.keys(p);
  return ids.every((id) => /^(Clothes|Movement|Divider|Lean|Body)/i.test(id) || /^Clothes\d+$/i.test(id));
}

// 情绪 -> 面部表情：按模型里表情的**名字**做模糊匹配（不写死任何具体表情）
const EMOTION_KEYWORDS = {
  happy: ['happy', 'joy', 'smile', '笑', '开心', '爱心', 'heart'],
  sad: ['sad', 'cry', 'tear', '哭', '难过', '流泪', '悲'],
  angry: ['angry', 'anger', '怒', '生气', '黑脸'],
  surprised: ['surprise', 'shock', '惊', '圈圈'],
  shy: ['shy', 'blush', '脸红', '害羞'],
  thinking: ['think', '思考', '屑屑'],
  tired: ['tired', 'sleep', '困', '累', '哈欠'],
};

/** 找当前情绪在模型里对应的表情名（找不到就返回 null） */
function resolveEmotionExpr(emotion) {
  const key = String(emotion || '').toLowerCase();
  const names = Object.keys(EXPR_TABLE);
  if (!names.length) return null;
  const kw = EMOTION_KEYWORDS[key];
  if (kw) {
    for (const w of kw) {
      const hit = names.find((n) => String(n).toLowerCase().includes(w.toLowerCase()));
      if (hit) return hit;
    }
  }
  return null;
}

/** 合并所有生效的参数：外貌 < 面部开关 < 当前情绪 */
function collectOverrides() {
  const out = {};
  const ap = state.appearance || {};
  // 外貌开关：开、关都写确定值，避免残留
  for (const name of Object.keys(ap.look || {})) {
    const t = EXPR_TABLE[name];
    if (!t) continue;
    Object.assign(out, ap.look[name] ? t.params : t.off);
  }
  // 面部表情（可多选）
  for (const name of Object.keys(ap.face || {})) {
    if (!ap.face[name]) continue;
    const t = EXPR_TABLE[name];
    if (t) Object.assign(out, t.params);
  }
  // 情绪表情优先级最高
  const emoFace = resolveEmotionExpr(state.emotion);
  if (emoFace && state.emotionUntil > performance.now()) {
    const v = exprParamsOf(emoFace);
    if (v) Object.assign(out, v);
  }
  return out;
}

function applyParamOverrides() {
  if (!model) return;
  try {
    const cm = model.internalModel.coreModel;
    const ov = collectOverrides();
    // 先把上一次写过但这次不在集合里的参数还原
    for (const id of Object.keys(PROC.overrides || {})) {
      if (!(id in ov)) {
        try { cm.setParameterValueById(id, 0); } catch (e) { /* ignore */ }
      }
    }
    for (const [id, v] of Object.entries(ov)) {
      try { cm.setParameterValueById(id, v); } catch (e) { /* ignore */ }
    }
    PROC.overrides = ov;
    PROC.overrideBase = ov;   // 供 addParam 判断基准（这些参数每帧被重置）
  } catch (e) { /* ignore */ }
}

/** 判断某个面部表情是否与已启用的冲突（共享参数） */
function faceConflicts(name) {
  const mine = exprParamsOf(name);
  if (!mine) return [];
  const ap = state.appearance || {};
  const out = [];
  for (const other of Object.keys(ap.face || {})) {
    if (!ap.face[other] || other === name) continue;
    const theirs = exprParamsOf(other);
    if (!theirs) continue;
    if (Object.keys(mine).some((k) => k in theirs)) out.push(other);
  }
  return out;
}

function setFaceExpr(name, on) {
  state.appearance = state.appearance || {};
  state.appearance.face = state.appearance.face || {};
  if (on) {
    const conflicts = faceConflicts(name);
    for (const c of conflicts) state.appearance.face[c] = false;
    if (conflicts.length) log('表情 ' + name + ' 与 ' + conflicts.join('/') + ' 共用参数，已自动取消后者');
    state.appearance.face[name] = true;
  } else {
    state.appearance.face[name] = false;
  }
  saveAppearance();
  applyParamOverrides();
  log('面部表情 ' + name + ' = ' + (on ? '开' : '关'));
}

function setLookExpr(name, on) {
  state.appearance = state.appearance || {};
  state.appearance.look = state.appearance.look || {};
  state.appearance.look[name] = !!on;
  saveAppearance();
  applyParamOverrides();
  log('外貌 ' + name + ' = ' + (on ? '开' : '关'));
}

function setBodyExpr(name) {
  state.appearance = state.appearance || {};
  state.appearance.body = name;
  saveAppearance();
  applyParamOverrides();
  log('体型 = ' + name);
}

let appearanceSaveTimer = null;
function broadcastAppearance() {
  try { API.broadcastAppearance(state.appearance); } catch (e) { /* ignore */ }
}
function saveAppearance() {
  broadcastAppearance();
  clearTimeout(appearanceSaveTimer);
  appearanceSaveTimer = setTimeout(() => {
    API.setConfig({ appearance: state.appearance }).catch(() => {});
  }, 250);
}

// ------------------------------------------------------------------ 动作一览面板

/** 播放模型自带的某个动作 */
function playMotion(group, index, name) {
  try {
    if (!model) return;
    model.motion(group, Number(index) || 0, PIXI.live2d.MotionPriority.FORCE);
    log('▶ 播放动作 ' + group + '#' + index + (name ? ('  ' + name) : ''));
  } catch (e) {
    log('播放动作失败: ' + (e && e.message));
  }
}

let mpItems = [];
let mpSel = 0;

function openMotionPicker() {
  const list = (state.info && state.info.motions) || [];
  const box = $('motionpicker');
  const wrap = $('mp-list');
  if (!box || !wrap) return;
  wrap.innerHTML = '';
  mpItems = [];
  if (!list.length) {
    wrap.innerHTML = '<div class="mp-item">（这个模型没有动作文件）</div>';
    box.classList.remove('hidden');
    state.motionPickerOpen = true;
    updateIgnoreMouse();
    return;
  }
  let lastGroup = null;
  for (const m of list) {
    if (m.group !== lastGroup) {
      lastGroup = m.group;
      const g = document.createElement('div');
      g.className = 'mp-group';
      g.textContent = m.group;
      wrap.appendChild(g);
    }
    const row = document.createElement('div');
    row.className = 'mp-item';
    row.innerHTML = '<span class="mp-idx"></span><span class="mp-name"></span>';
    row.querySelector('.mp-idx').textContent = m.index;
    row.querySelector('.mp-name').textContent = m.name || ('动作 ' + m.index);
    row.addEventListener('click', () => {
      const idx = mpItems.findIndex((x) => x.row === row);
      if (idx >= 0) { mpSel = idx; highlightMotion(); }
      playMotion(m.group, m.index, m.name);
    });
    wrap.appendChild(row);
    mpItems.push({ group: m.group, index: m.index, name: m.name, row });
  }
  mpSel = 0;
  highlightMotion();
  box.classList.remove('hidden');
  state.motionPickerOpen = true;
  updateIgnoreMouse();
}

function closeMotionPicker() {
  const box = $('motionpicker');
  if (box) box.classList.add('hidden');
  state.motionPickerOpen = false;
  updateIgnoreMouse();
}

function highlightMotion() {
  mpItems.forEach((it, i) => it.row.classList.toggle('sel', i === mpSel));
  const cur = mpItems[mpSel];
  if (cur && cur.row.scrollIntoView) cur.row.scrollIntoView({ block: 'nearest' });
}

function selectMotion(i) {
  if (!mpItems.length) return;
  mpSel = (i + mpItems.length) % mpItems.length;
  highlightMotion();
}

window.addEventListener('keydown', (e) => {
  if (!state.motionPickerOpen) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowRight') { e.preventDefault(); selectMotion(mpSel + 1); return; }
  if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') { e.preventDefault(); selectMotion(mpSel - 1); return; }
  if (e.key === 'Enter') {
    e.preventDefault();
    const it = mpItems[mpSel];
    if (it) playMotion(it.group, it.index, it.name);
    return;
  }
  if (e.key === 'Escape') { e.preventDefault(); closeMotionPicker(); }
});

// ------------------------------------------------------------------ 程序化行为系统

/** 按情绪做一个动作；同一动作 0.9 秒内不重复触发，避免分段回复时抽搐 */
const lastActionAt = {};

// 动作 -> 模型自带手势动画索引（Gesture 组）
//  0 狗尾草出来 / 1 竖手指出来 / 2 举手切默认手(双手垂下) / 3 狗尾草切回 / 4 竖手指切回 / 5 默认手切举手
const GESTURE_FOR_ACTION = { shyBody: 2, joy: 5, ponder: 1, angry: 3 };   // 动作开始时播
const GESTURE_END_FOR_ACTION = { ponder: 4, angry: 4 };                  // 动作结束时收回

function playGesture(idx) {
  try {
    if (!model || !state.info) return;
    const groups = state.info.motionGroups || [];
    if (!groups.includes('Gesture')) return;
    model.motion('Gesture', idx, PIXI.live2d.MotionPriority.NORMAL);
  } catch { /* ignore */ }
}
function playEmotionAction(emotion) {
  const cfg = state.cfg.behavior || {};
  if (cfg.emotionAction === false) return;
  const act = EMOTION_ACTION[emotion] || 'ack';
  const now = performance.now();
  if (now - (lastActionAt[act] || 0) < 900) return;
  lastActionAt[act] = now;
  triggerBehavior(act);
  // 有些动作配一个模型自带的手势（比如害羞时双手垂下）
  if (GESTURE_FOR_ACTION[act] !== undefined) playGesture(GESTURE_FOR_ACTION[act]);
  // ⑤ 点头节奏：动作做完后再轻轻点一下头，像在回应你
  if (act !== 'ack' && (cfg.nodRhythm !== false)) {
    setTimeout(() => { try { triggerBehavior('ack', { dur: 0.8 }); } catch (e) { /* ignore */ } }, 750);
  }
  log('情绪动作: ' + emotion + ' -> ' + act);
}
// 所有「活起来」的效果都是直接驱动 Live2D 参数实现的，不依赖动作文件。
// 每个行为 = 一个带时长的函数，往本帧的偏移表里累加偏移；最后统一叠加到模型上。

const PARAM = {
  ax: 'ParamAngleX', ay: 'ParamAngleY', az: 'ParamAngleZ',
  bx: 'ParamBodyAngleX', bz: 'ParamBodyAngleZ',
  breath: 'ParamBreath',
  ex: 'ParamEyeBallX', ey: 'ParamEyeBallY',
  elo: 'ParamEyeLOpen', ero: 'ParamEyeROpen',
  mopen: 'ParamMouthOpenY', mform: 'ParamMouthForm',
  browL: 'ParamBrowLY', browR: 'ParamBrowRY',
  // 嘴部素材（这个模型嘴的部分很细）
  jaw: 'JawOpen',
  smileL: 'MouthSmile_L', smileR: 'MouthSmile_R',
  press: 'Press',
  pucker: 'Mouthpucker', funnel: 'MouthFunnel',
  puckerWide: 'MouthPuckerWiden',
  pressLipOpen: 'MouthPressLipOpen',
  rollUpper: 'MouthRollUpper', rollLower: 'MouthRollLower',
  tongue: 'TongueOut',
  mouthX: 'MouthX',
  cheekX: 'CheeksWiggleX',
  eyeSmile: 'EyeSmile',
};

const DUR = { nod: 1.1, tilt: 1.1, turn: 0.95, lookAround: 5.0, yawn: 2.8, dizzy: 2.6, angry: 1.6, stretch: 2.0, dodge: 1.3,
  joy: 1.5, droop: 2.2, recoil: 1.2, ponder: 1.8, shyTurn: 1.5, ack: 0.9,
  curious: 1.9, shyBody: 2.6, nuzzle: 1.4 };

// 情绪 -> 动作映射（每说一句话就按情绪动一下）
const EMOTION_OF_ACTION = {
  joy: 'happy', droop: 'sad', angry: 'angry', curious: 'surprised',
  shyBody: 'shy', ponder: 'thinking', ack: 'neutral', nuzzle: 'happy',
};

const EMOTION_ACTION = {
  happy: 'joy', sad: 'droop', angry: 'angry', surprised: 'curious',
  shy: 'shyBody', thinking: 'ponder', tired: 'droop', neutral: 'ack',
};

const PROC = {
  ready: false,
  on: true,
  intensity: 1,
  breathOn: true,
  headSway: true,
  bodySway: true,
  phase: 0,
  swayScale: 1,
  behaviors: [],
  sleepiness: 0,
  awakeUntil: 0,
  nextLook: 0,
  nextYawn: 0,
  lastCheck: 0,
  specialUntil: -1,
  typingUntil: 0,
  mouthOn: true,
  nextMouth: 0,
  mouthTimer: 0,
  mouthDur: 1,
  mouthKind: '',
  scaleBoost: 0,
};


const lastOffsets = new Map();

/** 叠加型参数写入：先扣掉上一帧自己写的偏移，避免累加到参数上限 */
function addParam(cm, id, delta) {
  try {
    const idx = cm.getParameterIndex(id);
    if (idx < 0) return;
    const cur = cm.getParameterValueById(id);
    if (typeof cur !== 'number' || Number.isNaN(cur)) return;
    const prev = lastOffsets.get(id) || 0;
    // 若这个参数每帧都被「外貌/表情覆盖层」重置，就以覆盖值为基准，否则会被重置打乱
    const inOverride = PROC.overrideBase && Object.prototype.hasOwnProperty.call(PROC.overrideBase, id);
    const base = inOverride ? (Number(PROC.overrideBase[id]) || 0) : (cur - prev);
    let min = -30, max = 30;
    try {
      min = cm.getParameterMinimumValueByIndex(idx);
      max = cm.getParameterMaximumValueByIndex(idx);
      if (!Number.isFinite(min)) min = -30;
      if (!Number.isFinite(max)) max = 30;
    } catch { /* 用默认 */ }
    const applied = Math.max(min, Math.min(max, base + delta));
    cm.setParameterValueById(id, applied, 1);
    lastOffsets.set(id, applied - base);
  } catch { /* ignore */ }
}

const bump = (off, id, v) => off.set(id, (off.get(id) || 0) + v);

/** 平滑插值：points = [{t, x}] */
function piece(points, t) {
  if (!points || !points.length) return 0;
  if (t <= points[0].t) return points[0].x;
  for (let i = 1; i < points.length; i++) {
    if (t <= points[i].t) {
      const a = points[i - 1], b = points[i];
      const span = b.t - a.t || 1;
      let u = (t - a.t) / span;
      u = u * u * (3 - 2 * u); // smoothstep
      return a.x + (b.x - a.x) * u;
    }
  }
  return points[points.length - 1].x;
}

const rand = (a, b) => a + Math.random() * (b - a);

function initProcedural() {
  const cfg = state.cfg.proceduralIdle || {};
  PROC.on = cfg.enabled !== false;
  PROC.breathOn = cfg.breath !== false;
  PROC.headSway = cfg.headSway !== false;
  PROC.bodySway = cfg.bodySway !== false;
  PROC.intensity = Number(cfg.intensity) || 1;
  PROC.amp = Number(state.cfg.behavior && state.cfg.behavior.amplitude) || 2.5;
  const bh = state.cfg.behavior || {};
  PROC.mouthOn = bh.idleMouth !== false;
  PROC.idleMouthMode = bh.idleMouthMode || 'auto';        // auto | smile | pucker | press | open | tongue | off
  PROC.idleMouthStrength = Number(bh.idleMouthStrength) || 0.7;
  PROC.behaviors = [];
  PROC.phase = 0;
  PROC.nextLook = 0;
  PROC.nextYawn = 0;
  PROC.ready = true;
  lastOffsets.clear();
  log('行为系统就绪: on=' + PROC.on + ' intensity=' + PROC.intensity +
    ' amp=' + PROC.amp + ' 嘴型=' + PROC.idleMouthMode + ' 强度=' + PROC.idleMouthStrength + ' mouthOn=' + PROC.mouthOn);
}

// ---------------- 昼夜：几点该困 ---------------- 
function computeSleepiness() {
  const d = new Date();
  const h = d.getHours() + d.getMinutes() / 60;
  let s = 0;
  if (h >= 22 || h < 2) s = 0.7;        // 22:00-02:00 犯困
  else if (h >= 2 && h < 5) s = 1.0;    // 02:00-05:00 最困
  else if (h >= 5 && h < 7.5) s = 0.55; // 天快亮
  else if (h >= 13 && h < 14.5) s = 0.32; // 午后犯困
  // 刚被互动过 -> 精神一会儿
  if (performance.now() < PROC.awakeUntil) s *= 0.25;
  return s;
}

function triggerBehavior(name, opts) {
  const o = opts || {};
  if (!PROC.ready || !PROC.on) return;
  if (state.cfg.behavior && state.cfg.behavior.enabled === false) return;
  PROC.behaviors = PROC.behaviors.filter((b) => b.name !== name);
  const dur = o.dur || DUR[name] || 1;
  PROC.behaviors.push({ name, t: 0, dur, data: o.data || {} });
  // 动作期间 + 结束后 1.2 秒内不跟鼠标
  PROC.focusPauseUntil = performance.now() + (dur + 1.2) * 1000;
}

function makeLookTargets() {
  const list = [];
  let t = 0.35;
  const n = 3 + Math.floor(Math.random() * 2);
  for (let i = 0; i < n; i++) {
    list.push({ t, x: rand(-16, 16), y: rand(-4, 5) });
    t += rand(0.7, 1.2);
  }
  list.push({ t: t + 0.5, x: 0, y: 0 });
  return { targets: list };
}

// ---------------- 各行为往偏移表里写什么 ----------------
function applyBehavior(b, off, k) {
  let scaleBoost = 0;
  const t = b.t;
  const p = Math.min(1, t / b.dur);
  const env = Math.sin(Math.PI * p); // 平滑进出用

  switch (b.name) {
    case 'nod': {
      const d = Math.exp(-t / 0.3);
      bump(off, PARAM.ay, -11 * d * Math.sin(t * 13));
      bump(off, PARAM.bx, 3.5 * d * Math.sin(t * 11));
      bump(off, PARAM.mopen, 0.32 * d);
      bump(off, PARAM.browL, 0.3 * d);
      bump(off, PARAM.browR, 0.3 * d);
      break;
    }
    case 'tilt': {
      const d = Math.exp(-t / 0.3);
      bump(off, PARAM.az, 9 * d * Math.sin(t * 9));
      bump(off, PARAM.ax, 6 * d * Math.sin(t * 7));
      bump(off, PARAM.mopen, 0.36 * d);
      bump(off, PARAM.mform, 0.25 * d);
      bump(off, PARAM.browL, 0.35 * d);
      break;
    }
    case 'turn': {
      // 听到消息：先眼神过去，再转头，再回正
      const look = piece([{ t: 0, x: 0 }, { t: 0.18, x: 1 }, { t: 0.62, x: 1 }, { t: b.dur, x: 0 }], t);
      bump(off, PARAM.ex, 0.55 * look);
      bump(off, PARAM.ey, -0.15 * look);
      bump(off, PARAM.ax, 11 * look * k);
      bump(off, PARAM.ay, -3 * look * k);
      bump(off, PARAM.az, 2.5 * look * k);
      bump(off, PARAM.browL, 0.15 * look);
      bump(off, PARAM.browR, 0.15 * look);
      break;
    }
    case 'lookAround': {
      const tg = b.data.targets || [{ t: 0, x: 0 }];
      const tx = piece(tg.map((q) => ({ t: q.t, x: q.x })), t);
      const ty = piece(tg.map((q) => ({ t: q.t, x: q.y })), t);
      bump(off, PARAM.ax, tx * k);
      bump(off, PARAM.ay, ty * k);
      bump(off, PARAM.az, tx * 0.12 * k);
      bump(off, PARAM.ex, (tx / 16) * 0.7);
      bump(off, PARAM.ey, (ty / 5) * 0.4);
      bump(off, PARAM.browL, 0.1 * env);
      bump(off, PARAM.browR, 0.1 * env);
      break;
    }
    case 'yawn': {
      // 张嘴 + 眯眼 + 仰头 + 身体后仰，像真的打了个哈欠
      const mouth = piece([{ t: 0, x: 0 }, { t: 0.45, x: 0.95 }, { t: 1.7, x: 0.85 }, { t: 2.3, x: 0.12 }, { t: b.dur, x: 0 }], t);
      const eyes = piece([{ t: 0, x: 0 }, { t: 0.4, x: -0.8 }, { t: 1.85, x: -0.85 }, { t: 2.4, x: -0.15 }, { t: b.dur, x: 0 }], t);
      bump(off, PARAM.mopen, mouth);
      bump(off, PARAM.mform, -0.4 * env);
      bump(off, PARAM.elo, eyes);
      bump(off, PARAM.ero, eyes);
      bump(off, PARAM.ay, 7 * env * k);
      bump(off, PARAM.ax, -2 * env * k);
      bump(off, PARAM.bx, -2.5 * env * k);
      bump(off, PARAM.browL, -0.35 * env);
      bump(off, PARAM.browR, -0.35 * env);
      break;
    }
    case 'dizzy': {
      // 被拖来拖去的晕：脑袋画圈
      bump(off, PARAM.az, 9 * Math.sin(t * 6) * env);
      bump(off, PARAM.ax, 7 * Math.sin(t * 4 + 1) * env);
      bump(off, PARAM.ay, 3 * Math.sin(t * 5 + 2) * env);
      break;
    }
    case 'angry': {
      // 被连续戳：甩头 + 皱眉 + 转身背对你
      const away = piece([{ t: 0, x: 0 }, { t: 0.25, x: 1 }, { t: b.dur - 0.45, x: 1 }, { t: b.dur, x: 0 }], t);
      bump(off, PARAM.bx, 22 * away * k);
      bump(off, PARAM.ax, 24 * away * k);       // 明显转头不理你
      bump(off, PARAM.ex, 0.8 * away);
      bump(off, PARAM.ax, 7 * Math.sin(t * 20) * env);
      bump(off, PARAM.az, 3 * Math.sin(t * 14) * env);
      bump(off, PARAM.browL, -0.6 * env);
      bump(off, PARAM.browR, -0.6 * env);
      bump(off, PARAM.mform, -0.5 * env);
      break;
    }
    case 'dodge': {
      // 生气后躲开你的手：往鼠标的反方向缩
      const dir = b.data.dir || 1;
      bump(off, PARAM.ax, -dir * 13 * env * k);
      bump(off, PARAM.az, dir * 8 * env * k);
      bump(off, PARAM.bx, -dir * 3.5 * env * k);
      bump(off, PARAM.ex, -dir * 0.85 * env);
      bump(off, PARAM.ey, -0.2 * env);
      bump(off, PARAM.mform, -0.45 * env);
      bump(off, PARAM.browL, -0.4 * env);
      bump(off, PARAM.browR, -0.5 * env);
      break;
    }
    case 'stretch': {
      bump(off, PARAM.ay, 5 * env);
      bump(off, PARAM.bx, -2 * env);
      bump(off, PARAM.elo, -0.35 * env);
      bump(off, PARAM.ero, -0.35 * env);
      break;
    }
    case 'joy': {
      // 开心：两下轻快的弹跳 + 眯眼笑
      const b = Math.abs(Math.sin(t * 7.5));
      scaleBoost = 0.05 * b * env;              // 上下弹跳用缩放模拟
      bump(off, PARAM.ay, 10 * b * env * k);
      bump(off, PARAM.by, 7 * b * env * k);     // 身体上下起伏
      bump(off, PARAM.az, 5 * Math.sin(t * 6) * env * k);
      bump(off, PARAM.bz, 3 * Math.sin(t * 6 + 0.5) * env * k);
      bump(off, PARAM.elo, -0.3 * env);
      bump(off, PARAM.ero, -0.3 * env);
      bump(off, PARAM.mopen, 0.3 * env);
      bump(off, PARAM.mform, 0.6 * env);
      bump(off, PARAM.jaw, 0.25 * env);
      bump(off, PARAM.smileL, 0.7 * env);        // 嘴角上扬
      bump(off, PARAM.smileR, 0.7 * env);
      bump(off, PARAM.browL, 0.35 * env);
      bump(off, PARAM.browR, 0.35 * env);
      break;
    }
    case 'droop': {
      // 难过 / 累：低头 + 身子塌 + 靠向一侧（像靠在肩上）
      const lean = piece([{ t: 0, x: 0 }, { t: b.dur * 0.45, x: 1 }, { t: b.dur, x: 0 }], t);
      scaleBoost = 0.03 * lean;
      bump(off, PARAM.bz, 10 * lean * k);
      bump(off, PARAM.az, 7 * lean * k);
      bump(off, PARAM.ay, -18 * env * k);       // 明显低头
      bump(off, PARAM.bx, 6 * env * k);
      bump(off, PARAM.bx, 3.0 * env * k);
      bump(off, PARAM.az, -3.5 * env * k);
      bump(off, PARAM.elo, -0.45 * env);
      bump(off, PARAM.ero, -0.45 * env);
      bump(off, PARAM.browL, -0.5 * env);
      bump(off, PARAM.browR, -0.5 * env);
      bump(off, PARAM.mform, -0.6 * env);
      bump(off, PARAM.press, 0.5 * env);          // 抿嘴
      bump(off, PARAM.rollLower, 0.3 * env);
      break;
    }
    case 'recoil': {
      // 惊讶：猛地后仰 + 睁大眼 + 张嘴
      const hit = piece([{ t: 0, x: 0 }, { t: 0.12, x: 1 }, { t: 0.5, x: 0.75 }, { t: b.dur, x: 0 }], t);
      bump(off, PARAM.ay, 9 * hit * k);
      bump(off, PARAM.bx, -4.5 * hit * k);
      bump(off, PARAM.ax, -3 * hit * k);
      bump(off, PARAM.elo, 0.12 * hit);
      bump(off, PARAM.ero, 0.12 * hit);
      bump(off, PARAM.mopen, 0.55 * hit);
      bump(off, PARAM.browL, 0.6 * hit);
      bump(off, PARAM.browR, 0.6 * hit);
      break;
    }
    case 'ponder': {
      // 思考：歪头看斜上方 + 抬一边眉毛
      bump(off, PARAM.az, 9 * env * k);
      bump(off, PARAM.ay, 5 * env * k);
      bump(off, PARAM.ax, 4 * env * k);
      bump(off, PARAM.ey, 0.45 * env);
      bump(off, PARAM.ex, -0.2 * env);
      bump(off, PARAM.browL, 0.45 * env);
      bump(off, PARAM.mform, -0.15 * env);
      bump(off, PARAM.pucker, 0.35 * env);        // 撅嘴思考
      bump(off, PARAM.mouthX, 0.3 * env);
      break;
    }
    case 'shyTurn': {
      // 害羞：歪头躲开视线 + 抿嘴
      bump(off, PARAM.az, -9 * env * k);
      bump(off, PARAM.ay, -6 * env * k);
      bump(off, PARAM.ax, -4 * env * k);
      bump(off, PARAM.ex, -0.7 * env);
      bump(off, PARAM.ey, -0.3 * env);
      bump(off, PARAM.mform, 0.3 * env);
      bump(off, PARAM.browL, 0.25 * env);
      bump(off, PARAM.browR, 0.15 * env);
      break;
    }
    case 'ack': {
      // 中性：轻轻点一下头，表示"听到了"
      const d = Math.exp(-t / 0.25);
      bump(off, PARAM.ay, -6 * d * Math.sin(t * 12));
      bump(off, PARAM.mform, 0.1 * env);
      break;
    }
    case 'curious': {
      // 好奇：整张脸凑近来看你（整体放大）+ 前倾 + 歪头 + 睁大眼
      const near = piece([{ t: 0, x: 0 }, { t: 0.35, x: 1 }, { t: b.dur - 0.5, x: 1 }, { t: b.dur, x: 0 }], t);
      scaleBoost = 0.13 * near;                  // 整体放大 => 脸凑近（前倾素材效果太诡异，已弃用）
      bump(off, PARAM.bx, 13 * near * k);        // 身体前倾
      bump(off, PARAM.az, 12 * near * k);        // 歪头
      bump(off, PARAM.ay, 7 * near * k);         // 抬头看你
      bump(off, PARAM.ax, -2 * near * k);
      bump(off, PARAM.elo, 0.1 * near);
      bump(off, PARAM.ero, 0.1 * near);
      bump(off, PARAM.ey, 0.15 * near);
      bump(off, PARAM.browL, 0.55 * near);
      bump(off, PARAM.browR, 0.55 * near);
      bump(off, PARAM.mform, -0.1 * near);
      bump(off, PARAM.funnel, 0.55 * near);       // 嘴成小 O 型（好奇）
      bump(off, PARAM.jaw, 0.18 * near);
      break;
    }
    case 'shyBody': {
      // 害羞：低头 + 双手下垂 + 身体左右轻摇
      const env2 = Math.sin(Math.PI * Math.min(1, t / b.dur));
      const sway = Math.sin(t * 4.6) * env2;     // 左右摇晃
      scaleBoost = -0.035 * env2;                // 缩一点点，显得怯
      bump(off, PARAM.ay, -16 * env2 * k);       // 低头
      bump(off, PARAM.az, -4 * env2 * k);
      bump(off, PARAM.bz, 9 * sway * k);         // 身体左右摇
      bump(off, PARAM.bx, 1.5 * sway * k);
      bump(off, PARAM.ax, 2 * sway * k);
      bump(off, PARAM.ex, -0.4 * env2);
      bump(off, PARAM.ey, -0.35 * env2);
      bump(off, PARAM.elo, -0.25 * env2);
      bump(off, PARAM.ero, -0.25 * env2);
      bump(off, PARAM.mform, 0.35 * env2);
      bump(off, PARAM.smileL, 0.4 * env2);
      bump(off, PARAM.smileR, 0.4 * env2);
      bump(off, PARAM.press, 0.25 * env2);
      bump(off, PARAM.browL, 0.2 * env2);
      break;
    }
    case 'nuzzle': {
      // 被摸头：头往手的方向蹭过去
      const dir = b.data.dir || 1;
      const reach = piece([{ t: 0, x: 0 }, { t: 0.3, x: 1 }, { t: 0.75, x: 0.9 }, { t: b.dur, x: 0 }], t);
      bump(off, PARAM.ax, dir * 10 * reach * k);
      bump(off, PARAM.az, dir * 6 * reach * k);
      bump(off, PARAM.ay, 3 * reach * k);
      bump(off, PARAM.ex, dir * 0.5 * reach);
      bump(off, PARAM.elo, -0.3 * reach);
      bump(off, PARAM.ero, -0.3 * reach);
      bump(off, PARAM.mform, 0.35 * reach);
      bump(off, PARAM.browL, 0.3 * reach);
      bump(off, PARAM.browR, 0.3 * reach);
      scaleBoost = 0.02 * reach;
      break;
    }
    default:
      break;
  }
  return scaleBoost;
}

// ---------------- 调度：什么时候该做什么 ----------------
function behaviorScheduler(nowMs, t) {
  if (nowMs - PROC.lastCheck < 400) return;
  PROC.lastCheck = nowMs;
  const cfg = (state.cfg.behavior) || {};
  if (cfg.enabled === false) return;
  PROC.sleepiness = computeSleepiness();
  const busy = PROC.behaviors.length > 0;
  const idleFor = Date.now() - state.lastActivity;

  // 夜里会打哈欠
  if (!busy && PROC.sleepiness > 0.55 && cfg.yawns !== false && nowMs > PROC.nextYawn) {
    triggerBehavior('yawn');
    PROC.nextYawn = nowMs + rand(70, 150) * 1000;
    return;
  }
  // 很久没人理 -> 东张西望
  if (!busy && cfg.lookAround !== false && idleFor > 90000 && nowMs > PROC.nextLook) {
    triggerBehavior('lookAround', { data: makeLookTargets() });
    PROC.nextLook = nowMs + rand(20, 45) * 1000;
    return;
  }
  // 很困的时候偶尔打个盹（点头）
  if (!busy && PROC.sleepiness > 0.45 && Math.random() < 0.012) {
    triggerBehavior('nod', { dur: 1.4 });
  }
}

// ---------------- 每帧汇总 ----------------
function postTick() {
  if (!model || !PROC.ready || !PROC.on) return;
  const cm = model.internalModel.coreModel;
  const dt = Math.min(0.1, (app.ticker.deltaMS || 16.7) / 1000);
  PROC.phase += dt;
  const t = PROC.phase;
  const nowMs = performance.now();
  const k = PROC.intensity * PROC.swayScale * (PROC.amp || 1);   // amp: 动作幅度倍率
  const off = new Map();

  behaviorScheduler(nowMs, t);

  // 基础微动
  if (PROC.breathOn) {
    const period = 4.2 + 2.2 * PROC.sleepiness; // 困了呼吸更慢
    const breath = 0.5 + 0.5 * Math.sin((t * Math.PI * 2) / period);
    try { cm.setParameterValueById(PARAM.breath, breath, 1); } catch { /* ignore */ }
  }
  if (PROC.headSway) {
    bump(off, PARAM.ax, (3.0 * Math.sin(t / 3.1) + 1.2 * Math.sin(t / 1.7 + 0.6)) * k);
    bump(off, PARAM.ay, (2.2 * Math.sin(t / 4.3 + 1.2) + 0.8 * Math.sin(t / 2.2)) * k);
    bump(off, PARAM.az, 1.5 * Math.sin(t / 5.4 + 0.5) * k);
  }
  if (PROC.bodySway) {
    bump(off, PARAM.bx, 1.6 * Math.sin(t / 6.1) * k);
    bump(off, PARAM.bz, 1.1 * Math.sin(t / 7.3 + 0.9) * k);
  }
  bump(off, PARAM.ex, 0.12 * Math.sin(t / 2.7) * k);
  bump(off, PARAM.ey, 0.09 * Math.sin(t / 3.9 + 1.1) * k);

  // ---- 待机嘴部 ----
  const mouthMode = PROC.idleMouthMode || 'auto';
  if (PROC.mouthOn !== false && mouthMode !== 'off' && !state.speaking) {
    const breathPhase = 0.5 + 0.5 * Math.sin((t * Math.PI * 2) / 4.2);
    const st = PROC.idleMouthStrength || 0.7;
    if (mouthMode === 'auto') {
      // 自动：呼吸微开合 + 随机小动作
      bump(off, PARAM.mopen, 0.015 + 0.03 * breathPhase);
    } else {
      // 固定嘴型：一直保持（带一点呼吸起伏，避免僵死）
      const wob = 1 + 0.06 * Math.sin(t / 2.3);
      if (mouthMode === 'smile') {
        bump(off, PARAM.smileL, st * wob);
        bump(off, PARAM.smileR, st * wob);
        bump(off, PARAM.mform, 0.45 * st);
        bump(off, PARAM.mopen, 0.02 * st);
      } else if (mouthMode === 'pucker') {
        bump(off, PARAM.pucker, st * wob);
        bump(off, PARAM.puckerWide, -0.25 * st);
        bump(off, PARAM.mform, 0.1 * st);
      } else if (mouthMode === 'press') {
        bump(off, PARAM.press, st * wob);
        bump(off, PARAM.mform, 0.12 * st);
      } else if (mouthMode === 'open') {
        bump(off, PARAM.jaw, 0.3 * st * wob);
        bump(off, PARAM.mopen, 0.12 * st);
      } else if (mouthMode === 'tongue') {
        bump(off, PARAM.tongue, st * wob);
        bump(off, PARAM.jaw, 0.2 * st);
      } else if (mouthMode === 'smirk') {
        bump(off, PARAM.smileL, st * wob);          // 单边嘴角（坏笑）
        bump(off, PARAM.mform, 0.3 * st);
        bump(off, PARAM.mouthX, 0.15 * st);
      }
    }
    if (mouthMode === 'auto' && PROC.mouthTimer > 0) {
      // 正在做一次随机嘴部小动作（抿嘴/鼓嘴/咧嘴/微张）
      PROC.mouthTimer -= dt;
      const p0 = 1 - PROC.mouthTimer / PROC.mouthDur;   // 0..1
      const e = Math.sin(Math.PI * Math.max(0, Math.min(1, p0)));
      const kind = PROC.mouthKind || 'press';
      if (kind === 'press') { bump(off, PARAM.press, 0.5 * e); bump(off, PARAM.mform, 0.15 * e); }
      else if (kind === 'pucker') { bump(off, PARAM.pucker, 0.5 * e); bump(off, PARAM.puckerWide, -0.2 * e); }
      else if (kind === 'smile') { bump(off, PARAM.smileL, 0.5 * e); bump(off, PARAM.smileR, 0.5 * e); bump(off, PARAM.mform, 0.3 * e); }
      else if (kind === 'open') { bump(off, PARAM.jaw, 0.25 * e); bump(off, PARAM.mopen, 0.12 * e); }
      else if (kind === 'tongue') { bump(off, PARAM.tongue, 0.5 * e); bump(off, PARAM.jaw, 0.2 * e); }
      else if (kind === 'roll') { bump(off, PARAM.rollLower, 0.45 * e); }
    } else if (mouthMode === 'auto' && nowMs > (PROC.nextMouth || 0)) {
      // 每隔 4~11 秒来一次小动作
      const pool = ['press', 'press', 'smile', 'pucker', 'open', 'roll', 'pucker', 'smile', 'open', 'press', 'roll', 'tongue'];
      PROC.mouthKind = pool[Math.floor(Math.random() * pool.length)];
      PROC.mouthDur = 0.9 + Math.random() * 1.1;
      PROC.mouthTimer = PROC.mouthDur;
      PROC.nextMouth = nowMs + (4000 + Math.random() * 7000);
      if (window.__probeBehavior) log('嘴部小动作: ' + PROC.mouthKind);
    }
  }
  // 情绪动作也会带嘴型（各 case 里 bump 过），这里的待机微动会被它们叠加

  // 困意：眼睛半闭 + 微微垂头 + 身子塌一点
  if (PROC.sleepiness > 0.01) {
    const s = PROC.sleepiness;
    bump(off, PARAM.elo, -0.45 * s);
    bump(off, PARAM.ero, -0.45 * s);
    bump(off, PARAM.ay, -1.8 * s);
    bump(off, PARAM.bx, 1.2 * s);
    bump(off, PARAM.browL, -0.12 * s);
    bump(off, PARAM.browR, -0.12 * s);
  }

  // 被拖动时的惯性：身体和头往后甩，松手后余波
  if (Math.abs(state.dragVel || 0) > 0.4) {
    const v = Math.max(-11, Math.min(11, state.dragVel * 0.24));
    bump(off, PARAM.az, -v);
    bump(off, PARAM.ax, -v * 0.75);
    bump(off, PARAM.bx, -v * 0.5);
    bump(off, PARAM.ex, -v * 0.05);
    bump(off, PARAM.elo, -Math.min(0.25, Math.abs(v) * 0.02));
    bump(off, PARAM.ero, -Math.min(0.25, Math.abs(v) * 0.02));
  }
  state.dragVel = (state.dragVel || 0) * 0.86;

  // 你在输入框打字：歪头低头看着输入框，偶尔偏一下
  if (nowMs < PROC.typingUntil) {
    const w = Math.sin(t * 2.3) * 1.6;
    bump(off, PARAM.az, -6.5 + w);
    bump(off, PARAM.ax, 2.8 + w * 0.4);
    bump(off, PARAM.ay, -4.5);
    bump(off, PARAM.ex, 0.25);
    bump(off, PARAM.ey, -0.45);
    bump(off, PARAM.browL, 0.18);
    bump(off, PARAM.browR, 0.18);
    bump(off, PARAM.mform, 0.12);
  }

  // 行为
  let targetScale = 0;
  for (let i = PROC.behaviors.length - 1; i >= 0; i--) {
    const b = PROC.behaviors[i];
    targetScale += applyBehavior(b, off, k) || 0;
    b.t += dt;
    if (b.t >= b.dur) PROC.behaviors.splice(i, 1);
  }
  // 整体缩放平滑过渡（凑近 / 缩小）
  PROC.scaleBoost = (PROC.scaleBoost || 0) + (targetScale - (PROC.scaleBoost || 0)) * 0.18;
  if (model && state.baseK && Math.abs((model.scale.x / state.baseK) - (1 + PROC.scaleBoost)) > 0.0015) {
    model.scale.set(state.baseK * (1 + PROC.scaleBoost));
  }

  PROC.swayScale = t < PROC.specialUntil ? 0.3 : 1;

  // 参数级表情/外貌覆盖先写（作为基准），行为偏移再叠加在其上
  applyParamOverrides();

  // 上一帧写过、这一帧不再驱动的参数：写一次 0 偏移把它还原，否则会一直卡在最后的值
  for (const id of Array.from(lastOffsets.keys())) {
    if (!off.has(id)) {
      addParam(cm, id, 0);
      lastOffsets.delete(id);
    }
  }

  for (const [id, delta] of off) {
    if (Math.abs(delta) > 0.0005) addParam(cm, id, delta);
  }

  // 兜底：渲染目标（遮罩缓冲）必须用 LINEAR，否则会采样到空 mip 层变黑
  if (window.__glRenderTargets && window.__glRenderTargets.size && (__pc % 20 === 0)) {
    try {
      const gl2 = app.renderer.gl;
      for (const t2 of window.__glRenderTargets) {
        gl2.bindTexture(gl2.TEXTURE_2D, t2);
        gl2.texParameteri(gl2.TEXTURE_2D, gl2.TEXTURE_MIN_FILTER, gl2.LINEAR);
      }
    } catch { /* ignore */ }
  }

  // 隐藏混合色异常图层（core 每帧会重算 opacity，所以要每帧写一次）
  if (state.hideDrawables && state.hideDrawables.length) {
    try {
      const dd = model.internalModel.coreModel._model.drawables;
      for (const i of state.hideDrawables) dd.opacities[i] = 0;
    } catch { /* ignore */ }
  }

  if (window.__probeBehavior) {
    try {
      API.log('PROBE t=' + t.toFixed(2) + ' sleep=' + PROC.sleepiness.toFixed(2) +
        ' behaviors=' + PROC.behaviors.map((b) => b.name).join('+') +
        ' AngleX=' + cm.getParameterValueById(PARAM.ax).toFixed(2) +
        ' AngleY=' + cm.getParameterValueById(PARAM.ay).toFixed(2) +
        ' AngleZ=' + cm.getParameterValueById(PARAM.az).toFixed(2) +
        ' Mouth=' + cm.getParameterValueById(PARAM.mopen).toFixed(2) + ' Form=' + cm.getParameterValueById(PARAM.mform).toFixed(2) + ' Press=' + (function(){try{return cm.getParameterValueById(PARAM.press).toFixed(2);}catch(e){return'?';}})() + ' Smile=' + (function(){try{return cm.getParameterValueById(PARAM.smileL).toFixed(2);}catch(e){return'?';}})() +
        ' EyeOpen=' + cm.getParameterValueById(PARAM.elo).toFixed(2) + ' Scale=' + (state.baseK ? (model.scale.x / state.baseK).toFixed(3) : '?'));
    } catch { /* ignore */ }
  }
}

// ------------------------------------------------------------------ 互动上报
/**
 * 互动（戳/摸/拖）怎么处理，由 config.behavior.interactionChat 决定：
 *   "local"  -> 只在气泡里显示动作文字，不发消息、不让 AI 回（默认）
 *   "astrbot"-> 作为一条用户消息发给 AstrBot，让 AI 回应并记进对话
 *   "off"    -> 什么都不做，只播动画
 */
function reportInteraction(kind, text, extra) {
  const cfg = state.cfg.behavior || {};
  const mode = cfg.interactionChat || 'local';
  if (mode === 'off') return;
  if (mode === 'astrbot') {
    API.wsSend(Object.assign({ type: 'interaction', kind, text }, extra || {}));
    return;
  }
  log('动作气泡: ' + text);
  showBubble(text, { instant: true, ttlMs: 3400, action: true });
}

// ------------------------------------------------------------------ 互动
function hitTest(x, y) {
  if (!model) return [];
  const im = model.internalModel;
  try {
    if (im && typeof im.hitTest === 'function') return im.hitTest(x, y) || [];
  } catch { /* ignore */ }
  try {
    if (typeof model.hitTest === 'function') return model.hitTest(x, y) || [];
  } catch { /* ignore */ }
  return [];
}

function overModel(x, y) {
  if (!model) return false;
  const b = model.getBounds();
  const pad = 14;
  return x >= b.x - pad && x <= b.x + b.width + pad && y >= b.y - pad && y <= b.y + b.height + pad;
}

function playTapMotion(areas) {
  if (!model || !state.info) return;
  const isHead = !!(areas && areas.some((a) => /head|头/i.test(a)));
  // 模型自带的动作都是「切手势/道具」，不适合当点击反馈，
  // 这里用参数驱动一个短促自然的反应，并配合表情。
  // 摸头 -> 头往手那边蹭过去；戳身体 -> 点头惊一下
  if (isHead) {
    let dir = 1;
    try {
      const b = model.getBounds();
      dir = state.pointer.x < b.x + b.width / 2 ? -1 : 1;
    } catch { /* ignore */ }
    triggerBehavior('nuzzle', { data: { dir } });
  } else {
    triggerBehavior('nod', { dur: 1.2 });
  }
  setEmotion(isHead ? 'shy' : 'surprised', 2600);
  PROC.awakeUntil = performance.now() + 15000;
}

const inUi = (e) => !!(e.target && e.target.closest && e.target.closest('#chat, #picker, #vbar, #hbar'));

// ---- 放大后平移：Alt+左键 / 中键拖拽 ----
let panDrag = null;
function startPan(e) {
  state.panAuto = false;
  panDrag = { sx: e.screenX, sy: e.screenY, px: state.pan.x, py: state.pan.y };
  state.panning = true;
}
function movePan(e) {
  if (!panDrag) return;
  state.pan.x = panDrag.px + (e.screenX - panDrag.sx);
  state.pan.y = panDrag.py + (e.screenY - panDrag.sy);
  fitModel();
}
function endPan() { panDrag = null; state.panning = false; updateScrollbars(); }

// 滚动条拖拽
function bindScrollbars() {
  const vb = $('vbar'), hb = $('hbar');
  let dragging = null;
  const move = (e) => {
    if (!dragging || !model) return;
    const H = window.innerHeight, W = window.innerWidth;
    if (dragging.axis === 'v') {
      const trackH = vb.clientHeight - 2;
      const thumbH = $('vthumb').offsetHeight;
      const maxPanY = Math.max(1, model.height - H + 2);
      const dy = e.clientY - dragging.startY;
      const ratio = dy / Math.max(1, trackH - thumbH);
      // 滑块往下拖 → 看下面的内容 → pan.y 减小（趋近 0）
      state.pan.y = Math.max(0, Math.min(maxPanY, dragging.startPan - ratio * maxPanY));
    } else {
      const trackW = hb.clientWidth - 2;
      const thumbW = $('hthumb').offsetWidth;
      const maxPanX = Math.max(10, (model.width - W) / 2 + 10);
      const dx = e.clientX - dragging.startX;
      const ratio = dx / Math.max(1, trackW - thumbW);
      state.pan.x = Math.max(-maxPanX, Math.min(maxPanX, dragging.startPan + ratio * 2 * maxPanX));
    }
    fitModel();
  };
  const up = () => { dragging = null; };
  vb.addEventListener('mousedown', (e) => {
    e.preventDefault(); e.stopPropagation();
    state.panAuto = false;
    dragging = { axis: 'v', startY: e.clientY, startPan: state.pan.y };
  });
  hb.addEventListener('mousedown', (e) => {
    e.preventDefault(); e.stopPropagation();
    state.panAuto = false;
    dragging = { axis: 'h', startX: e.clientX, startPan: state.pan.x };
  });
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
  // 拖动时保持可交互
  for (const el of [vb, hb]) {
    el.addEventListener('mouseenter', () => { state.barHover = true; updateIgnoreMouse(); });
    el.addEventListener('mouseleave', () => { state.barHover = false; updateIgnoreMouse(); });
  }
}

function onPointerDown(e) {
  if (inUi(e)) return;
  // Alt + 左键 或 中键 = 平移角色（放大后浏览全身），不移动窗口
  if ((e.button === 0 && e.altKey) || e.button === 1) {
    e.preventDefault();
    startPan(e);
    return;
  }
  if (e.button !== 0) return;
  state.downAt = { x: e.screenX, y: e.screenY, cx: e.clientX, cy: e.clientY };
  state.moved = 0;
  state.dragging = true;
  API.dragStart({ screenX: e.screenX, screenY: e.screenY });
}

function onPointerMove(e) {
  state.pointer.x = e.clientX;
  state.pointer.y = e.clientY;
  state.lastActivity = Date.now();
  if (inUi(e)) return;
  if (panDrag) { movePan(e); return; }
  if (state.dragging && state.downAt) {
    const dx = Math.abs(e.screenX - state.downAt.x);
    const dy = Math.abs(e.screenY - state.downAt.y);
    state.moved = Math.max(state.moved, dx + dy);
    API.dragMove({ screenX: e.screenX, screenY: e.screenY });
  }
  // 生气中：手一靠近就躲开
  if (model && performance.now() < state.angryUntil && overModel(e.clientX, e.clientY)) {
    const nowMs = performance.now();
    if (nowMs > state.nextDodge) {
      const b = model.getBounds();
      const dir = e.clientX < (b.x + b.width / 2) ? 1 : -1; // 手在左边就往右躲
      triggerBehavior('dodge', { data: { dir } });
      state.nextDodge = nowMs + 2200;
    }
  }

  updateIgnoreMouse();
}

function onPointerUp(e) {
  if (inUi(e)) { state.dragging = false; state.downAt = null; API.dragEnd(); return; }
  const wasDrag = state.moved > 6;
  state.dragging = false;
  state.downAt = null;
  API.dragEnd();
  if (wasDrag) {
    state.dragDist = (state.dragDist || 0) + state.moved;
    if (state.dragDist > 260) {
      triggerBehavior('dizzy');
      setEmotion('surprised', 2600);
      state.dragDist = 0;
    }
    reportInteraction('drag', '（你被挪到了别的位置）');
    return;
  }
  if (!overModel(e.clientX, e.clientY)) return;
  const areas = hitTest(e.clientX, e.clientY);
  if (!areas.length && !overModel(e.clientX, e.clientY)) return;
  // 2 秒内连戳 4 下 -> 生气
  const nowMs = performance.now();
  state.tapTimes = (state.tapTimes || []).filter((x) => nowMs - x < 2000);
  state.tapTimes.push(nowMs);
  if (state.tapTimes.length >= 4) {
    state.tapTimes = [];
    state.angryUntil = performance.now() + 9000;
    triggerBehavior('angry');
    setEmotion('angry', 3000);
    reportInteraction('pat', '（被连着戳了好几下，有点生气了）', { area: 'head' });
    return;
  }
  playTapMotion(areas);
  const area = areas[0] || 'body';
  const isHead = /head|头/i.test(area);
  reportInteraction('pat', isHead ? '（摸了摸你的头）' : '（戳了戳你）', { area });
}

function updateIgnoreMouse() {
  const interactive =
    state.chatOpen ||
    state.pickerOpen ||
    state.gripHover ||
    state.dockHover ||
    state.barHover ||
    state.motionPickerOpen ||
    state.settingsOpen ||
    state.panning ||
    (model && overModel(state.pointer.x, state.pointer.y));
  API.setIgnoreMouse(!interactive);
}

// ---- 右下角拖拽缩放窗口 ----
function bindGrip() {
  const grip = $('grip');
  let resizing = false;
  grip.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    resizing = true;
    state.gripHover = true;
    updateIgnoreMouse();
    API.resizeStart({ screenX: e.screenX, screenY: e.screenY });
  });
  window.addEventListener('mousemove', (e) => {
    if (!resizing) return;
    API.resizeMove({ screenX: e.screenX, screenY: e.screenY });
  });
  window.addEventListener('mouseup', () => {
    if (!resizing) return;
    resizing = false;
    API.resizeEnd();
    updateIgnoreMouse();
  });
  grip.addEventListener('mouseenter', () => { state.gripHover = true; updateIgnoreMouse(); });
  grip.addEventListener('mouseleave', () => { state.gripHover = false; updateIgnoreMouse(); });
}

// ---- 悬浮控制条：置顶 / 收起 ----
function paintPin(on) {
  const b = $('btn-pin');
  if (!b) return;
  b.classList.toggle('pinned', !!on);
  b.classList.toggle('off', !on);
  b.title = on ? '当前：始终置顶（点击取消）' : '当前：不置顶（点击置顶）';
}

function bindDock() {
  $('btn-chat').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleChat(!state.chatOpen);
  });
  $('btn-pin').addEventListener('click', (e) => {
    e.stopPropagation();
    API.toggleTop();
  });
  $('btn-collapse').addEventListener('click', (e) => {
    e.stopPropagation();
    API.collapse();
  });
  for (const id of ['btn-chat', 'btn-pin', 'btn-collapse', 'btn-settings']) {
    const el = $(id);
    el.addEventListener('mouseenter', () => { state.dockHover = true; updateIgnoreMouse(); });
    el.addEventListener('mouseleave', () => { state.dockHover = false; updateIgnoreMouse(); });
  }
  API.onTopState((on) => { state.cfg.alwaysOnTop = on; paintPin(on); });
  paintPin(state.cfg && state.cfg.alwaysOnTop);
}

window.addEventListener('mousedown', onPointerDown);
window.addEventListener('mousemove', onPointerMove);
window.addEventListener('mouseup', onPointerUp);
window.addEventListener('wheel', (e) => {
  // Shift + 滚轮 = 上下平移浏览（放大后看全身）
  if (e.shiftKey && model) {
    state.panAuto = false;
    const maxPanY = Math.max(0, model.height - window.innerHeight + 2);
    state.pan.y = Math.max(0, Math.min(maxPanY, state.pan.y - (e.deltaY > 0 ? 40 : -40)));
    fitModel();
    return;
  }
  // Ctrl + 滚轮 = 缩放整个窗口；普通滚轮 = 只缩放模型
  if (e.ctrlKey) {
    API.sizeStep(e.deltaY > 0 ? 0.94 : 1.06);
    return;
  }
  if (!model) return;
  const next = clamp((Number(state.cfg.scale) || 1) * (e.deltaY > 0 ? 0.95 : 1.05), 0.3, 3);
  state.cfg.scale = next;
  state.panAuto = true;   // 缩放后重新自动取景（默认看上半身）
  fitModel();
  API.setConfig({ scale: next });
}, { passive: true });
window.addEventListener('dblclick', (e) => { if (overModel(e.clientX, e.clientY)) toggleChat(true); });

// ------------------------------------------------------------------ 表情
function setEmotion(emotion, holdMs) {
  if (!model) return;
  state.emotion = String(emotion || 'neutral').toLowerCase();
  state.emotionUntil = performance.now() + (holdMs || 0);
  clearTimeout(emotionTimer);
  if (holdMs) emotionTimer = setTimeout(() => resetEmotion(), holdMs);
  applyParamOverrides();
  const face = resolveEmotionExpr(state.emotion);
  if (face) log('情绪表情 ' + state.emotion + ' -> ' + face);
}

function resetEmotion() {
  if (!model) return;
  state.emotion = null;
  state.emotionUntil = 0;
  applyParamOverrides();
}

// ------------------------------------------------------------------ 气泡 / 打字机
function positionBubble() {
  const bubble = $('bubble');
  if (bubble.classList.contains('hidden')) return;
  const W = window.innerWidth;
  const H = window.innerHeight;

  // 模型与「脸部区域」估算
  let cx = W / 2, top = H * 0.08, mw = W * 0.7, mh = H * 0.7;
  if (model) {
    const b = model.getBounds();
    cx = b.x + b.width / 2;
    top = b.y;
    mw = b.width;
    mh = b.height;
  }
  const faceW = Math.max(96, mw * 0.32);
  const faceL = cx - faceW / 2;
  const faceR = cx + faceW / 2;
  const faceT = top + mh * 0.06;
  const faceB = top + mh * 0.32;

  const leftGap = faceL - 4;          // 从窗口左边缘到脸的可用宽度
  const rightGap = W - faceR - 4;
  const side = leftGap >= rightGap ? 'left' : 'right';
  const gap = Math.max(leftGap, rightGap);

  // 气泡可以更宽：上限 300px，但宽度仍不超过「窗口边缘到脸」的空间
  const maxW = Math.min(300, Math.max(120, Math.floor(gap) - 8));
  bubble.style.maxWidth = maxW + 'px';
  const bw = bubble.offsetWidth;
  const bh = bubble.offsetHeight;

  let x, y;
  if (gap >= 110) {
    // 贴窗口边缘（离脸最远的"旁边"位置），与脸同高
    x = side === 'left' ? 4 : W - bw - 4;
    y = clamp(faceT + 8, 4, Math.max(4, H - bh - 4));
  } else {
    // 太窄：挪到脸下方，横向贴边，可以放宽到整个窗口
    bubble.style.maxWidth = Math.min(300, W - 12) + 'px';
    const w2 = bubble.offsetWidth;
    x = side === 'left' ? 4 : W - w2 - 4;
    y = clamp(faceB + 10, 4, Math.max(4, H - bubble.offsetHeight - 4));
  }
  bubble.style.left = clamp(x, 4, Math.max(4, W - bubble.offsetWidth - 4)) + 'px';
  bubble.style.top = y + 'px';
  bubble.classList.toggle('tail-r', side === 'left');
  bubble.classList.toggle('tail-l', side === 'right');
}

/** 往气泡里插图片（多张纵向排列） */
function insertImages(bubble, box, imgs) {
  let imgBox = bubble.querySelector('.bubble-imgs');
  if (!imgBox) {
    imgBox = document.createElement('div');
    imgBox.className = 'bubble-imgs';
    bubble.insertBefore(imgBox, box);
  }
  for (const im of imgs) {
    const el = document.createElement('img');
    el.className = 'bubble-img';
    el.alt = '图片';
    el.src = im.data || im.url || '';
    el.addEventListener('load', () => positionBubble());
    el.addEventListener('error', () => { el.remove(); positionBubble(); });
    imgBox.appendChild(el);
  }
  positionBubble();
}

/** 把新内容追加到当前气泡（AstrBot 常把一段话拆成多条发，避免互相顶掉） */
function appendBubble(text, images) {
  const bubble = $('bubble');
  const box = $('bubble-text');
  if (!state.bubbleVisible) return false;
  bubble.classList.remove('hidden');
  if (text) {
    box.textContent = box.textContent ? box.textContent + String.fromCharCode(10) + text : text;
  }
  if (images && images.length) insertImages(bubble, box, images);
  bubble.classList.toggle('no-text', !box.textContent);
  state.bubbleAt = Date.now();
  clearTimeout(bubbleTimer);
  bubbleTimer = setTimeout(hideBubble, state.cfg.bubble.ttlMs || 15000);
  positionBubble();
  return true;
}

function showBubble(text, opts) {
  const o = opts || {};
  const bubble = $('bubble');
  const box = $('bubble-text');
  bubble.classList.remove('hidden');
  bubble.classList.toggle('act', !!o.action);

  // 图片：插在文字上方，加载完再重新定位气泡
  const imgs = o.images || [];
  const imgBoxOld = bubble.querySelector('.bubble-imgs');
  if (imgBoxOld) imgBoxOld.remove();
  if (imgs.length) insertImages(bubble, box, imgs);
  bubble.classList.toggle('no-text', !text);
  state.bubbleAt = Date.now();
  clearTimeout(bubbleTimer);
  clearInterval(typeTimer);
  state.typing = true;
  state.bubbleVisible = true;

  if (o.instant) {
    box.textContent = text || '';
    state.typing = false;
    positionBubble();
    bubbleTimer = setTimeout(hideBubble, o.ttlMs || state.cfg.bubble.ttlMs || 15000);
    return;
  }

  if (!text) {
    state.typing = false;
    positionBubble();
    bubbleTimer = setTimeout(hideBubble, o.ttlMs || state.cfg.bubble.ttlMs || 15000);
    return;
  }
  let i = 0;
  box.textContent = '';
  positionBubble();
  typeTimer = setInterval(() => {
    i += 2;
    box.textContent = text.slice(0, i);
    positionBubble();
    if (i >= text.length) {
      clearInterval(typeTimer);
      state.typing = false;
      bubbleTimer = setTimeout(hideBubble, o.ttlMs || state.cfg.bubble.ttlMs || 15000);
    }
  }, 24);
}

function hideBubble() {
  $('bubble').classList.add('hidden');
  state.typing = false;
  state.bubbleVisible = false;
}

// ------------------------------------------------------------------ 语音
function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function speak(audio) {
  if (!audio || !audio.base64) return;
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') await audioCtx.resume();
    const bytes = b64ToBytes(audio.base64);
    const buf = await audioCtx.decodeAudioData(bytes.buffer.slice(0));
    const src = audioCtx.createBufferSource();
    src.buffer = buf;
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    analyserData = new Uint8Array(analyser.fftSize);
    src.connect(analyser);
    analyser.connect(audioCtx.destination);
    src.onended = () => { state.speaking = false; analyser = null; analyserData = null; };
    state.speaking = true;
    src.start();
  } catch (e) {
    log('播放语音失败：' + (e && e.message ? e.message : e));
  }
}

// ------------------------------------------------------------------ 聊天输入
function toggleChat(open, noFocus) {
  state.chatOpen = open === undefined ? !state.chatOpen : !!open;
  $('chat').classList.toggle('hidden', !state.chatOpen);
  if (state.chatOpen) {
    updateIgnoreMouse();
    if (!noFocus) setTimeout(() => $('chat-input').focus(), 30);
  } else {
    $('chat-input').blur();
    updateIgnoreMouse();
  }
}

function sendChat(text) {
  const t = String(text || '').trim();
  if (!t) return;
  triggerBehavior('turn');
  PROC.awakeUntil = performance.now() + 25000;
  state.lastActivity = Date.now();
  API.wsSend({ type: 'message', id: 'm' + Date.now(), text: t, ts: Date.now() });
  if (!state.connected) {
    showBubble('（还没连上 AstrBot，先去把适配器启动起来～）', { instant: true, ttlMs: 4000 });
  } else {
    showBubble('……', { instant: true, ttlMs: 60000 });
  }
}

function bindChat() {
  const input = $('chat-input');
  input.addEventListener('input', () => { PROC.typingUntil = performance.now() + 1600; });
  input.addEventListener('focus', () => { PROC.typingUntil = performance.now() + 1600; });
  input.addEventListener('blur', () => { PROC.typingUntil = 0; });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const v = input.value;
      input.value = '';
      if (v.trim()) sendChat(v);
      if (v.trim()) {
        appendHistory('你：' + v.trim());
        // 发送后保持输入框打开，方便连续对话（Esc 或点 💬 关闭）
        $('chat-input').focus();
      }
    } else if (e.key === 'Escape') {
      toggleChat(false);
    }
    e.stopPropagation();
  });
}

const history = [];
function appendHistory(line) {
  history.push(line);
  if (history.length > 200) history.shift();
}

// ------------------------------------------------------------------ 形象选择面板
function renderPicker() {
  const grid = $('picker-grid');
  grid.innerHTML = '';
  for (const m of state.models) {
    const card = document.createElement('div');
    card.className = 'card' + (m.id === state.currentId ? ' active' : '') + (m.ok ? '' : ' err');
    card.title = m.ok
      ? m.name + '\n表情：' + (m.expressions || []).join(', ') + '\n动作：' + (m.motionGroups || []).join(', ')
      : m.name + '（读取失败：' + (m.error || '') + '）';
    if (m.thumbnail) {
      const img = document.createElement('img');
      img.src = modelUrl(m.thumbnail);
      img.draggable = false;
      card.appendChild(img);
    }
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = m.name;
    card.appendChild(name);
    const badge = document.createElement('div');
    badge.className = 'badge';
    badge.textContent = m.type === 'cubism2' ? 'C2' : m.type === 'cubism4' ? 'C4' : '?';
    card.appendChild(badge);
    card.addEventListener('click', () => {
      if (!m.ok) return;
      loadModel(m);
      togglePicker(false);
    });
    grid.appendChild(card);
  }
  if (!state.models.length) {
    grid.innerHTML = '<div style="color:#bbb;font-size:12px;padding:8px">models 目录里没有找到模型。把 Live2D 模型文件夹放进去，然后点“刷新”。</div>';
  }
}

function togglePicker(open) {
  state.pickerOpen = open === undefined ? !state.pickerOpen : !!open;
  $('picker').classList.toggle('hidden', !state.pickerOpen);
  if (state.pickerOpen) { renderPicker(); updateIgnoreMouse(); }
  else updateIgnoreMouse();
}

async function rescan() {
  state.models = await API.listModels();
  log('重新扫描：' + state.models.length + ' 个模型');
  if (state.pickerOpen) renderPicker();
}

// ------------------------------------------------------------------ 待机
function tryRandomIdle() {
  if (!model || !state.info) return;
  const groups = state.info.motionGroups || [];
  // 大约 1/6 的概率播「Special」（模型里那段 13 秒头部动捕），其余播 Idle
  const special = groups.find((x) => /special/i.test(x));
  if (special && Math.random() < 0.16) {
    try {
      model.motion(special, undefined, PIXI.live2d.MotionPriority.NORMAL);
      PROC.specialUntil = PROC.phase + 13;
      state.lastActivity = Date.now();
      return;
    } catch { /* ignore */ }
  }
  const g = groups.find((x) => /idle/i.test(x)) || groups[0];
  if (!g) return;
  try { model.motion(g, undefined, PIXI.live2d.MotionPriority.IDLE); } catch { /* ignore */ }
}

function startIdleLoop() {
  clearTimeout(idleTimer);
  const cfg = state.cfg.idle || { enabled: true, minSec: 18, maxSec: 45 };
  if (!cfg.enabled) return;
  const wait = (cfg.minSec + Math.random() * Math.max(1, cfg.maxSec - cfg.minSec)) * 1000;
  idleTimer = setTimeout(() => {
    if (!state.typing && !state.speaking && Date.now() - state.lastActivity > 6000) tryRandomIdle();
    startIdleLoop();
  }, wait);
}

// ------------------------------------------------------------------ AstrBot 消息
function handleWsMessage(msg) {
  if (!msg || typeof msg !== 'object') return;
  switch (msg.type) {
    case 'hello_ack':
      state.connected = true;
      log('AstrBot 握手完成 umo=' + (msg.umo || '?'));
      break;
    case 'reply': {
      const text = String(msg.text || '');
      log('收到 reply（' + text.length + ' 字，emotion=' + (msg.emotion || '-') + '）: ' + text.slice(0, 80));
      // 先转头看向「说话的方向」，再出气泡
      const turnFirst = !(state.cfg.behavior && state.cfg.behavior.turnBeforeSpeak === false);
      PROC.awakeUntil = performance.now() + 20000;
      state.lastActivity = Date.now();
      const show = () => {
        if (text || (msg.images && msg.images.length)) {
          // 2.5 秒内的后续消息（比如单独发来的图片）合并进同一条气泡，不要顶掉前一句
          const joined = state.bubbleVisible && state.bubbleAt && (Date.now() - state.bubbleAt < 2500)
            && appendBubble(text, msg.images);
          if (!joined) showBubble(text, { ttlMs: msg.ttlMs, images: msg.images });
        }
        const emo = msg.emotion || 'neutral';
        if (msg.emotion) { setEmotion(msg.emotion, msg.emotionHoldMs || 6000); rememberMood(msg.emotion); }
        // 每说一句话就按情绪做一个动作
        playEmotionAction(emo);
        // ⑬ 长回复：中途再穿插几个小动作，显得更有"在说话"的感觉
        try {
          (state.extraActionTimers || []).forEach(clearTimeout);
          state.extraActionTimers = [];
          const cfgB = state.cfg.behavior || {};
          if (cfgB.multiAction !== false && text.length > 40) {
            const pool = ['ack', 'tilt', 'ponder', 'nuzzle'];
            const cnt = Math.min(3, Math.floor(text.length / 45));
            for (let i = 0; i < cnt; i++) {
              state.extraActionTimers.push(setTimeout(() => {
                const name = pool[Math.floor(Math.random() * pool.length)];
                triggerBehavior(name, name === 'nuzzle' ? { data: { dir: Math.random() < 0.5 ? -1 : 1 } } : {});
              }, 2100 * (i + 1)));
            }
          }
        } catch { /* ignore */ }
        if (msg.audio) speak(msg.audio);
        if (msg.audioError) log('语音问题：' + msg.audioError);
      };
      if (turnFirst) {
        triggerBehavior('turn');
        clearTimeout(state.pendingSpeak);
        state.pendingSpeak = setTimeout(show, 400);
      } else show();
      break;
    }
    case 'stream': {
      const box = $('bubble-text');
      $('bubble').classList.remove('hidden');
      clearTimeout(bubbleTimer);
      clearInterval(typeTimer);
      state.typing = !msg.done;
      if (!msg.delta) box.textContent = '';
      box.textContent += String(msg.delta || '');
      positionBubble();
      if (msg.done) {
        state.typing = false;
        bubbleTimer = setTimeout(hideBubble, msg.ttlMs || 15000);
      }
      break;
    }
    case 'emotion':
      if (msg.emotion) setEmotion(msg.emotion, msg.holdMs || 6000);
      break;
    case 'mood':
      applyMood(msg.emotion, msg.ageS);
      break;
    case 'motion':
      try { model && model.motion(msg.group, msg.index); } catch { /* ignore */ }
      break;
    case 'notice':
      log('收到 notice: ' + msg.text);
      showBubble(String(msg.text || ''), { instant: true, ttlMs: 5000 });
      break;
    case 'speak':
      speak(msg.audio);
      break;
    default:
      log('未知消息类型：' + msg.type);
  }
}

function setConnected(on, detail) {
  state.connected = !!on;
  const dot = $('hud-dot');
  dot.className = 'dot ' + (on ? 'on' : 'off');
  $('hud-text').textContent = on ? ('AstrBot 已连接' + (detail ? ' · ' + detail : '')) : 'AstrBot 未连接（本地模式）';
}

function bindIpc() {
  API.onWsMessage(handleWsMessage);
  API.onWsStatus((s) => {
    if (s && s.clients > 0) setConnected(true, '');
    else setConnected(false);
    if (s && s.error && s.error !== 'disabled') log('WS 状态：' + JSON.stringify(s));
  });
  API.onWsPeer((p) => setConnected(!!(p && p.connected)));
  API.onLoadModel((info) => loadModel(info));
  API.onOpenPicker(() => togglePicker(true));
  API.onPlayMotion((m) => playMotion(m.group, m.index, m.name));
  API.onSetExpression((name) => {
    try {
      if (!model) return;
      clearTimeout(emotionTimer);
      model.expression(name);
      state.previewExpression = name;
      log('▶ 预览表情 ' + name);
    } catch (e) { log('预览表情失败: ' + (e && e.message)); }
  });
  API.onResetExpressions(() => {
    try {
      state.previewExpression = null;
      resetEmotion();
      log('▶ 表情已恢复默认');
    } catch (e) { /* ignore */ }
  });
  API.onParamOverride((p) => {
    const { kind, name, on } = p || {};
    if (kind === 'face') setFaceExpr(name, !!on);
    else if (kind === 'look') setLookExpr(name, !!on);
    else if (kind === 'body') setBodyExpr(name);
    else if (kind === 'reset') {
      state.appearance = { face: {}, look: {}, body: '' };
      saveAppearance();
      applyParamOverrides();
      log('已清除全部表情/外貌覆盖');
    }
  });
  API.onEmotionAction((name) => {
    try {
      state.panAuto = true;
      triggerBehavior(name, name === 'nuzzle' ? { data: { dir: 1 } } : {});
      const emo = EMOTION_OF_ACTION[name];
      if (emo) setEmotion(emo, 5000);
      log('▶ 预览情绪动作 ' + name + (emo ? ('（表情 ' + emo + '）') : ''));
    } catch (e) { log('预览情绪动作失败: ' + (e && e.message)); }
  });
  API.onOpenMotionPicker(() => openMotionPicker());
  API.onReloadBehavior(async () => {
    try {
      state.cfg = await API.getConfig();
      const b = state.cfg.behavior || {};
      PROC.on = b.enabled !== false;
      PROC.yawns = b.yawns !== false;
      PROC.lookAround = b.lookAround !== false;
      PROC.nightSleepy = b.nightSleepy !== false;
      PROC.amp = Number(b.amplitude) || 2.5;
      // 嘴部设置也要同步（之前漏了，导致设置窗选嘴型无效）
      PROC.mouthOn = b.idleMouth !== false;
      PROC.idleMouthMode = b.idleMouthMode || 'auto';
      PROC.idleMouthStrength = Number(b.idleMouthStrength) || 0.7;
      // 立刻重算一帧，让变化马上可见
      try { postTick(); } catch (e) { /* ignore */ }
      log('行为配置已重载: amp=' + PROC.amp + ' 嘴型=' + PROC.idleMouthMode + ' 强度=' + PROC.idleMouthStrength);
    } catch (e) { log('重载行为失败: ' + (e && e.message)); }
  });
  API.onOpenChat(() => toggleChat(true));
  API.onRescan(() => rescan());
  API.onSay ? API.onSay((t) => { log('测试语句：' + t); sendChat(t); }) : null;
  API.onDemo(() => {
    setEmotion('happy', 8000);
    showBubble('你好呀，我是你的桌宠～ QQ 和这里的对话会记在同一份记忆里。', { instant: true, ttlMs: 60000 });
    setTimeout(() => {
      const r = document.getElementById('bubble').getBoundingClientRect();
      const headTop = model ? (model.y - model.internalModel.height * model.scale.y) : 0;
      API.log('SELFTEST bubble=' + JSON.stringify({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }) +
        ' headTop=' + Math.round(headTop) + ' modelW=' + Math.round(model ? model.width : 0) +
        ' win=' + window.innerWidth + 'x' + window.innerHeight +
        ' 重叠=' + Math.round(Math.max(0, Math.min(b ? b.y + b.height : 0, r.y + r.height) - Math.max(b ? b.y : 0, r.y))));
    }, 1800);
  });
}

// ------------------------------------------------------------------ 起
$('picker-close').addEventListener('click', () => togglePicker(false));
$('picker-rescan').addEventListener('click', () => rescan());
$('picker-open-dir').addEventListener('click', () => API.openModelsDir());
$('bubble').classList.add('hidden');

bindChat();
bindIpc();
bindGrip();
bindDock();
bindScrollbars();
bindSettings();

boot().catch((e) => {
  log('启动失败：' + (e && e.stack ? e.stack : e));
  $('loading').textContent = '启动失败：' + (e && e.message ? e.message : e);
});
