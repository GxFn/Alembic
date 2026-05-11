/**
 * WriteZone — 本地化写入管理系统
 *
 * 三区模型：
 *   Zone.Project → projectRoot  (IDE 配置、Agent 指令等必须留在真实项目目录的文件)
 *   Zone.Data    → dataRoot     (知识库、运行时数据，Ghost 模式下外置到 ~/.asd/workspaces/<id>/)
 *   Zone.Global  → ~/.asd/      (跨项目的全局配置和缓存)
 *
 * 设计要点：
 *   - 编译期通过 ZonedPath<Z> branded type 防止不同 Zone 路径混用
 *   - Ghost 模式透明 — 消费者只需选对 Zone，路径自动解析
 *   - 同时提供同步和异步 API，覆盖全部写入模式
 *   - Zone.Global 使用独立的前缀校验（PathGuard 白名单不覆盖 ~/.asd/ 全局目录）
 *   - 支持 DI 注入和静态工厂两种获取方式
 *
 * @module infrastructure/io/WriteZone
 */

import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import pathGuard from '#shared/PathGuard.js';
import type { WorkspaceResolver } from '#shared/WorkspaceResolver.js';

// ─── Zone 常量 & 类型 ───────────────────────────────

/**
 * 写入区域常量
 *
 * 使用 `as const` 而非 `const enum`，
 * 因为项目启用了 isolatedModules: true。
 */
export const Zone = {
  Project: 'project',
  Data: 'data',
  Global: 'global',
} as const;

export type Zone = (typeof Zone)[keyof typeof Zone];

/** 类型化的路径标记 — 防止不同 Zone 的路径混用 */
export interface ZonedPath<Z extends Zone = Zone> {
  readonly zone: Z;
  readonly absolute: string;
}

export type ProjectPath = ZonedPath<'project'>;
export type DataPath = ZonedPath<'data'>;
export type GlobalPath = ZonedPath<'global'>;

// ─── WriteZone 核心类 ───────────────────────────────

export class WriteZone {
  readonly #resolver: WorkspaceResolver;
  readonly #globalRoot: string;

  constructor(resolver: WorkspaceResolver) {
    this.#resolver = resolver;
    this.#globalRoot = path.join(process.env.HOME || process.env.USERPROFILE || '', '.asd');
  }

  // ─── 静态工厂（pre-DI 场景） ─────────────────────

  /** 从已有的 WorkspaceResolver 创建 — SetupService/UpgradeService 等 */
  static fromResolver(resolver: WorkspaceResolver): WriteZone {
    return new WriteZone(resolver);
  }

  /** 从项目根路径创建（异步）— CLI 工具、脚本等一次性场景 */
  static async fromProjectRoot(projectRoot: string): Promise<WriteZone> {
    const { WorkspaceResolver: WR } = await import('#shared/WorkspaceResolver.js');
    return new WriteZone(WR.fromProject(projectRoot));
  }

  // ─── 路径解析 ─────────────────────────────────────

  project(relativePath: string): ProjectPath {
    const abs = path.resolve(this.#resolver.projectRoot, relativePath);
    return { zone: Zone.Project, absolute: abs };
  }

  data(relativePath: string): DataPath {
    const abs = path.resolve(this.#resolver.dataRoot, relativePath);
    return { zone: Zone.Data, absolute: abs };
  }

  global(relativePath: string): GlobalPath {
    const abs = path.resolve(this.#globalRoot, relativePath);
    return { zone: Zone.Global, absolute: abs };
  }

  // ─── 常用数据区快捷路径 ──────────────────────────

  /** .asd/ 子路径（运行时数据） */
  runtime(sub: string): DataPath {
    return this.data(path.join('.asd', sub));
  }

  /** Alembic/ 子路径（知识库数据） */
  knowledge(sub: string): DataPath {
    return this.data(path.join(this.#resolver.knowledgeBaseDir, sub));
  }

  // ─── Resolver 透传（只读访问） ────────────────────

  get projectRoot(): string {
    return this.#resolver.projectRoot;
  }

  get dataRoot(): string {
    return this.#resolver.dataRoot;
  }

  get ghost(): boolean {
    return this.#resolver.ghost;
  }

  // ─── 同步写入操作 ─────────────────────────────────

  ensureDir(target: ZonedPath): string {
    this.#guardWrite(target);
    if (!fs.existsSync(target.absolute)) {
      fs.mkdirSync(target.absolute, { recursive: true });
    }
    return target.absolute;
  }

  writeFile(target: ZonedPath, content: string | Buffer): void {
    this.#guardWrite(target);
    this.#ensureParentDir(target.absolute);
    fs.writeFileSync(target.absolute, content);
  }

  appendFile(target: ZonedPath, content: string): void {
    this.#guardWrite(target);
    this.#ensureParentDir(target.absolute);
    fs.appendFileSync(target.absolute, content);
  }

  copyFile(src: string, dest: ZonedPath): void {
    this.#guardWrite(dest);
    this.#ensureParentDir(dest.absolute);
    fs.copyFileSync(src, dest.absolute);
  }

  remove(target: ZonedPath, options?: { recursive?: boolean }): void {
    this.#guardWrite(target);
    fs.rmSync(target.absolute, { force: true, ...options });
  }

  /**
   * 移动/重命名 — 自动处理跨文件系统 EXDEV 错误
   * (Ghost 模式下 Zone.Project 和 Zone.Data 可能在不同挂载点)
   */
  rename(src: ZonedPath, dest: ZonedPath): void {
    this.#guardWrite(src);
    this.#guardWrite(dest);
    try {
      fs.renameSync(src.absolute, dest.absolute);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
        this.#ensureParentDir(dest.absolute);
        fs.cpSync(src.absolute, dest.absolute, { recursive: true });
        fs.rmSync(src.absolute, { recursive: true, force: true });
      } else {
        throw err;
      }
    }
  }

  // ─── 异步写入操作 ─────────────────────────────────

  async ensureDirAsync(target: ZonedPath): Promise<string> {
    this.#guardWrite(target);
    await fsPromises.mkdir(target.absolute, { recursive: true });
    return target.absolute;
  }

  async writeFileAsync(target: ZonedPath, content: string | Buffer): Promise<void> {
    this.#guardWrite(target);
    await this.#ensureParentDirAsync(target.absolute);
    await fsPromises.writeFile(target.absolute, content);
  }

  async appendFileAsync(target: ZonedPath, content: string): Promise<void> {
    this.#guardWrite(target);
    await this.#ensureParentDirAsync(target.absolute);
    await fsPromises.appendFile(target.absolute, content);
  }

  async removeAsync(target: ZonedPath, options?: { recursive?: boolean }): Promise<void> {
    this.#guardWrite(target);
    await fsPromises.rm(target.absolute, { force: true, ...options });
  }

  // ─── 安全校验 ─────────────────────────────────────

  #guardWrite(target: ZonedPath): void {
    switch (target.zone) {
      case Zone.Project:
      case Zone.Data:
        try {
          pathGuard.assertProjectWriteSafe(target.absolute);
        } catch (err: unknown) {
          const isDataZone = target.zone === Zone.Data;
          const isUnderDataRoot =
            isDataZone && target.absolute.startsWith(this.#resolver.dataRoot + path.sep);
          if (isUnderDataRoot) {
            throw new Error(
              `[WriteZone] Zone.Data 写入被 PathGuard 拒绝: ${target.absolute}\n` +
                `  dataRoot=${this.#resolver.dataRoot}\n` +
                `  请确保 Bootstrap.initializeWorkspaceResolver() 已执行（Ghost dataRoot 需加入白名单）`
            );
          }
          throw err;
        }
        break;
      case Zone.Global:
        this.#assertGlobalSafe(target.absolute);
        break;
    }
  }

  /**
   * Global 区专用校验 — 确保写入路径在 ~/.asd/ 目录下
   * 不使用 PathGuard.assertSafe()（默认白名单仅覆盖 cache/snippets）
   */
  #assertGlobalSafe(targetPath: string): void {
    const resolved = path.resolve(targetPath);
    const normalizedGlobal = path.resolve(this.#globalRoot);
    if (!resolved.startsWith(normalizedGlobal + path.sep) && resolved !== normalizedGlobal) {
      throw new Error(`[WriteZone] Global 写入越界: ${resolved} 不在 ${normalizedGlobal}/ 下`);
    }
  }

  // ─── 内部工具 ─────────────────────────────────────

  #ensureParentDir(filePath: string): void {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  async #ensureParentDirAsync(filePath: string): Promise<void> {
    const dir = path.dirname(filePath);
    await fsPromises.mkdir(dir, { recursive: true });
  }
}

export default WriteZone;
