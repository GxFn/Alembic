#!/usr/bin/env node

/**
 * 验证 context API 可触达性
 * 需先启动 alembic ui，再执行: node scripts/verify-context-api.js
 * 或: ALEMBIC_UI_URL=http://localhost:3001 node scripts/verify-context-api.js
 */

import http from 'node:http';
import https from 'node:https';

const baseUrl = process.env.ALEMBIC_UI_URL || 'http://localhost:3000';
const url = new URL('/api/context/search', baseUrl);

const body = JSON.stringify({ query: '网络请求', limit: 3 });

const client = url.protocol === 'https:' ? https : http;
const opts = {
  hostname: url.hostname,
  port: url.port || (url.protocol === 'https:' ? 443 : 80),
  path: url.pathname,
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  },
};

const req = client.request(opts, (res) => {
  let data = '';
  res.on('data', (ch) => {
    data += ch;
  });
  res.on('end', () => {
    if (res.statusCode !== 200) {
      console.error(`❌ API 返回 ${res.statusCode}`);
      process.exit(1);
    }
    try {
      const json = JSON.parse(data);
      if (!json.items || !Array.isArray(json.items)) {
        console.error('❌ 返回结构异常，缺少 items 数组');
        process.exit(1);
      }
      if (json.items.length > 0) {
      }
    } catch (e: any) {
      console.error('❌ 解析响应失败:', e.message);
      process.exit(1);
    }
  });
});

req.on('error', (e) => {
  console.error('❌ 请求失败:', e.message);
  console.error('   请确保 alembic ui 已启动，或设置 ALEMBIC_UI_URL');
  process.exit(1);
});

req.write(body);
req.end();
