/**
 * TargetClassifier — Target/文件分类辅助
 *
 * 从 bootstrap.js 拆分而来，负责：
 *   - Target 名称 → 模块职责推断
 *   - 文件名 → 分析优先级推断
 */

/** 根据 Target 名称推断模块职责 */
export function inferTargetRole(targetName) {
  const n = targetName.toLowerCase();
  if (/core|kit|shared|common|foundation|base/i.test(n)) {
    return 'core';
  }
  if (/service|manager|provider|repository|store/i.test(n)) {
    return 'service';
  }
  if (/ui|view|screen|component|widget/i.test(n)) {
    return 'ui';
  }
  if (/network|api|http|grpc|socket/i.test(n)) {
    return 'networking';
  }
  if (/storage|database|cache|persist|realm|coredata/i.test(n)) {
    return 'storage';
  }
  if (/test|spec|mock|stub|fake/i.test(n)) {
    return 'test';
  }
  if (/app|main|launch|entry/i.test(n)) {
    return 'app';
  }
  if (/router|coordinator|navigation/i.test(n)) {
    return 'routing';
  }
  if (/util|helper|extension|tool/i.test(n)) {
    return 'utility';
  }
  if (/model|entity|dto|schema/i.test(n)) {
    return 'model';
  }
  if (/auth|login|session|token/i.test(n)) {
    return 'auth';
  }
  if (/config|setting|environment|constant/i.test(n)) {
    return 'config';
  }
  return 'feature';
}

/** 根据文件名推断分析优先级 */
export function inferFilePriority(filename) {
  const n = filename.toLowerCase();
  // High: core definitions, services, protocols, configs
  if (
    /protocol|interface|delegate|service|manager|provider|config|constant|router|coordinator|factory|builder/i.test(
      n
    )
  ) {
    return 'high';
  }
  if (/^(app|main|launch|entry|bootstrap)/i.test(n)) {
    return 'high';
  }
  // Low: tests, extensions, helpers, generated
  if (/test|spec|mock|stub|fake|\+|\bext\b|extension|helper|generated|\.pb\./i.test(n)) {
    return 'low';
  }
  if (/readme|changelog|license/i.test(n)) {
    return 'low';
  }
  // Medium: everything else
  return 'medium';
}
