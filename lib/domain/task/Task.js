import { createHash } from 'node:crypto';

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
  constructor(props = {}) {
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
      throw new Error('Cannot claim a pinned decision. Use unpin_decision or revise_decision instead.');
    }
    this.status = 'in_progress';
    this.assignee = assignee;
    this.updatedAt = Math.floor(Date.now() / 1000);
  }

  close(reason = 'Completed') {
    if (this.status === 'pinned') {
      throw new Error('Cannot close a pinned decision directly. Use unpin_decision or revise_decision instead.');
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
      throw new Error('Cannot defer a pinned decision. Use unpin_decision or revise_decision instead.');
    }
    this.status = 'deferred';
    if (reason) {
      this.notes = `[deferred] ${reason}`;
    }
    this.updatedAt = Math.floor(Date.now() / 1000);
  }

  fail(reason) {
    if (this.status === 'closed') {
      throw new Error('Cannot fail a closed task');
    }
    if (this.status === 'pinned') {
      throw new Error('Cannot fail a pinned decision. Use unpin_decision or revise_decision instead.');
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
    if (typeof this.priority !== 'number' || !Number.isInteger(this.priority) || this.priority < 0 || this.priority > 4) {
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

  static fromJSON(data) {
    if (!data) return new Task();
    return new Task(data);
  }

  /**
   * 从数据库行构造 Task（snake_case → camelCase）
   */
  static fromRow(row) {
    if (!row) return null;
    return new Task({
      id: row.id,
      parentId: row.parent_id,
      childSeq: row.child_seq,
      title: row.title,
      description: row.description,
      design: row.design,
      acceptance: row.acceptance,
      notes: row.notes,
      status: row.status,
      priority: row.priority,
      taskType: row.task_type,
      closeReason: row.close_reason,
      contentHash: row.content_hash,
      failCount: row.fail_count,
      lastFailReason: row.last_fail_reason,
      assignee: row.assignee,
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      closedAt: row.closed_at,
      metadata: (() => {
        if (typeof row.metadata !== 'string') return row.metadata || {};
        try { return JSON.parse(row.metadata); } catch { return {}; }
      })(),
    });
  }
}

export default Task;
