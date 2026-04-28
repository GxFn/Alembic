import type {
  EvidenceFile,
  EvidenceGap,
  EvidenceKnowledgeItem,
  KnowledgeEvidencePack,
  KnowledgeRetrievalInput,
  ScanChangeSet,
} from '#workflows/scan/ScanTypes.js';
import type { SourceRefRecord } from './RetrievalTypes.js';
import { inferLanguage, inferPrimaryLang } from './RetrievalUtils.js';

export interface ProjectSnapshotLensOptions {
  projectRoot?: string;
}

export class ProjectSnapshotLens {
  readonly #projectRoot: string;

  constructor(options: ProjectSnapshotLensOptions = {}) {
    this.#projectRoot = options.projectRoot ?? process.cwd();
  }

  project(input: KnowledgeRetrievalInput, files: EvidenceFile[]): KnowledgeEvidencePack['project'] {
    return {
      root: input.projectRoot || this.#projectRoot,
      primaryLang: input.primaryLang || inferPrimaryLang(files) || 'unknown',
      fileCount: input.files?.length ?? files.filter((file) => file.role === 'changed').length,
      modules: input.scope?.modules ?? [],
    };
  }

  files(input: KnowledgeRetrievalInput, changedFiles: string[]): EvidenceFile[] {
    const byPath = new Map<string, EvidenceFile>();
    const changed = new Set(changedFiles);

    for (const file of input.files ?? []) {
      byPath.set(file.relativePath, {
        relativePath: file.relativePath,
        language: file.language ?? inferLanguage(file.relativePath),
        role: changed.has(file.relativePath) ? 'changed' : 'evidence',
        content: file.content,
        excerpt: file.content,
        hash: file.hash,
      });
    }

    for (const filePath of changedFiles) {
      if (!byPath.has(filePath)) {
        byPath.set(filePath, {
          relativePath: filePath,
          language: inferLanguage(filePath),
          role: 'changed',
        });
      }
    }

    return [...byPath.values()];
  }

  gaps(
    input: KnowledgeRetrievalInput,
    changeSet: ScanChangeSet | undefined,
    knowledgeItems: EvidenceKnowledgeItem[],
    staleRefs: SourceRefRecord[]
  ): EvidenceGap[] {
    const gaps: EvidenceGap[] = [];
    for (const dimension of input.scope?.dimensions ?? []) {
      if (knowledgeItems.length === 0) {
        gaps.push({ dimension, reason: 'low-coverage', priority: 'medium' });
      }
      if ((changeSet?.added.length ?? 0) > 0) {
        gaps.push({ dimension, reason: 'new-module', priority: 'high' });
      }
      if (staleRefs.length > 0) {
        gaps.push({ dimension, reason: 'decaying-knowledge', priority: 'medium' });
      }
    }
    return gaps;
  }
}
