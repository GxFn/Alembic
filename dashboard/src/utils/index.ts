export const isShellTarget = (name: string) => {
  const shellKeywords = ['Example', 'Demo', 'Sample', 'Tests', 'Spec', 'Mock', 'Runner'];
  return shellKeywords.some(key => name.endsWith(key) || name.includes(key));
};

/** 静默提交的虚拟 target（_watch、_draft、_cli） */
export const isSilentTarget = (name: string) => name.startsWith('_');
/** 未保存暂存池（SPM/New Recipe 分析结果），排到底端，24h 过期 */
export const isPendingTarget = (name: string) => name === '_pending';

/** 写权限 403 时的友好提示（勿擅动核心代码） */
export const WRITE_FORBIDDEN_MSG =
  '您暂无写入权限，无法保存。如需此权限请联系管理员；请勿擅自修改核心代码或安装包，以免影响团队协作与数据安全。';

/** 若 err 为写权限 403（RECIPE_WRITE_FORBIDDEN），返回友好提示；否则返回 null */
export function getWritePermissionErrorMsg(err: unknown): string | null {
  const res = (err as { response?: { status?: number; data?: { code?: string; error?: string } } })?.response;
  if (res?.status !== 403) return null;
  const code = res.data?.code;
  const error = res.data?.error;
  if (code === 'RECIPE_WRITE_FORBIDDEN' || (typeof error === 'string' && error.includes('没权限'))) {
  return WRITE_FORBIDDEN_MSG;
  }
  return null;
}

/** 保存过于频繁 429 时的提示 */
export const RATE_LIMIT_MSG = '保存过于频繁，请稍后再试。';

/** 若 err 为 403 或 429（写权限/频率限制），返回友好提示；否则返回 null。用于保存/删除接口的 catch */
export function getSaveErrorMsg(err: unknown): string | null {
  const res = (err as { response?: { status?: number; data?: { code?: string; error?: string } } })?.response;
  if (!res?.data) return null;
  if (res.status === 403) return getWritePermissionErrorMsg(err) ?? null;
  if (res.status === 429 && res.data?.code === 'RECIPE_SAVE_RATE_LIMIT') return RATE_LIMIT_MSG;
  return null;
}
