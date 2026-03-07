/**
 * CliLogger — 轻量 CLI 输出工具
 *
 * 替代 console.log / console.error / console.warn，提供：
 * - 语义化输出接口（log / info / warn / error / success / json / blank）
 * - 统一 stdout / stderr 通道分离
 * - 可通过 quiet 模式静默输出（便于测试或 --json 场景）
 * - Guard 规则合规（不触发 js-no-console-log）
 *
 * @example
 *   import { cli } from '../lib/cli/CliLogger.js';
 *   cli.log('Hello');         // stdout
 *   cli.error('Failed');      // stderr
 *   cli.json({ ok: true });   // stdout, pretty-printed JSON
 */

class CliLogger {
  #quiet = false;

  /** 静默模式：抑制 stdout 输出（stderr 仍然输出） */
  set quiet(value) {
    this.#quiet = !!value;
  }

  get quiet() {
    return this.#quiet;
  }

  // ── stdout 输出 ──────────────────────────────────

  /** 普通信息输出 → stdout */
  log(msg = '') {
    if (!this.#quiet) {
      process.stdout.write(`${msg}\n`);
    }
  }

  /** 信息提示 → stdout（语义同 log） */
  info(msg: string) {
    if (!this.#quiet) {
      process.stdout.write(`${msg}\n`);
    }
  }

  /** 成功提示 → stdout */
  success(msg: string) {
    if (!this.#quiet) {
      process.stdout.write(`${msg}\n`);
    }
  }

  /** JSON 格式输出 → stdout */
  json(obj: unknown) {
    process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
  }

  /** 空行 → stdout */
  blank() {
    if (!this.#quiet) {
      process.stdout.write('\n');
    }
  }

  // ── stderr 输出 ──────────────────────────────────

  /** 错误信息 → stderr */
  error(msg: string) {
    process.stderr.write(`${msg}\n`);
  }

  /** 警告信息 → stderr */
  warn(msg: string) {
    process.stderr.write(`${msg}\n`);
  }

  /** 调试信息 → stderr（仅 ASD_DEBUG=1 时输出） */
  debug(msg: string) {
    if (process.env.ASD_DEBUG === '1') {
      process.stderr.write(`${msg}\n`);
    }
  }
}

/** 全局单例 */
export const cli = new CliLogger();
export default cli;
