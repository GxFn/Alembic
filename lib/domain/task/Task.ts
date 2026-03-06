import { createHash } from 'node:crypto';

export interface TaskProps {
  id?: string | null;
  parentId?: string | null;
  childSeq?: number;
  title?: string;
  description?: string;
  design?: string;
  acceptance?: string;
  notes?: string;
  status?: string;
  priority?: number;
  taskType?: string;
  closeReason?: string;
  failCount?: number;
  lastFailReason?: string;
  contentHash?: string | null;
  assignee?: string;
  createdBy?: string;
  createdAt?: number;
  updatedAt?: number;
  closedAt?: number | null;
  knowledgeContext?: Record<string, unknown> | null;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

interface TaskRow {
  id?: unknown;
  parent_id?: unknown;
  child_seq?: unknown;
  title?: unknown;
  description?: unknown;
  design?: unknown;
  acceptance?: unknown;
  notes?: unknown;
  status?: unknown;
  priority?: unknown;
  task_type?: unknown;
  close_reason?: unknown;
  content_hash?: unknown;
  fail_count?: unknown;
  last_fail_reason?: unknown;
  assignee?: unknown;
  created_by?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
  closed_at?: unknown;
  metadata?: unknown;
  [key: string]: unknown;
}

/**
 * Task — 任务实体
 *
 * 参考 Beads Issue 结构，裁剪为 AutoSnippet 所需的核心字段。
 *
 * 字段分组：
 *   Core Identification → id, parentId, contentHash
 *   Content             → title, description, design, acceptance
 *   Status & Workflow   → status, priority, taskType
 *   Assignment          → assignee, claimedAt
 *   Timestamps          → createdAt, updatedAt, closedAt
 *   Knowledge Bridge    → knowledgeContext (运行时，不持久化)
 */
export class Task {
  acceptance: string;
  assignee: string;
  childSeq: number;
  closeReason: string;
  closedAt: number | null;
  contentHash: string | null;
  createdAt: number;
  createdBy: string;
  description: string;
  design: string;
  failCount: number;
  id: string | null;
  lastFailReason: string;
  metadata: Record<string, unknown>;
  notes: string;
  parentId: string | null;
  priority: number;
  status: string;
  taskType: string;
  title: string;
  updatedAt: number;
  knowledgeContext: Record<string, unknown> | null;
  constructor(props: TaskProps = {}) {
    // ── Core Identification ──
    this.id = props.id || null;
    this.parentId = props.parentId || null;
    this.childSeq = props.childSeq || 0;

    // ── Content ──
    this.title = props.title || '';
    this.description = props.description || '';
    this.design = props.design || '';
    this.acceptance = props.acceptance || '';
    this.notes = props.notes || '';

    // ── Status & Workflow ──
    this.status = props.status || 'open';
    this.priority = props.priority ?? 2;
    this.taskType = props.taskType || 'task';
    this.closeReason = props.closeReason || '';
    this.failCount = props.failCount || 0;
    this.lastFailReason = props.lastFailReason || '';

    // ── Content Hash (去重) ──
    this.contentHash = props.contentHash || null;

    // ── Assignment ──
    this.assignee = props.assignee || '';
    this.createdBy = props.createdBy || 'agent';

    // ── Timestamps ──
    this.createdAt = props.createdAt || Math.floor(Date.now() / 1000);
    this.updatedAt = props.updatedAt || Math.floor(Date.now() / 1000);
    this.closedAt = props.closedAt || null;

    // ── Knowledge Bridge (运行时填充, 不持久化) ──
    this.knowledgeContext = props.knowledgeContext || null;

    // ── Metadata (可扩展 JSON) ──
    this.metadata = props.metadata || {};
  }

  // ── 生命周期方法 ──

  claim(assignee = 'agent') {
    if (this.status === 'closed') {
      throw new Error('Cannot claim a closed task');
    }
    if (this.status === 'pinned') {
      throw new Error(
        'Cannot claim a pinned decision. Use unpin_decision or revise_decision instead.'
      );
    }
    this.status = 'in_progress';
    this.assignee = assignee;
    this.updatedAt = Math.floor(Date.now() / 1000);
  }

  close(reason = 'Completed') {
    if (this.status === 'pinned') {
      throw new Error(
        'Cannot close a pinned decision directly. Use unpin_decision or revise_decision instead.'
      );
    }
    this.status = 'closed';
    this.closeReason = reason;
    this.closedAt = Math.floor(Date.now() / 1000);
    this.updatedAt = this.closedAt;
  }

  reopen() {
    this.status = 'open';
    this.closedAt = null;
    this.closeReason = '';
    this.updatedAt = Math.floor(Date.now() / 1000);
  }

  pin() {
    if (this.status === 'closed') {
      throw new Error('Cannot pin a closed task');
    }
    this.status = 'pinned';
    this.updatedAt = Math.floor(Date.now() / 1000);
  }

  unpin(reason = '') {
    if (this.status !== 'pinned') {
      throw new Error('Can only unpin a pinned task');
    }
    this.status = 'closed';
    this.closeReason = reason || 'Unpinned by user';
    this.closedAt = Math.floor(Date.now() / 1000);
    this.updatedAt = this.closedAt;
  }

  defer(reason = '') {
    if (this.status === 'pinned') {
      throw new Error(
        'Cannot defer a pinned decision. Use unpin_decision or revise_decision instead.'
      );
    }
    this.status = 'deferred';
    if (reason) {
      this.notes = `[deferred] ${reason}`;
    }
    this.updatedAt = Math.floor(Date.now() / 1000);
  }

  fail(reason: string) {
    if (this.status === 'closed') {
      throw new Error('Cannot fail a closed task');
    }
    if (this.status === 'pinned') {
      throw new Error(
        'Cannot fail a pinned decision. Use unpin_decision or revise_decision instead.'
      );
    }
    this.status = 'open';
    this.failCount += 1;
    this.lastFailReason = reason || 'Unknown failure';
    this.assignee = '';
    this.updatedAt = Math.floor(Date.now() / 1000);
  }

  /**
   * 计算内容哈希（用于去重检测）
   * 相同标题+描述+类型 = 重复任务
   */
  computeContentHash() {
    const content = `${this.title}|${this.description}|${this.taskType}`;
    this.contentHash = createHash('sha256').update(content).digest('hex').substring(0, 12);
    return this.contentHash;
  }

  // ── 校验 ──

  validate() {
    if (!this.title || this.title.length === 0) {
      throw new Error('title is required');
    }
    if (this.title.length > 500) {
      throw new Error(`title must be 500 characters or less (got ${this.title.length})`);
    }
    if (
      typeof this.priority !== 'number' ||
      !Number.isInteger(this.priority) ||
      this.priority < 0 ||
      this.priority > 4
    ) {
      throw new Error(`priority must be an integer between 0 and 4 (got ${this.priority})`);
    }
    const validStatuses = ['open', 'in_progress', 'deferred', 'closed', 'pinned'];
    if (!validStatuses.includes(this.status)) {
      throw new Error(`invalid status: ${this.status}`);
    }
    const validTypes = ['epic', 'task', 'bug', 'chore', 'decision'];
    if (!validTypes.includes(this.taskType)) {
      throw new Error(`invalid task type: ${this.taskType}`);
    }
    if (this.status === 'closed' && !this.closedAt) {
      throw new Error('closed tasks must have closedAt timestamp');
    }
    return true;
  }

  /**
   * 是否有效（快捷校验）
   */
  isValid() {
    try {
      this.validate();
      return true;
    } catch {
      return false;
    }
  }

  toJSON() {
    return {
      id: this.id,
      parentId: this.parentId,
      title: this.title,
      description: this.description,
      design: this.design,
      acceptance: this.acceptance,
      notes: this.notes,
      status: this.status,
      priority: this.priority,
      taskType: this.taskType,
      closeReason: this.closeReason,
      assignee: this.assignee,
      createdBy: this.createdBy,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      closedAt: this.closedAt,
      contentHash: this.contentHash,
      failCount: this.failCount,
      lastFailReason: this.lastFailReason,
      metadata: this.metadata,
      ...(this.knowledgeContext ? { knowledgeContext: this.knowledgeContext } : {}),
    };
  }

  static fromJSON(data: unknown): Task {
    if (!data) {
      return new Task();
    }
    return new Task(data as TaskProps);
  }

  /**
   * 从数据库行构造 Task（snake_case → camelCase）
   */
  static fromRow(row: TaskRow | null): Task | null {
    if (!row) {
      return null;
    }
    return new Task({
      id: row.id as string | undefined,
      parentId: row.parent_id as string | null | undefined,
      childSeq: row.child_seq as number | undefined,
      title: row.title as string | undefined,
      description: row.description as string | undefined,
      design: row.design as string | undefined,
      acceptance: row.acceptance as string | undefined,
      notes: row.notes as string | undefined,
      status: row.status as string | undefined,
      priority: row.priority as number | undefined,
      taskType: row.task_type as string | undefined,
      closeReason: row.close_reason as string | undefined,
      contentHash: row.content_hash as string | null | undefined,
      failCount: row.fail_count as number | undefined,
      lastFailReason: row.last_fail_reason as string | undefined,
      assignee: row.assignee as string | undefined,
      createdBy: row.created_by as string | undefined,
      createdAt: row.created_at as number | undefined,
      updatedAt: row.updated_at as number | undefined,
      closedAt: row.closed_at as number | null | undefined,
      metadata: (() => {
        if (typeof row.metadata !== 'string') {
          return (row.metadata as Record<string, unknown>) || {};
        }
        try {
          return JSON.parse(row.metadata) as Record<string, unknown>;
        } catch {
          return {};
        }
      })(),
    });
  }
}

export default Task;
