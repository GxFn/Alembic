#!/usr/bin/env node

/**
 * AutoSnippet MCP 诊断脚本
 *
 * - 检查 UI 健康状态 (/api/health)
 * - 输出环境变量与鉴权配置情况
 * - 给出下一步建议（能力自检、限流与提交）
 */

import http from 'node:http';
import https from 'node:https';
import * as Defaults from '../lib/infrastructure/config/Defaults.js';

function getBaseUrl() {
  return process.env.ASD_UI_URL || Defaults.DEFAULT_ASD_UI_URL || 'http://localhost:3000';
}

function request(method, urlStr) {
  const url = new URL(urlStr);
  const client = url.protocol === 'https:' ? https : http;
  const opts = {
    hostname: url.hostname,
    port: url.port || (url.protocol === 'https:' ? 443 : 80),
    path: url.pathname,
    method,
  };
  return new Promise((resolve, reject) => {
    const req = client.request(opts, (res) => {
      let data = '';
      res.on('data', (ch) => {
        data += ch;
      });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve({ statusCode: res.statusCode, raw: data });
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

(async () => {
  const base = getBaseUrl();
  const healthUrl = new URL('/api/health', base).toString();
  const env = {
    ASD_UI_URL: process.env.ASD_UI_URL || null,
    ASD_MCP_TOKEN: process.env.ASD_MCP_TOKEN ? 'set' : 'unset',
  };

  let health: any = null;
  let ok = false;
  let msg = '';
  try {
    health = await request('GET', healthUrl);
    ok = Boolean(health && (health.status === 'healthy' || health.healthy === true));
    msg = ok ? 'UI 健康检查通过' : 'UI 健康检查返回非健康状态';
  } catch (e: any) {
    msg = `无法连接到 UI: ${e.message}`;
  }

  const _report = {
    success: ok,
    message: msg,
    data: { health },
    meta: {
      checker: 'diagnose-mcp',
      baseUrl: base,
      healthUrl,
      env,
    },
    next: [
      '在 MCP 客户端调用 autosnippet_health / autosnippet_capabilities 进行能力自检',
      '如需鉴权，请在 MCP 服务器环境设置 ASD_MCP_TOKEN',
      '提交候选时传入 clientId 以启用限流（避免短时间批量提交）',
    ],
  };
  process.exit(ok ? 0 : 1);
})();
