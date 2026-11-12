#!/usr/bin/env node
/**
 * 打包 release：
 *  1. 插件 zip（AstrBot 面板可直接上传安装，zip 根部直接是 main.py 等文件）
 *  2. App 源码 zip（不含 node_modules / models / 用户配置）
 *
 * 用法: node scripts/package-release.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'release');

function readVersion() {
  const md = fs.readFileSync(path.join(ROOT, 'plugin/metadata.yaml'), 'utf8');
  const m = md.match(/^version:\s*(.+)$/m);
  return (m ? m[1] : '0.0.0').trim();
}

/** 用 PowerShell 的 .NET ZipFile 打包，includeBaseDirectory=false → zip 根部直接是文件 */
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

const ver = readVersion();
console.log('打包 v' + ver + ' ...');
fs.mkdirSync(OUT, { recursive: true });

// ---- 1) 插件包 ----
const staging = path.join(OUT, '_plugin_staging');
fs.rmSync(staging, { recursive: true, force: true });
fs.mkdirSync(staging, { recursive: true });
for (const f of ['main.py', 'metadata.yaml', '_conf_schema.json', 'requirements.txt']) {
  fs.copyFileSync(path.join(ROOT, 'plugin', f), path.join(staging, f));
}
zip(staging, path.join(OUT, 'astrbot-deskpet-plugin-v' + ver + '.zip'));
fs.rmSync(staging, { recursive: true, force: true });

// ---- 2) App 源码包（先复制到干净目录再打，排除大文件）----
const appStage = path.join(OUT, '_app_staging', 'astrbot-deskpet-app');
fs.rmSync(path.join(OUT, '_app_staging'), { recursive: true, force: true });
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
copyDir(path.join(ROOT, 'app'), appStage, ['node_modules', 'config.json', 'models', 'shots', 'release']);
zip(appStage, path.join(OUT, 'astrbot-deskpet-app-source-v' + ver + '.zip'));
fs.rmSync(path.join(OUT, '_app_staging'), { recursive: true, force: true });

console.log('完成 ✅');
