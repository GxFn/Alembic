/**
 * Guard 文件检查 API 路由
 *
 * 提供 HTTP 端点供 VS Code Extension 调用，触发 Guard 实时检查。
 * 返回格式面向 IDE DiagnosticCollection 优化。
 *
 * 端点:
 *   POST /api/v1/guard/file   — 单文件检查（Extension onDidSave 调用）
 *   POST /api/v1/guard/batch  — 批量文件检查（Extension 工作区扫描）
 */

import { readFileSync } from 'node:fs';
import express, { type Request, type Response } from 'express';
import { GuardBatchBody, GuardFileBody } from '#shared/schemas/http-requests.js';
import { getServiceContainer } from '../../injection/ServiceContainer.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { validate } from '../middleware/validate.js';

const router = express.Router();

/**
 * POST /api/v1/guard/file
 *
 * 请求体:
 *   { filePath: string, content?: string, language?: string }
 *
 *   - filePath: 必须。文件路径（用于语言检测 + 违规追踪）
 *   - content:  可选。文件内容，若省略则从 filePath 磁盘读取
 *   - language: 可选。语言标识，若省略则从 filePath 扩展名推断
 *
 * 响应:
 *   {
 *     success: true,
 *     data: {
 *       filePath, language, violations[], summary,
 *       fixedViolations[]  // 与上次检查对比已修复的违规
 *     }
 *   }
 */
router.post(
  '/file',
  validate(GuardFileBody),
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const { filePath, content, language } = req.body;

    // 获取文件内容
    let code = content;
    if (!code) {
      try {
        code = readFileSync(filePath, 'utf8');
      } catch (err: unknown) {
        return void res.status(400).json({
          success: false,
          message: `Cannot read file: ${(err as Error).message}`,
        });
      }
    }

    const container = getServiceContainer();
    const { GuardCheckEngine, detectLanguage } = await import(
      '../../service/guard/GuardCheckEngine.js'
    );

    // 获取 Engine（含 EP 注入）
    const engine = await _getEngine(container, GuardCheckEngine);

    // 检测语言
    const lang = language || detectLanguage(filePath);

    // 执行检查
    const violations = engine.checkCode(code, lang, { filePath });

    // 格式化违规消息面向 Agent
    const formattedViolations = violations.map((v: Record<string, unknown>) => ({
      ...v,
      // 面向 Agent 的诊断消息格式
      diagnosticMessage: _buildDiagnosticMessage(v),
    }));

    const summary = {
      total: violations.length,
      errors: violations.filter((v: Record<string, unknown>) => v.severity === 'error').length,
      warnings: violations.filter((v: Record<string, unknown>) => v.severity === 'warning').length,
      infos: violations.filter((v: Record<string, unknown>) => v.severity === 'info').length,
    };

    // GuardFeedbackLoop: 检测修复 + confirmUsage
    let fixedViolations: unknown[] = [];
    try {
      const feedbackLoop = container.get('guardFeedbackLoop');
      fixedViolations = feedbackLoop.processFixDetection({ violations }, filePath);
    } catch {
      /* feedbackLoop not available */
    }

    // 写入 ViolationsStore（供后续对比）
    try {
      const violationsStore = container.get('violationsStore');
      violationsStore.appendRun({
        filePath,
        violations,
        summary: `Guard file check: ${summary.errors}E ${summary.warnings}W ${summary.infos}I`,
      });
    } catch {
      /* violationsStore not available */
    }

    res.json({
      success: true,
      data: {
        filePath,
        language: lang,
        violations: formattedViolations,
        summary,
        fixedViolations,
      },
    });
  })
);

/**
 * POST /api/v1/guard/batch
 *
 * 请求体:
 *   { files: Array<{ filePath: string, content?: string, language?: string }> }
 *
 * 批量检查多个文件（工作区级 Guard 扫描）
 */
router.post(
  '/batch',
  validate(GuardBatchBody),
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const { files } = req.body;

    const container = getServiceContainer();
    const { GuardCheckEngine, detectLanguage } = await import(
      '../../service/guard/GuardCheckEngine.js'
    );

    const engine = await _getEngine(container, GuardCheckEngine);

    const results: Record<string, unknown>[] = [];
    let totalErrors = 0;
    let totalWarnings = 0;

    for (const file of files) {
      if (!file.filePath) {
        continue;
      }

      let code = file.content;
      if (!code) {
        try {
          code = readFileSync(file.filePath, 'utf8');
        } catch {
          results.push({
            filePath: file.filePath,
            language: 'unknown',
            violations: [],
            summary: { total: 0, errors: 0, warnings: 0, infos: 0 },
            error: 'Cannot read file',
          });
          continue;
        }
      }

      const lang = file.language || detectLanguage(file.filePath);
      const violations = engine.checkCode(code, lang, { filePath: file.filePath });

      const summary = {
        total: violations.length,
        errors: violations.filter((v: Record<string, unknown>) => v.severity === 'error').length,
        warnings: violations.filter((v: Record<string, unknown>) => v.severity === 'warning')
          .length,
        infos: violations.filter((v: Record<string, unknown>) => v.severity === 'info').length,
      };

      totalErrors += summary.errors;
      totalWarnings += summary.warnings;

      results.push({
        filePath: file.filePath,
        language: lang,
        violations: violations.map((v: Record<string, unknown>) => ({
          ...v,
          diagnosticMessage: _buildDiagnosticMessage(v),
        })),
        summary,
      });
    }

    res.json({
      success: true,
      data: {
        files: results,
        summary: {
          totalFiles: results.length,
          totalErrors,
          totalWarnings,
        },
      },
    });
  })
);

// ═══ 内部工具 ═══════════════════════════════════════

/**
 * 获取或创建 GuardCheckEngine，并注入 Enhancement Pack 规则
 * @param {object} container - ServiceContainer
 * @param {Function} GuardCheckEngine - GuardCheckEngine class
 * @returns {Promise<object>} engine
 */
async function _getEngine(
  container: ReturnType<typeof getServiceContainer>,
  GuardCheckEngineCtor: new (
    ...args: ConstructorParameters<
      typeof import('../../service/guard/GuardCheckEngine.js').GuardCheckEngine
    >
  ) => InstanceType<typeof import('../../service/guard/GuardCheckEngine.js').GuardCheckEngine>
) {
  let engine: InstanceType<
    typeof import('../../service/guard/GuardCheckEngine.js').GuardCheckEngine
  >;
  try {
    engine = container.get('guardCheckEngine');
  } catch {
    const database = container.get('database');
    engine = new GuardCheckEngineCtor(database);
  }

  // 注入 Enhancement Pack Guard 规则
  if (!engine.isEpInjected()) {
    try {
      const { getEnhancementRegistry } = await import('../../core/enhancement/index.js');
      const registry = getEnhancementRegistry();
      if (registry) {
        const packs = registry.all();
        const guardRules = packs.flatMap((pack) => pack.getGuardRules());
        engine.injectExternalRules(guardRules);
        engine.markEpInjected();
      }
    } catch {
      /* EP not available */
    }
  }

  return engine;
}

/**
 * 构建面向 Agent 优化的诊断消息
 *
 * 双重受众设计：
 *   - 人类看到: 波浪线 + 违规描述
 *   - Agent 看到: ruleId + 明确的 MCP 搜索指令
 *
 * @param {object} violation
 * @returns {string}
 */
function _buildDiagnosticMessage(violation: Record<string, unknown>) {
  const { ruleId, message, fixSuggestion } = violation;

  let msg = `[AutoSnippet Guard] ${ruleId}: ${message}`;

  if (fixSuggestion) {
    msg += `\n修复建议: ${fixSuggestion}`;
  }

  // Agent 指引：嵌入 MCP 搜索建议
  msg += `\n搜 autosnippet_search('${ruleId}') 查找正确写法。`;

  return msg;
}

export default router;
