const fs = require('fs');
const path = require('path');

const root = process.cwd();
const dir = path.join(root, 'plugin-packages', 'openai-images');
const manifestPath = path.join(dir, 'manifest.json');
const docsPath = path.join(dir, 'docs', 'interface.md');
const readme = fs.readFileSync(path.join(dir, 'README.md'), 'utf8').trim();
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
let docs = fs.readFileSync(docsPath, 'utf8');
const start = '<!-- YINGCE_MANIFEST_CONTRACT_START -->';
const end = '<!-- YINGCE_MANIFEST_CONTRACT_END -->';
const begin = docs.indexOf(start);
const finish = docs.indexOf(end);
if (begin < 0 || finish < 0) throw new Error('manifest contract markers missing');
const documented = JSON.parse(JSON.stringify(manifest));
documented.documentation = '<当前插件的完整 documentation，由 README.md 与 docs/interface.md 拼接而成；为避免 JSON 递归，此处不重复展开正文。>';
const contract = [
  start,
  '## Manifest 完整接口定义',
  '',
  '以下 JSON 与插件包内实际 `manifest.json` 逐字段一致，覆盖插件身份、权限、配置、鉴权、参数、校验、创建、Agent、查询、取消、结果下载、响应和 Agent 响应映射。`documentation` 字段的值就是当前完整文档；为避免文档在自身内部无限递归，JSON 中仅用等义占位文本表示正文。',
  '',
  '```json',
  JSON.stringify(documented, null, 2),
  '```',
  end,
].join('\n');
docs = docs.slice(0, begin) + contract + docs.slice(finish + end.length);
fs.writeFileSync(docsPath, docs);
manifest.documentation = readme + '\n\n---\n\n' + docs.trim();
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
