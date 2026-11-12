/**
 * 下载 Live2D 官方示例模型（Cubism 4 / moc3）到 models/ 目录。
 * 数据源：Live2D/CubismWebSamples（经 jsdelivr gh 代理）
 * 授权：Live2D Sample Model Terms of Use，见 models/README.txt
 *
 * 用法：node tools/fetch-models.js [模型名...]
 */
const fs = require('fs');
const path = require('path');
const http = require('http');

const REPO = 'Live2D/CubismWebSamples';
const BRANCH = process.env.L2D_BRANCH || 'develop';
const LIST_URL = `https://data.jsdelivr.com/v1/packages/gh/${REPO}@${BRANCH}?structure=flat`;
const RAW = (p) => `https://gcore.jsdelivr.net/gh/${REPO}@${BRANCH}${p}`;
const OUT = path.resolve(__dirname, '..', 'models');

const WANT = process.argv.slice(2);
const CONCURRENCY = 6;

async function get(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'deskpet-fetch' }, redirect: 'follow' });
  if (!res.ok) throw new Error(res.status + ' ' + url);
  return Buffer.from(await res.arrayBuffer());
}

(async () => {
  const list = JSON.parse((await get(LIST_URL)).toString('utf8'));
  const files = (list.files || []).map((f) => f.name).filter((n) => n.startsWith('/Samples/Resources/'));
  const models = [...new Set(files.map((n) => n.split('/')[3]))].filter((m) => !m.includes('.'));
  const targets = WANT.length ? models.filter((m) => WANT.includes(m)) : models;
  if (!targets.length) { console.error('没有匹配的模型，可选：' + models.join(', ')); process.exit(1); }

  const jobs = [];
  for (const m of targets) {
    for (const f of files.filter((n) => n.split('/')[3] === m)) {
      const rel = f.replace('/Samples/Resources/' + m + '/', '');
      const dest = path.join(OUT, m, rel);
      if (fs.existsSync(dest) && fs.statSync(dest).size > 0) continue;
      jobs.push({ url: RAW(f), dest });
    }
  }
  console.log('模型：' + targets.join(', ') + '；待下载 ' + jobs.length + ' 个文件');
  let done = 0, failed = 0;
  async function worker() {
    while (jobs.length) {
      const j = jobs.shift();
      try {
        const buf = await get(j.url);
        fs.mkdirSync(path.dirname(j.dest), { recursive: true });
        fs.writeFileSync(j.dest, buf);
        done++;
        process.stdout.write('\r  ' + done + ' 完成 / ' + failed + ' 失败' + ' '.repeat(20));
      } catch (e) { failed++; console.error('\n  x ' + j.url + ' : ' + e.message); }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  console.log('\n完成：' + done + ' 成功，' + failed + ' 失败 -> ' + OUT);
})();
