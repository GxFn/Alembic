import { Policy, type PolicyResult } from './Policy.js';

export interface QualityGatePolicyOptions {
  minEvidenceLength?: number;
  minFileRefs?: number;
  minToolCalls?: number;
  customValidator?: (result: PolicyResult) => { ok: boolean; reason?: string };
}

export class QualityGatePolicy extends Policy {
  #minEvidenceLength;
  #minFileRefs;
  #minToolCalls;
  #customValidator;

  constructor({
    minEvidenceLength = 500,
    minFileRefs = 3,
    minToolCalls = 2,
    customValidator,
  }: QualityGatePolicyOptions = {}) {
    super();
    this.#minEvidenceLength = minEvidenceLength;
    this.#minFileRefs = minFileRefs;
    this.#minToolCalls = minToolCalls;
    this.#customValidator = customValidator || null;
  }

  get name() {
    return 'quality_gate';
  }

  validateAfter(result: PolicyResult) {
    const reasons: string[] = [];

    if (result.reply && result.reply.length < this.#minEvidenceLength) {
      reasons.push(`分析长度不足: ${result.reply.length} < ${this.#minEvidenceLength}`);
    }

    if (result.reply) {
      const fileRefCount = (result.reply.match(/[\w/-]+\.\w{1,6}/g) || []).length;
      if (fileRefCount < this.#minFileRefs) {
        reasons.push(`文件引用不足: ${fileRefCount} < ${this.#minFileRefs}`);
      }
    }

    if ((result.toolCalls?.length || 0) < this.#minToolCalls) {
      reasons.push(`工具调用不足: ${result.toolCalls?.length || 0} < ${this.#minToolCalls}`);
    }

    if (this.#customValidator) {
      const custom = this.#customValidator(result);
      if (!custom.ok && custom.reason) {
        reasons.push(custom.reason);
      }
    }

    return reasons.length === 0 ? { ok: true } : { ok: false, reason: reasons.join('; ') };
  }

  toGateConfig() {
    return {
      minEvidenceLength: this.#minEvidenceLength,
      minFileRefs: this.#minFileRefs,
      minToolCalls: this.#minToolCalls,
      custom: this.#customValidator,
    };
  }
}
