'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (cb) => {
  const h = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
};

contextBridge.exposeInMainWorld('pet', {
  // 数据
  listModels: () => ipcRenderer.invoke('models:list'),
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (patch) => ipcRenderer.invoke('config:set', patch),

  // 与 AstrBot 通信
  wsSend: (msg) => ipcRenderer.send('ws:send', msg),
  onWsMessage: on('ws:message'),
  onWsStatus: on('ws:status'),
  onWsPeer: on('ws:peer'),

  // 窗口
  setIgnoreMouse: (v) => ipcRenderer.send('win:ignore-mouse', v),
  dragStart: (p) => ipcRenderer.send('win:drag-start', p),
  dragMove: (p) => ipcRenderer.send('win:drag-move', p),
  dragEnd: () => ipcRenderer.send('win:drag-end'),
  resizeStart: (p) => ipcRenderer.send('win:resize-start', p),
  resizeMove: (p) => ipcRenderer.send('win:resize-move', p),
  resizeEnd: () => ipcRenderer.send('win:resize-end'),
  sizeStep: (f) => ipcRenderer.send('win:size-step', f),
  sizeReset: () => ipcRenderer.send('win:size-reset'),
  toggleTop: () => ipcRenderer.send('win:toggle-top'),
  setTop: (on) => ipcRenderer.send('win:set-top', on),
  collapse: () => ipcRenderer.send('win:collapse'),
  onTopState: on('ui:top-state'),
  openModelsDir: () => ipcRenderer.send('app:open-models'),
  openConfig: () => ipcRenderer.send('app:open-config'),
  reconnectWs: () => ipcRenderer.send('ws:reconnect'),
  quit: () => ipcRenderer.send('app:quit'),
  openSettings: () => ipcRenderer.send('win:open-settings'),
  closeSelf: () => ipcRenderer.send('win:close-self'),
  uiCommand: (c) => ipcRenderer.send('ui:command', c),

  // 主进程 → 渲染进程 的界面指令
  onLoadModel: on('ui:load-model'),
  onOpenPicker: on('ui:open-picker'),
  onOpenChat: on('ui:open-chat'),
  onRescan: on('ui:rescan'),
  onDemo: on('ui:demo'),
  onSay: on('ui:say'),
  onPlayMotion: on('ui:play-motion'),
  onSetExpression: on('ui:set-expression'),
  onResetExpressions: on('ui:reset-expressions'),
  onEmotionAction: on('ui:emotion-action'),
  onParamOverride: on('ui:param-override'),
  onOpenMotionPicker: on('ui:open-motion-picker'),

  // 状态回传
  ready: (info) => ipcRenderer.send('renderer:ready', info),
  modelLoaded: (id) => ipcRenderer.send('renderer:model-loaded', id),
  log: (m) => ipcRenderer.send('renderer:log', String(m)),
  captureTest: (n) => ipcRenderer.send('test:capture', String(n)),
  broadcastAppearance: (ap) => ipcRenderer.send('appearance:broadcast', ap),
  onAppearanceState: on('appearance:state'),
  onReloadBehavior: on('ui:reload-behavior'),
});
