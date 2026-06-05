#!/usr/bin/env node

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import decisionRegisterRouter, {
  buildDecisionRegisterCapability,
} from '../dist/lib/http/routes/decision-register.js';
import {
  getServiceContainer,
  resetServiceContainer,
} from '../dist/lib/injection/ServiceContainer.js';
import { DecisionRegisterStore } from '../dist/lib/service/task/DecisionRegisterStore.js';

const reportPath = argValue('--report-path') ?? 'scratch/decision-register-route-probe.json';
const dataRoot = mkdtempSync(path.join(tmpdir(), 'alembic-decision-register-probe-'));

try {
  resetServiceContainer();
  const store = new DecisionRegisterStore({
    dataRoot,
    workspace: {
      dataRootSource: 'ghost-registry',
      projectId: 'project-probe',
      projectScopeId: 'scope-probe',
      workspaceMode: 'ghost',
    },
  });
  const container = getServiceContainer();
  container.register('decisionRegisterStore', () => store);

  const app = express();
  app.use(express.json());
  app.use('/api/v1/decision-register', decisionRegisterRouter);
  const server = await listen(app);
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/v1/decision-register`;

  try {
    const capability = await requestJson(`${baseUrl}/capability`);
    const created = await requestJson(baseUrl, {
      body: {
        decision: 'Probe durable Decision Register route.',
        detailRefs: ['/Users/private/project/src/detail.ts:8'],
        scope: { projectScopeId: 'scope-probe' },
        sessionId: 'probe-thread',
        sourceRefs: ['/Users/private/project/src/decision.ts:4'],
        title: 'Probe decision',
        turnId: 'probe-turn',
      },
      method: 'POST',
    });
    const decisionId = created.body?.data?.decision?.decisionId;
    const updated = await requestJson(`${baseUrl}/${encodeURIComponent(decisionId)}`, {
      body: {
        decision: 'Probe updated durable Decision Register route.',
        title: 'Probe decision updated',
      },
      method: 'PATCH',
    });
    const read = await requestJson(`${baseUrl}/${encodeURIComponent(decisionId)}`);
    const listed = await requestJson(`${baseUrl}?sessionId=probe-thread`);
    const revoked = await requestJson(`${baseUrl}/${encodeURIComponent(decisionId)}/revoke`, {
      body: { reason: 'probe revoke' },
      method: 'POST',
    });
    const deleted = await requestJson(`${baseUrl}/${encodeURIComponent(decisionId)}`, {
      body: { reason: 'probe delete' },
      method: 'DELETE',
    });
    const includeDeleted = await requestJson(`${baseUrl}?includeDeleted=true&status=all`);
    const invalidScope = await requestJson(baseUrl, {
      body: {
        decision: 'wrong scope',
        scope: { projectScopeId: 'other-scope' },
        title: 'Wrong scope',
      },
      method: 'POST',
    });

    const privacy = {
      reportContainsRawAbsolutePath: JSON.stringify({
        created: created.body,
        deleted: deleted.body,
        listed: listed.body,
        read: read.body,
        revoked: revoked.body,
        updated: updated.body,
      }).includes('/Users/private'),
      reportContainsRawThreadId: JSON.stringify({
        created: created.body,
        listed: listed.body,
        read: read.body,
      }).includes('probe-thread'),
    };
    const report = {
      generatedAt: new Date().toISOString(),
      ok:
        capability.status === 200 &&
        created.status === 201 &&
        updated.status === 200 &&
        read.status === 200 &&
        listed.status === 200 &&
        revoked.status === 200 &&
        deleted.status === 200 &&
        includeDeleted.status === 200 &&
        invalidScope.status === 409 &&
        !privacy.reportContainsRawAbsolutePath &&
        !privacy.reportContainsRawThreadId,
      capability: buildDecisionRegisterCapability(),
      dataRoot,
      store: store.storeSummary(),
      steps: {
        capability: summarize(capability),
        create: summarize(created),
        update: summarize(updated),
        read: summarize(read),
        list: summarize(listed),
        revoke: summarize(revoked),
        delete: summarize(deleted),
        includeDeleted: summarize(includeDeleted),
        invalidScope: summarize(invalidScope),
      },
      privacy,
    };
    mkdirSync(path.dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify({ ok: report.ok, reportPath, dataRoot }, null, 2));
    process.exitCode = report.ok ? 0 : 1;
  } finally {
    await close(server);
  }
} finally {
  rmSync(dataRoot, { force: true, recursive: true });
}

function argValue(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) {
    return null;
  }
  return process.argv[index + 1] ?? null;
}

function listen(app) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1');
    server.once('listening', () => resolve(server));
    server.once('error', reject);
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    headers: { 'content-type': 'application/json' },
    method: options.method ?? 'GET',
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });
  return {
    body: await response.json(),
    status: response.status,
  };
}

function summarize(result) {
  const data = result.body?.data ?? {};
  return {
    count: data.count ?? null,
    decisionId: data.decision?.decisionId ?? null,
    reasonCode: result.body?.reasonCode ?? null,
    status: result.status,
    success: result.body?.success === true,
  };
}
