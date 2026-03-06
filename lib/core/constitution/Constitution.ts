import fs from 'node:fs';
import yaml from 'js-yaml';

export interface ConstitutionRule {
  id: string;
  check: string;
  description?: string;
  [key: string]: unknown;
}

export interface ConstitutionRole {
  id: string;
  name: string;
  description?: string;
  permissions: string[];
  constraints: string[];
  requires_capability?: string[];
  [key: string]: unknown;
}

export interface ConstitutionConfig {
  version?: string;
  effective_date?: string;
  priorities?: ConstitutionPriority[];
  rules?: ConstitutionRule[];
  roles?: ConstitutionRole[];
  capabilities?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ConstitutionPriority {
  id: number;
  [key: string]: unknown;
}

/**
 * Constitution - 宪法加载与管理
 */
export class Constitution {
  priorities: ConstitutionPriority[];
  roles: Map<string, ConstitutionRole>;
  rules: ConstitutionRule[];
  config: ConstitutionConfig;
  configPath: string;
  constructor(configPath: string) {
    this.configPath = configPath;
    this.config = this.loadConfig();
    this.priorities = this.config.priorities || [];
    this.rules = this.config.rules || [];
    this.roles = new Map(this.config.roles?.map((r: ConstitutionRole) => [r.id, r]) || []);
  }

  /**
   * 加载宪法配置
   */
  loadConfig(): ConstitutionConfig {
    if (!fs.existsSync(this.configPath)) {
      throw new Error(`Constitution file not found: ${this.configPath}`);
    }

    const content = fs.readFileSync(this.configPath, 'utf8');
    return yaml.load(content) as ConstitutionConfig;
  }

  /**
   * 获取所有优先级
   */
  getPriorities() {
    return this.priorities;
  }

  /**
   * 获取所有数据守护规则
   */
  getRules() {
    return this.rules;
  }

  /**
   * 获取能力定义
   */
  getCapabilities() {
    return this.config.capabilities || {};
  }

  /**
   * 获取角色需要的能力列表
   */
  getRoleRequiredCapabilities(roleId: string) {
    const role = this.getRole(roleId);
    return role ? role.requires_capability || [] : [];
  }

  /**
   * 获取特定优先级
   */
  getPriority(id: number) {
    return this.priorities.find((p: ConstitutionPriority) => p.id === id);
  }

  /**
   * 获取角色定义
   */
  getRole(roleId: string) {
    return this.roles.get(roleId);
  }

  /**
   * 获取角色权限
   */
  getRolePermissions(roleId: string) {
    const role = this.getRole(roleId);
    return role ? role.permissions : [];
  }

  /**
   * 获取角色约束
   */
  getRoleConstraints(roleId: string) {
    const role = this.getRole(roleId);
    return role ? role.constraints : [];
  }

  /**
   * 获取所有角色
   */
  getAllRoles() {
    return Array.from(this.roles.values());
  }

  /**
   * 验证角色是否存在
   */
  hasRole(roleId: string) {
    return this.roles.has(roleId);
  }

  /**
   * 重新加载宪法（热更新）
   */
  reload() {
    this.config = this.loadConfig();
    this.priorities = this.config.priorities || [];
    this.rules = this.config.rules || [];
    this.roles = new Map(this.config.roles?.map((r: ConstitutionRole) => [r.id, r]) || []);
  }

  /**
   * 导出宪法摘要
   */
  toJSON() {
    return {
      version: this.config.version,
      effectiveDate: this.config.effective_date,
      priorities: this.priorities,
      rules: this.rules.map((r: ConstitutionRule) => ({
        id: r.id,
        description: r.description,
      })),
      roles: Array.from(this.roles.values()).map((r: ConstitutionRole) => ({
        id: r.id,
        name: r.name,
        description: r.description,
      })),
    };
  }
}

export default Constitution;
