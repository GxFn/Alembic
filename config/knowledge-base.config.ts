/**
 * Knowledge Base 配置文件
 * 向量数据库、检索、内存等系统配置
 */

export default {
  // Vector Database 配置 (v2: 使用内置 HNSW, 无需外部服务)
  vectorDb: {
    // 保留 Milvus 配置以兼容旧版 — 新版默认使用内置 HNSW
    type: process.env.VECTOR_DB_TYPE || 'hnsw',
    connection: {
      uri: process.env.MILVUS_URI || 'http://localhost:19530',
      dbName: 'autosnippet',
    },
    collection: {
      name: 'recipes',
      dimension: 768, // text-embedding-3-small
      indexType: 'IVF_FLAT',
      metricType: 'L2', // Euclidean distance
      nlist: 128, // Number of inverted lists
    },
    timeoutMs: 30000,
  },

  // 索引配置 (v2: 集成 BatchEmbedder + Chunker v2)
  indexing: {
    batchSize: 32, // embed 每批大小
    maxConcurrency: 2, // embed 并行请求数
    embeddingModel: 'text-embedding-3-small', // OpenAI embedding model
    embeddingDimension: 768,
    cachePath: '.autosnippet/cache',
    enableCaching: true,
    cacheExpiry: 7 * 24 * 60 * 60, // 7 days in seconds
    maxCacheSize: 500, // Maximum number of cached embeddings
    chunking: {
      strategy: 'auto', // 'auto' | 'ast' | 'section' | 'fixed' | 'whole'
      maxChunkTokens: 512,
      overlapTokens: 50,
      useAST: true, // auto 策略时启用 AST 语法感知分块
    },
  },

  // 检索漏斗配置
  retrieval: {
    layers: ['keyword', 'semantic', 'fusion', 'rerank'],
    topK: {
      keyword: 100, // Layer 1: Keyword filter
      semantic: 50, // Layer 2: Semantic search
      fusion: 20, // Layer 3: Multi-signal ranking
      final: 10, // Layer 4: Context-aware reranking
    },
    weights: {
      default: {
        relevance: 0.35, // Semantic + BM25
        authority: 0.2, // Authority score
        recency: 0.15, // Last modified time
        popularity: 0.15, // Usage heat
        difficulty: 0.1, // Difficulty matching
        seasonality: 0.05, // Seasonality boost
      },
      // Scenario-specific weights
      scenarios: {
        lint: {
          relevance: 0.4,
          authority: 0.3,
          recency: 0.1,
          popularity: 0.1,
          difficulty: 0.1,
          seasonality: 0.0,
        },
        generate: {
          relevance: 0.35,
          authority: 0.15,
          recency: 0.15,
          popularity: 0.2,
          difficulty: 0.1,
          seasonality: 0.05,
        },
        search: {
          relevance: 0.3,
          authority: 0.25,
          recency: 0.15,
          popularity: 0.15,
          difficulty: 0.1,
          seasonality: 0.05,
        },
        learning: {
          relevance: 0.25,
          authority: 0.2,
          recency: 0.1,
          popularity: 0.1,
          difficulty: 0.3, // Priority on simplicity
          seasonality: 0.05,
        },
      },
    },
  },

  // 内存系统配置
  memory: {
    episodic: {
      persistence: 'json', // or 'redis' for distributed
      persistPath: '.autosnippet/memory/episodic',
      maxSessions: 100,
      sessionTTL: 48 * 60 * 60, // 48 hours in seconds
    },
    conversation: {
      maxRounds: 5,
      compressionThreshold: 0.7,
      summaryMaxLength: 200, // characters
    },
    semantic: {
      // Recipe knowledge base caching
      enableCache: true,
      cacheExpiry: 24 * 60 * 60, // 24 hours
    },
  },

  // Agent 协调层配置
  agent: {
    coordinator: {
      timeout: 30000, // 30 seconds
      retries: 2,
      fallback: 'search', // Fallback agent if others fail
    },
    intentClassification: {
      enableLLM: false, // Use simple keyword matching by default
      keywords: {
        code_generation: ['create', 'write', 'generate', 'implement', 'make'],
        code_quality_check: ['check', 'validate', 'audit', 'lint', 'review'],
        learning_path: ['learn', 'tutorial', 'explain', 'understand', 'teach'],
        general_query: [],
      },
    },
  },

  // Token 预算配置
  tokenBudget: {
    maxTokens: 4000,
    allocation: {
      systemPrompt: 300,
      conversationHistory: 1200,
      recipes: 800,
      userInput: 300,
      buffer: 400,
    },
    scenarios: {
      quick_fix: {
        conversationHistory: 200,
        recipes: 1500,
        buffer: 100,
      },
      detailed_explanation: {
        conversationHistory: 600,
        recipes: 1200,
        buffer: 200,
      },
      learning_session: {
        conversationHistory: 400,
        recipes: 1500,
        buffer: 200,
      },
    },
  },

  // 开发/调试配置
  debug: {
    logIndexing: false,
    logRetrieval: false,
    logAgent: false,
    logMemory: false,
  },

  // 性能优化
  performance: {
    enableParallelProcessing: true,
    maxConcurrentRequests: 10,
    cacheBatchSize: 32,
    prefetchSize: 10, // Prefetch next N results
  },
};
