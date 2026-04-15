/**
 * DeliveryVerifier — Bootstrap/Rescan 完成后交付完整性检查
 *
 * 验证以下交付物是否正确生成:
 *   - Channel A: alembic-project-rules.mdc
 *   - Channel B: alembic-patterns 系列文件
 *   - Channel C: .cursor/skills/ 目录
 *   - Channel F: AGENTS.md, CLAUDE.md, copilot-instructions.md
 *   - Wiki: meta.json
 *   - Skills: project 级 Skill 目录
 *   - 向量索引: asvec 文件
 *
 * @module service/bootstrap/DeliveryVerifier
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  getContextIndexPath,
  getProjectKnowledgePath,
  getProjectSkillsPath,
} from '#infra/config/Paths.js';

// ── 类型定义 ────────────────────────────────────────────────

/** §10.5 交付通道标识 */
export type DeliveryChannel =
  | 'channelA'
  | 'channelB'
  | 'channelC'
  | 'channelF'
  | 'wiki'
  | 'skills'
  | 'vectorIndex';

/** 单通道验证结果 */
export interface ChannelVerification {
  generated: boolean;
  file?: string;
  files?: string[];
  count?: number;
  size?: number;
  skillCount?: number;
  pageCount?: number;
  documentCount?: number;
  agentsMd?: boolean;
  claudeMd?: boolean;
  copilotInstructions?: boolean;
  rebuilt?: boolean;
}

/** 完整验证结果 */
export interface DeliveryVerification {
  channelA: ChannelVerification;
  channelB: ChannelVerification;
  channelC: ChannelVerification;
  channelF: ChannelVerification;
  wiki: ChannelVerification;
  skills: ChannelVerification;
  vectorIndex: ChannelVerification;
  allPassed: boolean;
  failures: string[];
}

// ── DeliveryVerifier ────────────────────────────────────────

export class DeliveryVerifier {
  readonly #projectRoot: string;

  constructor(projectRoot: string) {
    this.#projectRoot = projectRoot;
  }

  /**
   * 验证所有交付物是否正确生成
   */
  verify(): DeliveryVerification {
    const failures: string[] = [];

    // Channel A: .cursor/rules/alembic-project-rules.mdc
    const channelA = this.#verifyChannelA();
    if (!channelA.generated) {
      failures.push('Channel A: alembic-project-rules.mdc missing or empty');
    }

    // Channel B: .cursor/rules/alembic-patterns-*.mdc
    const channelB = this.#verifyChannelB();
    if (!channelB.generated) {
      failures.push('Channel B: no alembic-patterns-*.mdc files found');
    }

    // Channel C: .cursor/skills/
    const channelC = this.#verifyChannelC();
    if (!channelC.generated) {
      failures.push('Channel C: .cursor/skills/ directory missing');
    }

    // Channel F: AGENTS.md, CLAUDE.md, copilot-instructions.md
    const channelF = this.#verifyChannelF();
    if (!channelF.generated) {
      failures.push('Channel F: agent instruction files incomplete');
    }

    // Wiki
    const wiki = this.#verifyWiki();

    // Skills
    const skills = this.#verifySkills();

    // Vector Index
    const vectorIndex = this.#verifyVectorIndex();

    return {
      channelA,
      channelB,
      channelC,
      channelF,
      wiki,
      skills,
      vectorIndex,
      allPassed: failures.length === 0,
      failures,
    };
  }

  // ─── 各通道验证 ───────────────────────────────────────

  #verifyChannelA(): ChannelVerification {
    const filePath = path.join(this.#projectRoot, '.cursor', 'rules', 'alembic-project-rules.mdc');
    if (fs.existsSync(filePath)) {
      const size = fs.statSync(filePath).size;
      return { generated: size > 0, file: 'alembic-project-rules.mdc', size };
    }
    return { generated: false };
  }

  #verifyChannelB(): ChannelVerification {
    const rulesDir = path.join(this.#projectRoot, '.cursor', 'rules');
    if (!fs.existsSync(rulesDir)) {
      return { generated: false, files: [], count: 0 };
    }
    const files = fs
      .readdirSync(rulesDir)
      .filter((f) => f.startsWith('alembic-patterns-') && f.endsWith('.mdc'));
    return {
      generated: files.length > 0,
      files,
      count: files.length,
    };
  }

  #verifyChannelC(): ChannelVerification {
    const skillsDir = path.join(this.#projectRoot, '.cursor', 'skills');
    if (!fs.existsSync(skillsDir)) {
      return { generated: false, skillCount: 0 };
    }
    const count = fs.readdirSync(skillsDir).length;
    return { generated: true, skillCount: count };
  }

  #verifyChannelF(): ChannelVerification {
    const agentsMd = this.#hasAlembicSection(path.join(this.#projectRoot, 'AGENTS.md'));
    const claudeMd = this.#hasAlembicSection(path.join(this.#projectRoot, 'CLAUDE.md'));
    const copilotInstructions = this.#hasAlembicSection(
      path.join(this.#projectRoot, '.github', 'copilot-instructions.md')
    );
    return {
      generated: agentsMd || claudeMd || copilotInstructions,
      agentsMd,
      claudeMd,
      copilotInstructions,
    };
  }

  #verifyWiki(): ChannelVerification {
    const kbPath = getProjectKnowledgePath(this.#projectRoot);
    const metaPath = path.join(kbPath, 'wiki', 'meta.json');
    if (fs.existsSync(metaPath)) {
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as {
          pages?: unknown[];
        };
        return {
          generated: true,
          pageCount: meta.pages?.length || 0,
        };
      } catch {
        return { generated: false };
      }
    }
    return { generated: false };
  }

  #verifySkills(): ChannelVerification {
    const skillsDir = getProjectSkillsPath(this.#projectRoot);
    if (!fs.existsSync(skillsDir)) {
      return { generated: false, skillCount: 0 };
    }
    const dirs = fs
      .readdirSync(skillsDir)
      .filter(
        (d) => d.startsWith('project-') && fs.statSync(path.join(skillsDir, d)).isDirectory()
      );
    return { generated: dirs.length > 0, skillCount: dirs.length };
  }

  #verifyVectorIndex(): ChannelVerification {
    const indexDir = getContextIndexPath(this.#projectRoot);
    if (!fs.existsSync(indexDir)) {
      return { generated: false, rebuilt: false, documentCount: 0 };
    }
    const asvecFiles = fs
      .readdirSync(indexDir)
      .filter((f) => f.endsWith('.asvec') || f.endsWith('.json'));
    return {
      generated: asvecFiles.length > 0,
      rebuilt: true,
      documentCount: asvecFiles.length,
    };
  }

  // ─── 辅助 ───────────────────────────────────────────

  #hasAlembicSection(filePath: string): boolean {
    try {
      if (!fs.existsSync(filePath)) {
        return false;
      }
      const content = fs.readFileSync(filePath, 'utf8');
      return content.includes('asd:begin');
    } catch {
      return false;
    }
  }
}
