#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : '';
}

const baseUrl = option('base').replace(/\/$/, '');
const targetOption = option('target');

if (!baseUrl || !targetOption) {
  throw new Error('用法：node bootstrap.mjs --base <Agent Kit URL> --target <安装目录>');
}
const targetRoot = path.resolve(targetOption);

const manifestResponse = await fetch(`${baseUrl}/distribution-manifest.json`);
if (!manifestResponse.ok) {
  throw new Error(`无法下载组件清单：HTTP ${manifestResponse.status}`);
}
const manifest = await manifestResponse.json();

for (const entry of manifest.files || []) {
  if (!/^(?:[a-zA-Z0-9._-]+\/)*[a-zA-Z0-9._-]+$/.test(entry)) {
    throw new Error(`组件清单包含非法路径：${entry}`);
  }
  const target = path.resolve(targetRoot, entry);
  if (target !== targetRoot && !target.startsWith(`${targetRoot}${path.sep}`)) {
    throw new Error(`组件路径越界：${entry}`);
  }
  const response = await fetch(`${baseUrl}/${entry}`);
  if (!response.ok) throw new Error(`组件下载失败：${entry}（HTTP ${response.status}）`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, Buffer.from(await response.arrayBuffer()));
}

process.stdout.write(`ATOA Agent Kit ${manifest.version || ''} 已下载到 ${targetRoot}\n`);
