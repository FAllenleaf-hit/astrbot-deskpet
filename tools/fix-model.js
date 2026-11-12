/**
 * 修补 VTube Studio 等工具导出的 Live2D 模型：
 * 这类模型的 model3.json 里 Motions / Expressions 常常是空的，
 * 动作和表情文件虽然存在（Animation/、Exp3/）却没被注册，导致桌宠里点不动、换不了表情。
 *
 * 用法：node tools/fix-model.js <模型文件夹> [更多文件夹...]
 * 会先生成 <xxx>.model3.json.bak 备份，再写回修补后的 model3.json。
 */
const fs = require('fs');
const path = require('path');

function walk(dir, out, depth = 4) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (depth > 0) walk(full, out, depth - 1); }
    else out.push(full);
  }
  return out;
}

const rel = (from, to) => path.relative(from, to).split(path.sep).join('/');

function fixModel(dirArg) {
  const dir = path.resolve(dirArg);
  const jsonFiles = fs.readdirSync(dir).filter((f) => /\.model3\.json$/i.test(f));
  if (!jsonFiles.length) { console.log(`跳过（没有 model3.json）：${dir}`); return; }
  const modelFile = path.join(dir, jsonFiles[0]);
  const j = JSON.parse(fs.readFileSync(modelFile, 'utf8'));
  j.FileReferences = j.FileReferences || {};
  const refs = j.FileReferences;
  let changed = [];

  const all = walk(dir, []);
  const expFiles = all.filter((f) => /\.exp3\.json$/i.test(f));
  const motFiles = all.filter((f) => /\.motion3\.json$/i.test(f));

  // 1) 表情
  if (!(refs.Expressions || []).length && expFiles.length) {
    refs.Expressions = expFiles.map((f) => ({
      Name: path.basename(f).replace(/\.exp3\.json$/i, ''),
      File: rel(dir, f),
    }));
    changed.push(`表情 +${refs.Expressions.length}`);
  }

  // 2) 动作：IDLE 类的归到 Idle 组，其余归到 Tap 组
  if (!refs.Motions || !Object.keys(refs.Motions).length) {
    const idle = [], taps = [];
    for (const f of motFiles) {
      const base = path.basename(f);
      if (/^(idle|待机)/i.test(base)) idle.push({ File: rel(dir, f), FadeInTime: 0.6, FadeOutTime: 0.6 });
      else taps.push({ File: rel(dir, f), FadeInTime: 0.5, FadeOutTime: 0.5 });
    }
    refs.Motions = {};
    if (idle.length) refs.Motions.Idle = idle;
    if (taps.length) refs.Motions.TapBody = taps;
    changed.push(`动作 Idle:${idle.length} Tap:${taps.length}`);
  }

  // 3) 口型参数
  j.Groups = j.Groups || [];
  let lip = j.Groups.find((g) => g.Name === 'LipSync');
  if (!lip) { lip = { Name: 'LipSync', Ids: [] }; j.Groups.push(lip); }
  if (!(lip.Ids || []).length) {
    const cdi = all.find((f) => /\.cdi3\.json$/i.test(f));
    let param = 'ParamMouthOpenY';
    if (cdi) {
      try {
        const c = JSON.parse(fs.readFileSync(cdi, 'utf8'));
        const ids = (c.Parameters || []).map((p) => p.Id);
        param = ids.find((x) => x === 'ParamMouthOpenY') || ids.find((x) => /MouthOpen/i.test(x)) || param;
      } catch { /* ignore */ }
    }
    lip.Ids = [param];
    changed.push(`口型参数 ${param}`);
  }

  if (!changed.length) { console.log(`无需修补：${path.basename(dir)}`); return; }
  const bak = modelFile + '.bak';
  if (!fs.existsSync(bak)) fs.copyFileSync(modelFile, bak);
  fs.writeFileSync(modelFile, JSON.stringify(j, null, 1), 'utf8');
  console.log(`已修补 ${path.basename(dir)}: ${changed.join(' / ')}`);
}

const targets = process.argv.slice(2);
if (!targets.length) {
  console.log('用法: node tools/fix-model.js <模型文件夹> [...]');
  process.exit(0);
}
for (const t of targets) fixModel(t);
