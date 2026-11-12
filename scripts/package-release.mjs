#!/usr/bin/env node
/**
 * 打包 release 产物：
 *
 *  1. astrbot_plugin_deskpet-vX.Y.Z.zip
 *     → 面板「上传安装」用：zip 根部直接是 main.py / metadata.yaml（AstrBot 要求）
 *
 *  2. astrbot-deskpet-plugin-folder-vX.Y.Z.zip
 *     → 手动安装用：解压后直接得到 astrbot_plugin_deskpet/ 文件夹，
 *       把该文件夹拖进 <AstrBot>/data/plugins/ 即可
 *
 *  3. astrbot-deskpet-app-source-vX.Y.Z.zip
 *     → Electron 桌宠 App 源码（不含 node_modules / models / 用户配置）
 *
 * 用法: node scripts/package-release.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'release');
const PLUGIN_NAME = 'astrbot_plugin_deskpet';
const PLUGIN_FILES = ['main.py', 'metadata.yaml', '_conf_schema.json', 'requirements.txt', 'README.md'];

function readVersion() {
  const md = fs.readFileSync(path.join(ROOT, 'plugin/metadata.yaml'), 'utf8');
  const m = md.match(/^version:\s*(.+)$/m);
  return (m ? m[1] : '0.0.0').trim();
}

/** 用 PowerShell 的 .NET ZipFile 打包；includeBaseDirectory=false → 根部直接是内容 */
function zip(srcDir, outFile) {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  if (fs.existsSync(outFile)) fs.unlinkSync(outFile);
  const src = path.resolve(srcDir);
  const abs = path.resolve(outFile);
  const ps = [
    'Add-Type -AssemblyName System.IO.Compression.FileSystem;',
    `if (Test-Path '${abs}') { Remove-Item '${abs}' -Force };`,
    `[IO.Compression.ZipFile]::CreateFromDirectory('${src}', '${abs}', [IO.Compression.CompressionLevel]::Optimal, $false)`,
  ].join(' ');
  execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { stdio: 'inherit' });
  const kb = (fs.statSync(outFile).size / 1024).toFixed(0);
  console.log('  ✔ ' + path.relative(ROOT, outFile) + ' (' + kb + ' KB)');
}

function copyDir(from, to, skip) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (skip.includes(e.name)) continue;
    const s = path.join(from, e.name);
    const d = path.join(to, e.name);
    if (e.isDirectory()) copyDir(s, d, skip);
    else fs.copyFileSync(s, d);
  }
}

const ver = readVersion();
console.log('打包 v' + ver + ' ...');
fs.mkdirSync(OUT, { recursive: true });
fs.rmSync(path.join(OUT, '_stage'), { recursive: true, force: true });

// ---- 1) 面板上传版：zip 根部直接是文件 ----
const flat = path.join(OUT, '_stage', 'flat');
fs.mkdirSync(flat, { recursive: true });
for (const f of PLUGIN_FILES) fs.copyFileSync(path.join(ROOT, 'plugin', f), path.join(flat, f));
zip(flat, path.join(OUT, PLUGIN_NAME + '-v' + ver + '.zip'));

// ---- 2) 手动安装版：含 astrbot_plugin_deskpet/ 文件夹 ----
const wrapped = path.join(OUT, '_stage', 'wrapped');
fs.mkdirSync(wrapped, { recursive: true });
copyDir(flat, path.join(wrapped, PLUGIN_NAME), []);
zip(wrapped, path.join(OUT, 'astrbot-deskpet-plugin-folder-v' + ver + '.zip'));

// ---- 3) App 源码版 ----
const appStage = path.join(OUT, '_stage', 'app', 'astrbot-deskpet-app');
copyDir(path.join(ROOT, 'app'), appStage, ['node_modules', 'config.json', 'models', 'shots', 'release']);
zip(appStage, path.join(OUT, 'astrbot-deskpet-app-source-v' + ver + '.zip'));

fs.rmSync(path.join(OUT, '_stage'), { recursive: true, force: true });

console.log('完成 ✅');
console.log('');
console.log('安装方式：');
console.log('  · 面板上传  → ' + PLUGIN_NAME + '-v' + ver + '.zip');
console.log('  · 手动安装  → 解压 astrbot-deskpet-plugin-folder-v' + ver + '.zip,');
console.log('                把 ' + PLUGIN_NAME + '/ 文件夹放进 <AstrBot>/data/plugins/');
