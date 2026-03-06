/**
 * KnowledgeModule — 知识 + 搜索 + 向量服务注册
 *
 * 负责注册:
 *   - knowledgeService, knowledgeGraphService, codeEntityGraph, confidenceRouter
 *   - searchEngine, retrievalFunnel, vectorStore, indexingPipeline
 *   - discovererRegistry, enhancementRegistry, languageService, dimensionCopy
 *   - constitution, aiProvider, projectGraph
 *
 * @param {import('../ServiceContainer.js').ServiceContainer} c
 */

import { getDiscovererRegistry } from '../../core/discovery/index.js';
import { getEnhancementRegistry } from '../../core/enhancement/index.js';
import { IndexingPipeline } from '../../infrastructure/vector/IndexingPipeline.js';
import { JsonVectorAdapter } from '../../infrastructure/vector/JsonVectorAdapter.js';
import { CodeEntityGraph } from '../../service/knowledge/CodeEntityGraph.js';
import { ConfidenceRouter } from '../../service/knowledge/ConfidenceRouter.js';
import { KnowledgeGraphService } from '../../service/knowledge/KnowledgeGraphService.js';
import { KnowledgeService } from '../../service/knowledge/KnowledgeService.js';
import { RetrievalFunnel } from '../../service/search/RetrievalFunnel.js';
import { SearchEngine } from '../../service/search/SearchEngine.js';
import { DimensionCopy } from '../../shared/DimensionCopyRegistry.js';
import { LanguageService } from '../../shared/LanguageService.js';

export function register(c) {
  // ═══ Knowledge ═══

  c.singleton('confidenceRouter', (ct) => new ConfidenceRouter({}, ct.get('qualityScorer')));

  c.singleton('knowledgeService', (ct) =>
    new KnowledgeService(
      ct.get('knowledgeRepository'),
      ct.get('auditLogger'),
      ct.get('gateway'),
      ct.get('knowledgeGraphService'),
      {
        fileWriter: ct.get('knowledgeFileWriter'),
        skillHooks: ct.get('skillHooks'),
        confidenceRouter: ct.get('confidenceRouter'),
        qualityScorer: ct.get('qualityScorer'),
      }
    )
  );

  c.singleton('knowledgeGraphService', (ct) => new KnowledgeGraphService(ct.get('database')));

  c.singleton('codeEntityGraph', (ct) => {
    const projectRoot =
      ct.singletons._projectRoot || process.env.ASD_PROJECT_DIR || process.cwd();
    return new CodeEntityGraph(ct.get('database'), { projectRoot });
  });

  // ═══ Search + Vector ═══

  c.singleton(
    'searchEngine',
    (ct) => {
      const aiProvider = ct.singletons.aiProvider || null;
      const embedProvider = ct.singletons._embedProvider || aiProvider;
      return new SearchEngine(ct.get('database'), {
        aiProvider: embedProvider,
        vectorStore: ct.get('vectorStore'),
      });
    },
    { aiDependent: true }
  );

  c.singleton(
    'retrievalFunnel',
    (ct) => {
      const aiProvider = ct.singletons.aiProvider || null;
      const embedProvider = ct.singletons._embedProvider || aiProvider;
      return new RetrievalFunnel({
        vectorStore: ct.get('vectorStore'),
        aiProvider: embedProvider,
      });
    },
    { aiDependent: true }
  );

  c.singleton('vectorStore', (ct) => {
    const projectRoot = ct.singletons._projectRoot || process.cwd();
    const store = new JsonVectorAdapter(projectRoot);
    store.initSync();
    return store;
  });

  c.singleton(
    'indexingPipeline',
    (ct) => {
      const aiProvider = ct.singletons.aiProvider || null;
      const embedProvider = ct.singletons._embedProvider || aiProvider;
      return new IndexingPipeline({
        vectorStore: ct.get('vectorStore'),
        aiProvider: embedProvider,
      });
    },
    { aiDependent: true }
  );

  // ═══ Discovery + Shared ═══

  c.register('discovererRegistry', () => getDiscovererRegistry());
  c.register('enhancementRegistry', () => getEnhancementRegistry());
  c.register('languageService', () => LanguageService);
  c.register('dimensionCopy', () => DimensionCopy);
  c.register('constitution', () => c.singletons.constitution || null);
  c.register('aiProvider', () => c.singletons.aiProvider || null);
  c.register('projectGraph', () => c.singletons.projectGraph || null);
}
