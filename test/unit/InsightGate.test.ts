import { describe, expect, test } from 'vitest';
import {
  analysisQualityGate,
  buildAnalysisArtifact,
  insightGateEvaluator,
} from '../../lib/agent/prompts/insight-gate.js';

describe('insight gate analysis artifact', () => {
  const evidenceToolCalls = [
    {
      tool: 'code',
      args: {
        action: 'read',
        path: 'Packages/AOXNetworkKit/Sources/AOXNetworkKit/Core/NetworkError.swift',
      },
      result: '12|public enum NetworkError: Error {\\n13| case invalidURL(String)\\n}',
    },
    {
      tool: 'code',
      args: {
        action: 'read',
        path: 'Packages/AOXNetworkKit/Sources/AOXNetworkKit/Core/ResponseDecoder.swift',
      },
      result:
        '44|if let validatable = result as? any ResponseValidatable {\\n45| guard validatable.isSuccess else { throw NetworkError.serverBusiness(...) }\\n}',
    },
    {
      tool: 'code',
      args: {
        action: 'read',
        path: 'Sources/Infrastructure/Networking/Client/NetworkError+Bili.swift',
      },
      result:
        '8|extension NetworkError: UserFacingError {\\n9| public var userMessage: String { ... }\\n}',
    },
  ];

  test('derives structured findings from markdown sections when memory findings are empty', () => {
    const reply = `
## NetworkError 统一网络错误枚举

核心错误模型落在 Packages/AOXNetworkKit/Sources/AOXNetworkKit/Core/NetworkError.swift，并通过 Sources/Infrastructure/Networking/Client/NetworkError+Bili.swift 转换成业务可读错误。

## ResponseDecoder 容错解析链路

响应解析由 Packages/AOXNetworkKit/Sources/AOXNetworkKit/Core/ResponseDecoder.swift 承担，BiliDili 的业务扩展位于 Sources/Infrastructure/Networking/Client/ResponseDecoder+Bili.swift。

## 中间件错误恢复

请求链路中的 Sources/Infrastructure/Networking/Middleware/AuthMiddleware.swift 和 Packages/AOXNetworkKit/Sources/AOXNetworkKit/Middleware/CacheMiddleware.swift 提供认证恢复与缓存降级。
`;

    const artifact = buildAnalysisArtifact(
      { reply, toolCalls: evidenceToolCalls },
      'error-resilience',
      null,
      {
        distill: () => ({ keyFindings: [], toolCallSummary: [] }),
      }
    );

    expect(artifact.findings).toHaveLength(3);
    expect(artifact.findings[0]).toMatchObject({
      finding: 'NetworkError 统一网络错误枚举',
      evidence: expect.stringContaining('NetworkError.swift'),
    });
    expect(artifact.qualityReport.scores.evidenceScore).toBeGreaterThanOrEqual(50);
    expect(artifact.qualityReport.suggestions).not.toContain('Findings lack file-level evidence');
    expect(artifact.qualityReport.suggestions).toContain(
      'Required memory action note_finding calls are missing'
    );
    expect(artifact.metadata).toMatchObject({
      memoryFindingCount: 0,
      derivedFindingCount: 3,
    });
    expect(analysisQualityGate(artifact, { outputType: 'candidate' })).toMatchObject({
      pass: false,
      action: 'retry',
      reason: 'Required memory action note_finding calls are missing',
    });
  });

  test('does not trigger memory-note retry when findings come from memory note_finding', () => {
    const reply = `
## NetworkError 统一网络错误枚举

核心错误模型落在 Packages/AOXNetworkKit/Sources/AOXNetworkKit/Core/NetworkError.swift。
`;

    const artifact = buildAnalysisArtifact(
      { reply, toolCalls: evidenceToolCalls },
      'error-resilience',
      null,
      {
        distill: () => ({
          keyFindings: [
            {
              finding: 'NetworkError 统一网络错误枚举',
              evidence: 'Packages/AOXNetworkKit/Sources/AOXNetworkKit/Core/NetworkError.swift:12',
              importance: 9,
            },
            {
              finding: 'ResponseDecoder 校验业务码',
              evidence:
                'Packages/AOXNetworkKit/Sources/AOXNetworkKit/Core/ResponseDecoder.swift:44',
              importance: 8,
            },
            {
              finding: 'NetworkError+Bili 提供用户文案',
              evidence: 'Sources/Infrastructure/Networking/Client/NetworkError+Bili.swift:8',
              importance: 8,
            },
          ],
          toolCallSummary: [],
        }),
      }
    );

    expect(artifact.qualityReport.suggestions).not.toContain(
      'Required memory action note_finding calls are missing'
    );
    expect(artifact.metadata).toMatchObject({
      memoryFindingCount: 3,
      derivedFindingCount: 0,
    });
    expect(analysisQualityGate(artifact, { outputType: 'candidate' }).reason).not.toBe(
      'Required memory action note_finding calls are missing'
    );
  });

  test('requires at least three memory note_finding calls for candidate output', () => {
    const artifact = buildAnalysisArtifact(
      {
        reply: `
## NetworkError 统一网络错误枚举

核心错误模型落在 Packages/AOXNetworkKit/Sources/AOXNetworkKit/Core/NetworkError.swift。
`,
        toolCalls: evidenceToolCalls,
      },
      'error-resilience',
      null,
      {
        distill: () => ({
          keyFindings: [
            {
              finding: 'NetworkError 统一网络错误枚举',
              evidence: 'Packages/AOXNetworkKit/Sources/AOXNetworkKit/Core/NetworkError.swift:12',
              importance: 9,
            },
          ],
          toolCallSummary: [],
        }),
      }
    );

    expect(artifact.metadata).toMatchObject({
      memoryFindingCount: 1,
      derivedFindingCount: 0,
    });
    expect(artifact.qualityReport.suggestions).toContain(
      'At least 3 memory action note_finding calls are required'
    );
    expect(analysisQualityGate(artifact, { outputType: 'candidate' })).toMatchObject({
      pass: false,
      action: 'retry',
      reason: 'At least 3 memory action note_finding calls are required',
    });
  });

  test('treats needsCandidates as candidate output even when outputType is analysis', () => {
    const reply = `
## NetworkError 统一网络错误枚举

核心错误模型落在 Packages/AOXNetworkKit/Sources/AOXNetworkKit/Core/NetworkError.swift，并通过 Sources/Infrastructure/Networking/Client/NetworkError+Bili.swift 转换成业务可读错误。

## ResponseDecoder 容错解析链路

响应解析由 Packages/AOXNetworkKit/Sources/AOXNetworkKit/Core/ResponseDecoder.swift 承担。

## 中间件错误恢复

请求链路中的 Sources/Infrastructure/Networking/Middleware/AuthMiddleware.swift 提供认证恢复。
`;

    const result = insightGateEvaluator(
      { reply, toolCalls: evidenceToolCalls },
      {},
      {
        dimId: 'error-resilience',
        outputType: 'analysis',
        needsCandidates: true,
        activeContext: {
          distill: () => ({ keyFindings: [], toolCallSummary: [] }),
        },
      }
    );

    expect(result).toMatchObject({
      action: 'retry',
      reason: 'Required memory action note_finding calls are missing',
    });
  });
});
