/**
 * usePermission — 前端权限管理 Hook
 *
 * 双路径模式：
 *   AUTH_ENABLED=false → 进入页面时调用 /api/v1/auth/probe 获取探针角色
 *   AUTH_ENABLED=true  → 从 useAuth 的 user.role 获取角色
 *
 * 提供角色信息和权限检查方法，供组件做 UI 级别的权限控制
 * （按钮灰化、菜单隐藏等）。
 *
 * 注意：这是前端 UI 层面的权限过滤，后端 Gateway 仍会做最终裁决。
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import axios from 'axios';

/** Constitution 角色 ID */
export type RoleId =
  | 'external_agent'
  | 'chat_agent'
  | 'developer';

export type PermissionMode = 'token' | 'probe';

export interface PermissionState {
  /** 当前角色 */
  role: RoleId;
  /** 当前用户标识 */
  user: string;
  /** 权限模式 */
  mode: PermissionMode;
  /** 是否正在加载 */
  isLoading: boolean;
  /** 是否有管理权限（admin） */
  isAdmin: boolean;
  /** 是否可写（admin 或 contributor） */
  canWrite: boolean;
  /** 是否只读（visitor） */
  isReadOnly: boolean;
  /** 检查是否有某个具体权限 */
  can: (action: string, resource?: string) => boolean;
  /** 探针缓存状态 */
  probeCache: ProbeCache | null;
  /** 重新探测 */
  refresh: () => void;
}

interface ProbeCache {
  cached: boolean;
  result?: string;
  cachedAt?: number;
  expiresAt?: number;
  expired?: boolean;
}

/**
 * 预定义的角色权限矩阵（与后端 Constitution 保持一致）
 */
const ROLE_PERMISSIONS: Record<RoleId, string[]> = {
  developer: ['*'],
  external_agent: [
    'read:recipes', 'read:guard_rules',
    'create:candidates', 'submit:knowledge',
    'read:audit_logs:self',
    'knowledge:bootstrap',
  ],
  chat_agent: [
    'read:recipes', 'read:candidates', 'create:candidates', 'read:guard_rules',
  ],
};

const AUTH_ENABLED = import.meta.env.VITE_AUTH_ENABLED === 'true';

export function usePermission(authRole?: string): PermissionState {
  const [role, setRole] = useState<RoleId>(() => {
    if (AUTH_ENABLED && authRole) return authRole as RoleId;
    return 'developer'; // 默认：本地用户 = 项目 Owner
  });
  const [user, setUser] = useState('anonymous');
  const [mode, setMode] = useState<PermissionMode>(AUTH_ENABLED ? 'token' : 'probe');
  const [isLoading, setIsLoading] = useState(!AUTH_ENABLED); // probe 模式需要加载
  const [probeCache, setProbeCache] = useState<ProbeCache | null>(null);

  /** 调用后端 probe 接口获取角色 */
  const fetchProbe = useCallback(async () => {
    setIsLoading(true);
    try {
      const token = localStorage.getItem('auth_token');
      const headers: Record<string, string> = {};
      if (token) headers.Authorization = `Bearer ${token}`;

      const res = await axios.get('/api/v1/auth/probe', { headers });
      if (res.data.success) {
        const d = res.data.data;
        setRole(d.role as RoleId);
        setUser(d.user);
        setMode(d.mode);
        setProbeCache(d.probeCache ?? null);
      }
    } catch {
      // 探针失败 → developer（本地用户默认全权）
      setRole('developer');
    } finally {
      setIsLoading(false);
    }
  }, []);

  // AUTH 模式：直接用角色，不走探针
  useEffect(() => {
    if (AUTH_ENABLED) {
      if (authRole) {
        setRole(authRole as RoleId);
        setMode('token');
        setIsLoading(false);
      }
      return;
    }
    // 非 AUTH 模式：页面进入时探测
    fetchProbe();
  }, [authRole, fetchProbe]);

  /** 权限检查 */
  const can = useCallback((action: string, resource?: string) => {
    const perms = ROLE_PERMISSIONS[role] || [];
    if (perms.includes('*')) return true;

    // 精确匹配 action:resource
    const full = resource ? `${action}:${resource}` : action;
    if (perms.includes(full)) return true;

    // action 通配符
    const actionPart = action.split(':')[0];
    if (perms.includes(`${actionPart}:*`)) return true;

    // read:* 通配
    if (actionPart === 'read' && perms.includes('read:*')) return true;

    return false;
  }, [role]);

  const isAdmin = useMemo(() => role === 'developer', [role]);
  const canWrite = useMemo(() => role === 'developer', [role]);
  const isReadOnly = useMemo(() => role !== 'developer', [role]);

  return {
    role,
    user,
    mode,
    isLoading,
    isAdmin,
    canWrite,
    isReadOnly,
    can,
    probeCache,
    refresh: fetchProbe,
  };
}
