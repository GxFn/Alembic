/**
 * GENERATED FILE — DO NOT EDIT BY HAND.
 *
 * Dashboard API contract artifact (IC2, P0 §8): Core knowledge wire types,
 * failure taxonomy + problem envelope projection, job kinds, and the
 * Alembic provider-contracts route table with a deduplicated
 * response-schema registry.
 *
 * Authority chain: @alembic/core src/types/knowledge-wire.ts +
 * src/shared/FailureTaxonomy.ts, Alembic lib/http/provider-contracts.ts +
 * lib/http/problem-taxonomy.ts.
 * Regenerate (in Alembic): npm run build && npm run generate:dashboard-types
 * Drift gate (Alembic side): test/unit/DashboardApiTypesDrift.test.ts via npm run check.
 * Dashboard consumer path: src/generated/api-types.ts (landed by the pB2 wave).
 */

// ════════════════════════════════════════════════════════════════════
// Knowledge wire contract (verbatim from @alembic/core dist/types/knowledge-wire.d.ts)
// ════════════════════════════════════════════════════════════════════

/**
 * §10.1 KnowledgeEntryWire — 统一的知识条目传输合约
 *
 * 这是后端 KnowledgeEntry.toJSON() 和前端 Dashboard 共享的唯一类型定义。
 * 所有 API 层传输都使用此形状，消除后端 class 与前端 interface 的字段漂移。
 */
export type KnowledgeLifecycle = 'pending' | 'staging' | 'active' | 'evolving' | 'decaying' | 'deprecated';
export type KnowledgeKind = 'rule' | 'pattern' | 'fact';
export interface KnowledgeContentWire {
    pattern: string;
    markdown: string;
    rationale: string;
    steps: Array<{
        title?: string;
        description?: string;
        code?: string;
    }>;
    codeChanges: Array<{
        file: string;
        before: string;
        after: string;
        explanation: string;
    }>;
    verification: {
        method?: string;
        expectedResult?: string;
        testCode?: string;
    } | null;
}
export interface KnowledgeReasoningWire {
    whyStandard: string;
    sources: string[];
    confidence: number;
    qualitySignals: Record<string, unknown>;
    alternatives: string[];
}
export interface KnowledgeQualityWire {
    completeness: number;
    adaptation: number;
    documentation: number;
    overall: number;
    grade: string;
}
export interface KnowledgeStatsWire {
    views: number;
    adoptions: number;
    applications: number;
    guardHits: number;
    searchHits: number;
    authority: number;
    lastHitAt: number | null;
    lastSearchedAt: number | null;
    lastGuardHitAt: number | null;
    hitsLast30d: number;
    hitsLast90d: number;
    searchHitsLast30d: number;
    version: number;
    ruleFalsePositiveRate: number | null;
}
export interface KnowledgeConstraintsWire {
    guards: Array<{
        id?: string | null;
        type?: string;
        pattern: string | null;
        severity: string;
        message?: string;
        fixSuggestion?: string;
    }>;
    boundaries: string[];
    preconditions: string[];
    sideEffects: string[];
}
export interface KnowledgeRelationEntry {
    target: string;
    description?: string;
}
export interface KnowledgeRelationsWire {
    [bucket: string]: KnowledgeRelationEntry[];
}
/** 后端 → 前端 / API 传输的唯一合约 */
export interface KnowledgeEntryWire {
    id: string;
    title: string;
    description: string;
    lifecycle: string;
    lifecycleHistory: Array<{
        from: string;
        to: string;
        at: number;
        by?: string;
    }>;
    autoApprovable: boolean;
    language: string;
    dimensionId: string;
    category: string;
    kind: string;
    knowledgeType: string;
    complexity: string;
    scope: string;
    difficulty: string | null;
    tags: string[];
    trigger: string;
    topicHint: string;
    whenClause: string;
    doClause: string;
    dontClause: string;
    coreCode: string;
    usageGuide: string;
    content: KnowledgeContentWire;
    relations: KnowledgeRelationsWire;
    constraints: KnowledgeConstraintsWire;
    reasoning: KnowledgeReasoningWire;
    quality: KnowledgeQualityWire;
    stats: KnowledgeStatsWire;
    headers: string[];
    headerPaths: string[];
    moduleName: string;
    includeHeaders: boolean;
    agentNotes: string | null;
    aiInsight: string | null;
    reviewedBy: string | null;
    reviewedAt: number | null;
    rejectionReason: string | null;
    source: string;
    sourceFile: string | null;
    sourceCandidateId: string | null;
    createdBy: string;
    createdAt: number;
    updatedAt: number;
    publishedAt: number | null;
    publishedBy: string | null;
    [key: string]: unknown;
}

// ════════════════════════════════════════════════════════════════════
// Failure taxonomy
// ════════════════════════════════════════════════════════════════════

export type DashboardFailureKind = 'invalid-input' | 'unavailable' | 'capability-mismatch' | 'not-found' | 'conflict' | 'permission-denied' | 'timeout' | 'cancelled' | 'partial' | 'degraded' | 'needs-confirmation' | 'provider-error' | 'host-failure' | 'internal-error' | 'schema-drift' | 'sensitive-leak';

export const DASHBOARD_FAILURE_KINDS: readonly DashboardFailureKind[] = [
  "invalid-input",
  "unavailable",
  "capability-mismatch",
  "not-found",
  "conflict",
  "permission-denied",
  "timeout",
  "cancelled",
  "partial",
  "degraded",
  "needs-confirmation",
  "provider-error",
  "host-failure",
  "internal-error",
  "schema-drift",
  "sensitive-leak"
];

export interface DashboardFailureTaxonomyEntry {
  readonly agentBranch: string;
  readonly dashboardState: DashboardFailureKind;
  readonly detailExposureClass: string;
  readonly exposureClass: string;
  readonly httpStatus: number;
  readonly kind: DashboardFailureKind;
  readonly mcpErrorCode: string;
  readonly mcpStatus: DashboardFailureKind;
  readonly owner: string;
  readonly privateDataSafe: boolean;
  readonly problemClass: string;
  readonly publicMessage: string;
  readonly refPolicy: string;
  readonly retryPolicy: string;
  readonly retryable: boolean;
  readonly stableId: string;
  readonly status: string;
}

export const DASHBOARD_FAILURE_TAXONOMY: readonly DashboardFailureTaxonomyEntry[] = [
  {
    "agentBranch": "failure",
    "dashboardState": "invalid-input",
    "detailExposureClass": "consumer-needed",
    "exposureClass": "public",
    "httpStatus": 400,
    "kind": "invalid-input",
    "mcpErrorCode": "core.failure.invalid-input",
    "mcpStatus": "invalid-input",
    "owner": "AlembicCore",
    "privateDataSafe": true,
    "problemClass": "request-problem",
    "publicMessage": "The request is invalid.",
    "refPolicy": "none",
    "retryPolicy": "after-input-change",
    "retryable": false,
    "stableId": "core.failure.invalid-input",
    "status": "blocked"
  },
  {
    "agentBranch": "host-adapter",
    "dashboardState": "unavailable",
    "detailExposureClass": "diagnostic",
    "exposureClass": "public",
    "httpStatus": 503,
    "kind": "unavailable",
    "mcpErrorCode": "core.failure.unavailable",
    "mcpStatus": "unavailable",
    "owner": "AlembicCore",
    "privateDataSafe": true,
    "problemClass": "availability-problem",
    "publicMessage": "The requested capability is unavailable.",
    "refPolicy": "detailRef",
    "retryPolicy": "retryable-after-backoff",
    "retryable": true,
    "stableId": "core.failure.unavailable",
    "status": "blocked"
  },
  {
    "agentBranch": "failure",
    "dashboardState": "capability-mismatch",
    "detailExposureClass": "consumer-needed",
    "exposureClass": "public",
    "httpStatus": 501,
    "kind": "capability-mismatch",
    "mcpErrorCode": "core.failure.capability-mismatch",
    "mcpStatus": "capability-mismatch",
    "owner": "AlembicCore",
    "privateDataSafe": true,
    "problemClass": "capability-problem",
    "publicMessage": "The current capability does not support the requested operation.",
    "refPolicy": "detailRef",
    "retryPolicy": "operator-action",
    "retryable": false,
    "stableId": "core.failure.capability-mismatch",
    "status": "blocked"
  },
  {
    "agentBranch": "failure",
    "dashboardState": "not-found",
    "detailExposureClass": "consumer-needed",
    "exposureClass": "public",
    "httpStatus": 404,
    "kind": "not-found",
    "mcpErrorCode": "core.failure.not-found",
    "mcpStatus": "not-found",
    "owner": "AlembicCore",
    "privateDataSafe": true,
    "problemClass": "resource-problem",
    "publicMessage": "The requested resource was not found.",
    "refPolicy": "none",
    "retryPolicy": "after-state-change",
    "retryable": false,
    "stableId": "core.failure.not-found",
    "status": "blocked"
  },
  {
    "agentBranch": "failure",
    "dashboardState": "conflict",
    "detailExposureClass": "consumer-needed",
    "exposureClass": "public",
    "httpStatus": 409,
    "kind": "conflict",
    "mcpErrorCode": "core.failure.conflict",
    "mcpStatus": "conflict",
    "owner": "AlembicCore",
    "privateDataSafe": true,
    "problemClass": "state-conflict",
    "publicMessage": "The request conflicts with current state.",
    "refPolicy": "detailRef",
    "retryPolicy": "after-state-change",
    "retryable": false,
    "stableId": "core.failure.conflict",
    "status": "blocked"
  },
  {
    "agentBranch": "permission-denial",
    "dashboardState": "permission-denied",
    "detailExposureClass": "consumer-needed",
    "exposureClass": "public",
    "httpStatus": 403,
    "kind": "permission-denied",
    "mcpErrorCode": "core.failure.permission-denied",
    "mcpStatus": "permission-denied",
    "owner": "AlembicCore",
    "privateDataSafe": true,
    "problemClass": "permission-problem",
    "publicMessage": "Permission is denied for the requested operation.",
    "refPolicy": "none",
    "retryPolicy": "after-caller-action",
    "retryable": false,
    "stableId": "core.failure.permission-denied",
    "status": "blocked"
  },
  {
    "agentBranch": "timeout",
    "dashboardState": "timeout",
    "detailExposureClass": "diagnostic",
    "exposureClass": "public",
    "httpStatus": 408,
    "kind": "timeout",
    "mcpErrorCode": "core.failure.timeout",
    "mcpStatus": "timeout",
    "owner": "AlembicCore",
    "privateDataSafe": true,
    "problemClass": "time-problem",
    "publicMessage": "The operation timed out.",
    "refPolicy": "detailRef",
    "retryPolicy": "retryable",
    "retryable": true,
    "stableId": "core.failure.timeout",
    "status": "failed"
  },
  {
    "agentBranch": "cancellation",
    "dashboardState": "cancelled",
    "detailExposureClass": "consumer-needed",
    "exposureClass": "public",
    "httpStatus": 499,
    "kind": "cancelled",
    "mcpErrorCode": "core.failure.cancelled",
    "mcpStatus": "cancelled",
    "owner": "AlembicCore",
    "privateDataSafe": true,
    "problemClass": "cancellation",
    "publicMessage": "The operation was cancelled.",
    "refPolicy": "none",
    "retryPolicy": "after-caller-action",
    "retryable": false,
    "stableId": "core.failure.cancelled",
    "status": "cancelled"
  },
  {
    "agentBranch": "partial-result",
    "dashboardState": "partial",
    "detailExposureClass": "diagnostic",
    "exposureClass": "public",
    "httpStatus": 206,
    "kind": "partial",
    "mcpErrorCode": "core.failure.partial",
    "mcpStatus": "partial",
    "owner": "AlembicCore",
    "privateDataSafe": true,
    "problemClass": "partial-result",
    "publicMessage": "The operation completed only partially.",
    "refPolicy": "detailRef-or-artifactRef",
    "retryPolicy": "retryable",
    "retryable": true,
    "stableId": "core.failure.partial",
    "status": "partial"
  },
  {
    "agentBranch": "host-adapter",
    "dashboardState": "degraded",
    "detailExposureClass": "diagnostic",
    "exposureClass": "public",
    "httpStatus": 503,
    "kind": "degraded",
    "mcpErrorCode": "core.failure.degraded",
    "mcpStatus": "degraded",
    "owner": "AlembicCore",
    "privateDataSafe": true,
    "problemClass": "degradation",
    "publicMessage": "The capability is available with degraded behavior.",
    "refPolicy": "detailRef",
    "retryPolicy": "retryable-after-backoff",
    "retryable": true,
    "stableId": "core.failure.degraded",
    "status": "degraded"
  },
  {
    "agentBranch": "needs-confirmation",
    "dashboardState": "needs-confirmation",
    "detailExposureClass": "consumer-needed",
    "exposureClass": "public",
    "httpStatus": 412,
    "kind": "needs-confirmation",
    "mcpErrorCode": "core.failure.needs-confirmation",
    "mcpStatus": "needs-confirmation",
    "owner": "AlembicCore",
    "privateDataSafe": true,
    "problemClass": "confirmation-required",
    "publicMessage": "The operation requires explicit confirmation.",
    "refPolicy": "none",
    "retryPolicy": "after-confirmation",
    "retryable": false,
    "stableId": "core.failure.needs-confirmation",
    "status": "needs-confirmation"
  },
  {
    "agentBranch": "provider-error",
    "dashboardState": "provider-error",
    "detailExposureClass": "diagnostic",
    "exposureClass": "public",
    "httpStatus": 502,
    "kind": "provider-error",
    "mcpErrorCode": "core.failure.provider-error",
    "mcpStatus": "provider-error",
    "owner": "AlembicCore",
    "privateDataSafe": true,
    "problemClass": "provider-problem",
    "publicMessage": "The provider returned an error.",
    "refPolicy": "detailRef",
    "retryPolicy": "retryable-after-backoff",
    "retryable": true,
    "stableId": "core.failure.provider-error",
    "status": "failed"
  },
  {
    "agentBranch": "host-failure",
    "dashboardState": "host-failure",
    "detailExposureClass": "diagnostic",
    "exposureClass": "public",
    "httpStatus": 424,
    "kind": "host-failure",
    "mcpErrorCode": "core.failure.host-failure",
    "mcpStatus": "host-failure",
    "owner": "AlembicCore",
    "privateDataSafe": true,
    "problemClass": "host-problem",
    "publicMessage": "The host runtime failed the operation.",
    "refPolicy": "detailRef",
    "retryPolicy": "operator-action",
    "retryable": false,
    "stableId": "core.failure.host-failure",
    "status": "failed"
  },
  {
    "agentBranch": "failure",
    "dashboardState": "internal-error",
    "detailExposureClass": "diagnostic",
    "exposureClass": "public",
    "httpStatus": 500,
    "kind": "internal-error",
    "mcpErrorCode": "core.failure.internal-error",
    "mcpStatus": "internal-error",
    "owner": "AlembicCore",
    "privateDataSafe": true,
    "problemClass": "internal-problem",
    "publicMessage": "An internal error occurred.",
    "refPolicy": "detailRef",
    "retryPolicy": "operator-action",
    "retryable": false,
    "stableId": "core.failure.internal-error",
    "status": "failed"
  },
  {
    "agentBranch": "failure",
    "dashboardState": "schema-drift",
    "detailExposureClass": "diagnostic",
    "exposureClass": "public",
    "httpStatus": 422,
    "kind": "schema-drift",
    "mcpErrorCode": "core.failure.schema-drift",
    "mcpStatus": "schema-drift",
    "owner": "AlembicCore",
    "privateDataSafe": true,
    "problemClass": "schema-problem",
    "publicMessage": "The payload does not match the expected schema.",
    "refPolicy": "detailRef",
    "retryPolicy": "operator-action",
    "retryable": false,
    "stableId": "core.failure.schema-drift",
    "status": "blocked"
  },
  {
    "agentBranch": "failure",
    "dashboardState": "sensitive-leak",
    "detailExposureClass": "sensitive",
    "exposureClass": "public",
    "httpStatus": 500,
    "kind": "sensitive-leak",
    "mcpErrorCode": "core.failure.sensitive-leak",
    "mcpStatus": "sensitive-leak",
    "owner": "AlembicCore",
    "privateDataSafe": true,
    "problemClass": "sensitive-data-problem",
    "publicMessage": "A sensitive-data safety boundary was triggered.",
    "refPolicy": "redacted-detailRef",
    "retryPolicy": "operator-action",
    "retryable": false,
    "stableId": "core.failure.sensitive-leak",
    "status": "blocked"
  }
];

// ════════════════════════════════════════════════════════════════════
// Problem envelope (wire shape of the Alembic HTTP problem projection)
// ════════════════════════════════════════════════════════════════════

export interface DashboardProblemDetail {
  readonly agentBranch: string;
  readonly artifactRefs?: readonly string[];
  readonly canonicalHttpStatus: number;
  readonly code: string;
  readonly dashboardState: DashboardFailureKind;
  readonly detailExposureClass: string;
  readonly detailRefs?: readonly string[];
  readonly exposureClass: string;
  readonly failureId: string;
  readonly failureStatus: string;
  readonly mcpErrorCode: string;
  readonly mcpStatus: DashboardFailureKind;
  readonly message: string;
  readonly privateDataSafe: boolean;
  readonly problemClass: string;
  readonly reasonCode: DashboardFailureKind;
  readonly refPolicy: string;
  readonly retryPolicy: string;
  readonly retryable: boolean;
  readonly status: number;
  readonly taxonomyVersion: number;
}

// ════════════════════════════════════════════════════════════════════
// Job kinds
// ════════════════════════════════════════════════════════════════════

export type DashboardJobKind = 'bootstrap' | 'rescan';

export const DASHBOARD_JOB_KINDS: readonly DashboardJobKind[] = [
  "bootstrap",
  "rescan"
];

// ════════════════════════════════════════════════════════════════════
// HTTP route contract table (31 routes, contract version 1)
// ════════════════════════════════════════════════════════════════════

export const DASHBOARD_API_CONTRACT_VERSION = 1;

export type DashboardApiSchemaId = 'schema-1' | 'schema-2';

export const DASHBOARD_API_RESPONSE_SCHEMAS: Readonly<Record<DashboardApiSchemaId, Record<string, unknown>>> = {
  "schema-1": {
    "type": "object",
    "required": [
      "success",
      "data"
    ],
    "additionalProperties": false,
    "properties": {
      "success": {
        "type": "boolean"
      },
      "data": {
        "type": "object",
        "additionalProperties": {
          "oneOf": [
            {
              "type": "string"
            },
            {
              "type": "number"
            },
            {
              "type": "integer"
            },
            {
              "type": "boolean"
            },
            {
              "type": "null"
            },
            {
              "type": "array",
              "items": {}
            },
            {
              "type": "object"
            }
          ]
        },
        "description": "Route-specific provider data. Consumers may only depend on fields declared by the owning route family or a named typed extension point.",
        "x-alembic-extension-point": {
          "consumer": "Dashboard API adapter, Plugin resident client, and controller fixture replay",
          "exposureClasses": [
            "public",
            "consumer-needed",
            "diagnostic"
          ],
          "name": "provider.route-data",
          "owner": "Alembic provider route contract",
          "schemaClosurePolicy": "typed-extension"
        }
      }
    }
  },
  "schema-2": {
    "type": "object",
    "required": [
      "success",
      "error"
    ],
    "additionalProperties": false,
    "properties": {
      "data": {
        "type": "object",
        "additionalProperties": {
          "oneOf": [
            {
              "type": "string"
            },
            {
              "type": "number"
            },
            {
              "type": "integer"
            },
            {
              "type": "boolean"
            },
            {
              "type": "null"
            },
            {
              "type": "array",
              "items": {}
            },
            {
              "type": "object"
            }
          ]
        },
        "description": "Optional route-owned failure context. The stable problem remains in error; data is limited to the route public projection.",
        "x-alembic-extension-point": {
          "consumer": "Dashboard action normalizer and Plugin resident diagnostics",
          "exposureClasses": [
            "consumer-needed",
            "diagnostic"
          ],
          "name": "provider.problem-failure-data",
          "owner": "Alembic provider route contract",
          "schemaClosurePolicy": "typed-extension"
        }
      },
      "success": {
        "const": false
      },
      "error": {
        "type": "object",
        "required": [
          "agentBranch",
          "canonicalHttpStatus",
          "code",
          "dashboardState",
          "detailExposureClass",
          "exposureClass",
          "failureId",
          "failureStatus",
          "mcpErrorCode",
          "mcpStatus",
          "message",
          "privateDataSafe",
          "problemClass",
          "reasonCode",
          "refPolicy",
          "retryPolicy",
          "retryable",
          "status",
          "taxonomyVersion"
        ],
        "additionalProperties": false,
        "properties": {
          "agentBranch": {
            "enum": [
              "failure",
              "host-adapter",
              "permission-denial",
              "timeout",
              "cancellation",
              "partial-result",
              "needs-confirmation",
              "provider-error",
              "host-failure"
            ]
          },
          "artifactRefs": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "canonicalHttpStatus": {
            "type": "number"
          },
          "code": {
            "type": "string"
          },
          "dashboardState": {
            "enum": [
              "invalid-input",
              "unavailable",
              "capability-mismatch",
              "not-found",
              "conflict",
              "permission-denied",
              "timeout",
              "cancelled",
              "partial",
              "degraded",
              "needs-confirmation",
              "provider-error",
              "host-failure",
              "internal-error",
              "schema-drift",
              "sensitive-leak"
            ]
          },
          "detailExposureClass": {
            "enum": [
              "public",
              "consumer-needed",
              "diagnostic",
              "internal",
              "sensitive",
              "raw-provider",
              "hidden-reasoning",
              "detailRef-only",
              "artifactRef-only",
              "compatibility-private",
              "typed-extension"
            ]
          },
          "detailRefs": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "exposureClass": {
            "enum": [
              "public",
              "consumer-needed",
              "diagnostic",
              "internal",
              "sensitive",
              "raw-provider",
              "hidden-reasoning",
              "detailRef-only",
              "artifactRef-only",
              "compatibility-private",
              "typed-extension"
            ]
          },
          "failureId": {
            "enum": [
              "core.failure.invalid-input",
              "core.failure.unavailable",
              "core.failure.capability-mismatch",
              "core.failure.not-found",
              "core.failure.conflict",
              "core.failure.permission-denied",
              "core.failure.timeout",
              "core.failure.cancelled",
              "core.failure.partial",
              "core.failure.degraded",
              "core.failure.needs-confirmation",
              "core.failure.provider-error",
              "core.failure.host-failure",
              "core.failure.internal-error",
              "core.failure.schema-drift",
              "core.failure.sensitive-leak"
            ]
          },
          "failureStatus": {
            "enum": [
              "blocked",
              "failed",
              "degraded",
              "partial",
              "cancelled",
              "needs-confirmation"
            ]
          },
          "mcpErrorCode": {
            "enum": [
              "core.failure.invalid-input",
              "core.failure.unavailable",
              "core.failure.capability-mismatch",
              "core.failure.not-found",
              "core.failure.conflict",
              "core.failure.permission-denied",
              "core.failure.timeout",
              "core.failure.cancelled",
              "core.failure.partial",
              "core.failure.degraded",
              "core.failure.needs-confirmation",
              "core.failure.provider-error",
              "core.failure.host-failure",
              "core.failure.internal-error",
              "core.failure.schema-drift",
              "core.failure.sensitive-leak"
            ]
          },
          "mcpStatus": {
            "enum": [
              "invalid-input",
              "unavailable",
              "capability-mismatch",
              "not-found",
              "conflict",
              "permission-denied",
              "timeout",
              "cancelled",
              "partial",
              "degraded",
              "needs-confirmation",
              "provider-error",
              "host-failure",
              "internal-error",
              "schema-drift",
              "sensitive-leak"
            ]
          },
          "message": {
            "type": "string"
          },
          "privateDataSafe": {
            "const": true
          },
          "problemClass": {
            "enum": [
              "request-problem",
              "resource-problem",
              "state-conflict",
              "permission-problem",
              "time-problem",
              "cancellation",
              "availability-problem",
              "degradation",
              "partial-result",
              "capability-problem",
              "confirmation-required",
              "provider-problem",
              "host-problem",
              "internal-problem",
              "schema-problem",
              "sensitive-data-problem"
            ]
          },
          "reasonCode": {
            "enum": [
              "invalid-input",
              "unavailable",
              "capability-mismatch",
              "not-found",
              "conflict",
              "permission-denied",
              "timeout",
              "cancelled",
              "partial",
              "degraded",
              "needs-confirmation",
              "provider-error",
              "host-failure",
              "internal-error",
              "schema-drift",
              "sensitive-leak"
            ]
          },
          "refPolicy": {
            "enum": [
              "none",
              "detailRef",
              "artifactRef",
              "detailRef-or-artifactRef",
              "redacted-detailRef"
            ]
          },
          "retryPolicy": {
            "enum": [
              "never",
              "after-caller-action",
              "after-input-change",
              "after-state-change",
              "after-confirmation",
              "retryable",
              "retryable-after-backoff",
              "operator-action"
            ]
          },
          "retryable": {
            "type": "boolean"
          },
          "status": {
            "type": "number"
          },
          "taxonomyVersion": {
            "const": 1
          }
        }
      }
    }
  }
};

export interface DashboardApiRouteContract {
  readonly artifactPolicy: string;
  readonly capabilityDiscovery: readonly string[];
  readonly contractId: string;
  readonly errorKinds: readonly DashboardFailureKind[];
  readonly exposureClasses: readonly string[];
  readonly fixtureIds: readonly string[];
  readonly functionClass: string;
  readonly method: string;
  readonly operationId: string;
  readonly path: string;
  readonly registryRowId: string;
  readonly responseSchemas: Readonly<Record<string, DashboardApiSchemaId>>;
  readonly summary: string;
  readonly supportedScenarios: readonly string[];
  readonly tags: readonly string[];
}

export const DASHBOARD_API_ROUTES: readonly DashboardApiRouteContract[] = [
  {
    "artifactPolicy": "Route summaries inline; long reports/logs via artifact routes.",
    "capabilityDiscovery": [
      "/api-spec",
      "/api/v1/daemon/health"
    ],
    "contractId": "I09.getApiSpec",
    "errorKinds": [
      "invalid-input",
      "permission-denied",
      "unavailable",
      "timeout",
      "not-found"
    ],
    "exposureClasses": [
      "public",
      "consumer-needed",
      "diagnostic"
    ],
    "fixtureIds": [
      "api-spec.success",
      "route.not-found",
      "route.permission-denied"
    ],
    "functionClass": "rest-query",
    "method": "get",
    "operationId": "getApiSpec",
    "path": "/api-spec",
    "registryRowId": "I09",
    "summary": "OpenAPI provider contract document",
    "supportedScenarios": [
      "success",
      "not-found",
      "permission-denied"
    ],
    "tags": [
      "System"
    ],
    "responseSchemas": {
      "200": "schema-1",
      "400": "schema-2",
      "403": "schema-2",
      "404": "schema-2",
      "503": "schema-2",
      "504": "schema-2"
    }
  },
  {
    "artifactPolicy": "Route summaries inline; long reports/logs via artifact routes.",
    "capabilityDiscovery": [
      "/api-spec",
      "/api/v1/daemon/health"
    ],
    "contractId": "I09.getHealth",
    "errorKinds": [
      "invalid-input",
      "permission-denied",
      "unavailable",
      "timeout",
      "not-found"
    ],
    "exposureClasses": [
      "public",
      "consumer-needed",
      "diagnostic"
    ],
    "fixtureIds": [
      "api-spec.success",
      "route.not-found",
      "route.permission-denied"
    ],
    "functionClass": "rest-query",
    "method": "get",
    "operationId": "getHealth",
    "path": "/health",
    "registryRowId": "I09",
    "summary": "Health check route family",
    "supportedScenarios": [
      "success",
      "not-found",
      "permission-denied"
    ],
    "tags": [
      "System"
    ],
    "responseSchemas": {
      "200": "schema-1",
      "400": "schema-2",
      "403": "schema-2",
      "404": "schema-2",
      "503": "schema-2",
      "504": "schema-2"
    }
  },
  {
    "artifactPolicy": "Health summary inline; logs and state snapshots by detailRef.",
    "capabilityDiscovery": [
      "GET /api/v1/daemon/health capabilities"
    ],
    "contractId": "I03.getDaemonHealth",
    "errorKinds": [
      "unavailable",
      "capability-mismatch",
      "degraded",
      "internal-error"
    ],
    "exposureClasses": [
      "public",
      "consumer-needed",
      "diagnostic"
    ],
    "fixtureIds": [
      "runtime-health.ready",
      "runtime-health.partial",
      "runtime-health.unavailable"
    ],
    "functionClass": "rest-query",
    "method": "get",
    "operationId": "getDaemonHealth",
    "path": "/daemon/health",
    "registryRowId": "I03",
    "summary": "Runtime health and capability discovery",
    "supportedScenarios": [
      "success",
      "partial",
      "unavailable-runtime"
    ],
    "tags": [
      "Runtime"
    ],
    "responseSchemas": {
      "200": "schema-1",
      "206": "schema-1",
      "500": "schema-2",
      "501": "schema-2",
      "503": "schema-2"
    }
  },
  {
    "artifactPolicy": "Project runtime summary inline; diagnostics by detailRef.",
    "capabilityDiscovery": [
      "GET /api/v1/daemon/health",
      "GET /api/v1/projects/status"
    ],
    "contractId": "I04.listProjects",
    "errorKinds": [
      "conflict",
      "timeout",
      "cancelled",
      "not-found",
      "internal-error"
    ],
    "exposureClasses": [
      "consumer-needed",
      "diagnostic"
    ],
    "fixtureIds": [
      "project-runtime.success",
      "project-runtime.conflict",
      "project-runtime.timeout"
    ],
    "functionClass": "rest-command",
    "method": "get",
    "operationId": "listProjects",
    "path": "/projects",
    "registryRowId": "I04",
    "summary": "Project runtime snapshot and control family",
    "supportedScenarios": [
      "success",
      "conflict",
      "timeout"
    ],
    "tags": [
      "Runtime"
    ],
    "responseSchemas": {
      "200": "schema-1",
      "404": "schema-2",
      "409": "schema-2",
      "500": "schema-2",
      "504": "schema-2"
    }
  },
  {
    "artifactPolicy": "Project runtime summary inline; diagnostics by detailRef.",
    "capabilityDiscovery": [
      "GET /api/v1/daemon/health",
      "GET /api/v1/projects/status"
    ],
    "contractId": "I04.switchProject",
    "errorKinds": [
      "conflict",
      "timeout",
      "cancelled",
      "not-found",
      "internal-error"
    ],
    "exposureClasses": [
      "consumer-needed",
      "diagnostic"
    ],
    "fixtureIds": [
      "project-runtime.success",
      "project-runtime.conflict",
      "project-runtime.timeout"
    ],
    "functionClass": "rest-command",
    "method": "post",
    "operationId": "switchProject",
    "path": "/projects/{projectId}/switch",
    "registryRowId": "I04",
    "summary": "Project runtime switch command",
    "supportedScenarios": [
      "success",
      "conflict",
      "timeout"
    ],
    "tags": [
      "Runtime"
    ],
    "responseSchemas": {
      "200": "schema-1",
      "404": "schema-2",
      "409": "schema-2",
      "500": "schema-2",
      "504": "schema-2"
    }
  },
  {
    "artifactPolicy": "ProjectScope summary inline; registry snapshots by artifactRef.",
    "capabilityDiscovery": [
      "daemon health projectScope capability",
      "/api/v1/project-scope"
    ],
    "contractId": "I05.getProjectScope",
    "errorKinds": [
      "invalid-input",
      "conflict",
      "not-found",
      "internal-error"
    ],
    "exposureClasses": [
      "consumer-needed",
      "diagnostic"
    ],
    "fixtureIds": [
      "project-scope.success",
      "project-scope.failure"
    ],
    "functionClass": "rest-command",
    "method": "get",
    "operationId": "getProjectScope",
    "path": "/project-scope",
    "registryRowId": "I05",
    "summary": "ProjectScope read/list/resolve family",
    "supportedScenarios": [
      "success",
      "failure"
    ],
    "tags": [
      "Runtime"
    ],
    "responseSchemas": {
      "200": "schema-1",
      "400": "schema-2",
      "404": "schema-2",
      "409": "schema-2",
      "500": "schema-2"
    }
  },
  {
    "artifactPolicy": "Compact job summary inline; reports/logs/snapshots by artifactRef/detailRef.",
    "capabilityDiscovery": [
      "daemon health jobs capability"
    ],
    "contractId": "I06.listJobs",
    "errorKinds": [
      "invalid-input",
      "timeout",
      "cancelled",
      "conflict",
      "not-found"
    ],
    "exposureClasses": [
      "public",
      "consumer-needed",
      "diagnostic"
    ],
    "fixtureIds": [
      "jobs.queued",
      "jobs.cancelled",
      "jobs.cancelled-problem",
      "jobs.unavailable"
    ],
    "functionClass": "rest-command",
    "method": "get",
    "operationId": "listJobs",
    "path": "/jobs",
    "registryRowId": "I06",
    "summary": "Job list and status family",
    "supportedScenarios": [
      "success",
      "cancelled",
      "unavailable-runtime"
    ],
    "tags": [
      "Jobs"
    ],
    "responseSchemas": {
      "200": "schema-1",
      "400": "schema-2",
      "404": "schema-2",
      "409": "schema-2",
      "503": "schema-2",
      "504": "schema-2"
    }
  },
  {
    "artifactPolicy": "Compact job summary inline; reports/logs/snapshots by artifactRef/detailRef.",
    "capabilityDiscovery": [
      "daemon health jobs capability"
    ],
    "contractId": "I06.startBootstrapJob",
    "errorKinds": [
      "invalid-input",
      "timeout",
      "cancelled",
      "conflict",
      "not-found"
    ],
    "exposureClasses": [
      "public",
      "consumer-needed",
      "diagnostic"
    ],
    "fixtureIds": [
      "jobs.queued",
      "jobs.cancelled",
      "jobs.cancelled-problem",
      "jobs.unavailable"
    ],
    "functionClass": "rest-command",
    "method": "post",
    "operationId": "startBootstrapJob",
    "path": "/jobs/bootstrap",
    "registryRowId": "I06",
    "summary": "Bootstrap job command",
    "supportedScenarios": [
      "success",
      "cancelled",
      "unavailable-runtime"
    ],
    "tags": [
      "Jobs"
    ],
    "responseSchemas": {
      "200": "schema-1",
      "400": "schema-2",
      "404": "schema-2",
      "409": "schema-2",
      "503": "schema-2",
      "504": "schema-2"
    }
  },
  {
    "artifactPolicy": "Compact job summary inline; reports/logs/snapshots by artifactRef/detailRef.",
    "capabilityDiscovery": [
      "daemon health jobs capability"
    ],
    "contractId": "I06.startRescanJob",
    "errorKinds": [
      "invalid-input",
      "timeout",
      "cancelled",
      "conflict",
      "not-found"
    ],
    "exposureClasses": [
      "public",
      "consumer-needed",
      "diagnostic"
    ],
    "fixtureIds": [
      "jobs.queued",
      "jobs.cancelled",
      "jobs.cancelled-problem",
      "jobs.unavailable"
    ],
    "functionClass": "rest-command",
    "method": "post",
    "operationId": "startRescanJob",
    "path": "/jobs/rescan",
    "registryRowId": "I06",
    "summary": "Rescan job command",
    "supportedScenarios": [
      "success",
      "cancelled",
      "unavailable-runtime"
    ],
    "tags": [
      "Jobs"
    ],
    "responseSchemas": {
      "200": "schema-1",
      "400": "schema-2",
      "404": "schema-2",
      "409": "schema-2",
      "503": "schema-2",
      "504": "schema-2"
    }
  },
  {
    "artifactPolicy": "Compact job summary inline; reports/logs/snapshots by artifactRef/detailRef.",
    "capabilityDiscovery": [
      "daemon health jobs capability"
    ],
    "contractId": "I06.cancelJob",
    "errorKinds": [
      "invalid-input",
      "timeout",
      "cancelled",
      "conflict",
      "not-found"
    ],
    "exposureClasses": [
      "public",
      "consumer-needed",
      "diagnostic"
    ],
    "fixtureIds": [
      "jobs.queued",
      "jobs.cancelled",
      "jobs.cancelled-problem",
      "jobs.unavailable"
    ],
    "functionClass": "rest-command",
    "method": "post",
    "operationId": "cancelJob",
    "path": "/jobs/{jobId}/cancel",
    "registryRowId": "I06",
    "summary": "Job cancellation command",
    "supportedScenarios": [
      "success",
      "cancelled",
      "unavailable-runtime"
    ],
    "tags": [
      "Jobs"
    ],
    "responseSchemas": {
      "200": "schema-1",
      "400": "schema-2",
      "404": "schema-2",
      "409": "schema-2",
      "503": "schema-2",
      "504": "schema-2"
    }
  },
  {
    "artifactPolicy": "Developer-facing events inline; raw-provider, secret, and hidden reasoning hidden by default.",
    "capabilityDiscovery": [
      "daemon health jobs.processEvents capability"
    ],
    "contractId": "I07.listJobProcessEvents",
    "errorKinds": [
      "partial",
      "unavailable",
      "not-found",
      "internal-error"
    ],
    "exposureClasses": [
      "developer-facing",
      "machine-only",
      "raw-provider",
      "secret"
    ],
    "fixtureIds": [
      "job-event.visible",
      "job-event.partial"
    ],
    "functionClass": "event-stream",
    "method": "get",
    "operationId": "listJobProcessEvents",
    "path": "/jobs/{jobId}/events",
    "registryRowId": "I07",
    "summary": "Job process event recovery",
    "supportedScenarios": [
      "success",
      "partial"
    ],
    "tags": [
      "Jobs",
      "Events"
    ],
    "responseSchemas": {
      "200": "schema-1",
      "206": "schema-2",
      "404": "schema-2",
      "500": "schema-2",
      "503": "schema-2"
    }
  },
  {
    "artifactPolicy": "Snapshot manifest inline; large reports, logs, and LLM IO by artifactRef.",
    "capabilityDiscovery": [
      "jobs capability",
      "snapshot manifest"
    ],
    "contractId": "I08.getJobDisplaySnapshot",
    "errorKinds": [
      "not-found",
      "schema-drift",
      "internal-error"
    ],
    "exposureClasses": [
      "public",
      "developer-facing",
      "diagnostic",
      "sensitive"
    ],
    "fixtureIds": [
      "job-snapshot.success",
      "job-artifact.missing"
    ],
    "functionClass": "job-artifact",
    "method": "get",
    "operationId": "getJobDisplaySnapshot",
    "path": "/jobs/{jobId}/display-snapshot",
    "registryRowId": "I08",
    "summary": "Job display snapshot",
    "supportedScenarios": [
      "success",
      "not-found"
    ],
    "tags": [
      "Jobs"
    ],
    "responseSchemas": {
      "200": "schema-1",
      "404": "schema-2",
      "422": "schema-2",
      "500": "schema-2"
    }
  },
  {
    "artifactPolicy": "Snapshot manifest inline; large reports, logs, and LLM IO by artifactRef.",
    "capabilityDiscovery": [
      "jobs capability",
      "snapshot manifest"
    ],
    "contractId": "I08.getJobArtifact",
    "errorKinds": [
      "not-found",
      "schema-drift",
      "internal-error"
    ],
    "exposureClasses": [
      "public",
      "developer-facing",
      "diagnostic",
      "sensitive"
    ],
    "fixtureIds": [
      "job-snapshot.success",
      "job-artifact.missing"
    ],
    "functionClass": "job-artifact",
    "method": "get",
    "operationId": "getJobArtifact",
    "path": "/jobs/{jobId}/artifacts/{artifactId}",
    "registryRowId": "I08",
    "summary": "Job artifact read",
    "supportedScenarios": [
      "success",
      "not-found"
    ],
    "tags": [
      "Jobs"
    ],
    "responseSchemas": {
      "200": "schema-1",
      "404": "schema-2",
      "422": "schema-2",
      "500": "schema-2"
    }
  },
  {
    "artifactPolicy": "Intent/work summaries inline; long histories by detailRef.",
    "capabilityDiscovery": [
      "/api/v1/intent-episodes capability block"
    ],
    "contractId": "I11.startIntentEpisode",
    "errorKinds": [
      "invalid-input",
      "unavailable",
      "capability-mismatch",
      "not-found"
    ],
    "exposureClasses": [
      "public",
      "consumer-needed",
      "diagnostic"
    ],
    "fixtureIds": [
      "intent-episode.success",
      "intent-episode.not-found"
    ],
    "functionClass": "rest-command",
    "method": "post",
    "operationId": "startIntentEpisode",
    "path": "/intent-episodes",
    "registryRowId": "I11",
    "summary": "Intent/work continuity start",
    "supportedScenarios": [
      "success",
      "not-found"
    ],
    "tags": [
      "Intent"
    ],
    "responseSchemas": {
      "200": "schema-1",
      "400": "schema-2",
      "404": "schema-2",
      "501": "schema-2",
      "503": "schema-2"
    }
  },
  {
    "artifactPolicy": "Intent/work summaries inline; long histories by detailRef.",
    "capabilityDiscovery": [
      "/api/v1/intent-episodes capability block"
    ],
    "contractId": "I11.updateIntentEpisode",
    "errorKinds": [
      "invalid-input",
      "unavailable",
      "capability-mismatch",
      "not-found"
    ],
    "exposureClasses": [
      "public",
      "consumer-needed",
      "diagnostic"
    ],
    "fixtureIds": [
      "intent-episode.success",
      "intent-episode.not-found"
    ],
    "functionClass": "rest-command",
    "method": "patch",
    "operationId": "updateIntentEpisode",
    "path": "/intent-episodes/{episodeId}",
    "registryRowId": "I11",
    "summary": "Intent/work continuity outcome",
    "supportedScenarios": [
      "success",
      "not-found"
    ],
    "tags": [
      "Intent"
    ],
    "responseSchemas": {
      "200": "schema-1",
      "400": "schema-2",
      "404": "schema-2",
      "501": "schema-2",
      "503": "schema-2"
    }
  },
  {
    "artifactPolicy": "Compact guard findings inline; full reports by artifactRef.",
    "capabilityDiscovery": [
      "/api/v1/guard",
      "/api/v1/rules"
    ],
    "contractId": "I21.runGuard",
    "errorKinds": [
      "invalid-input",
      "unavailable",
      "capability-mismatch",
      "internal-error"
    ],
    "exposureClasses": [
      "public",
      "consumer-needed",
      "diagnostic"
    ],
    "fixtureIds": [
      "guard.success",
      "guard.invalid-input"
    ],
    "functionClass": "rest-command",
    "method": "post",
    "operationId": "runGuard",
    "path": "/guard",
    "registryRowId": "I21",
    "summary": "Guard check route family",
    "supportedScenarios": [
      "success",
      "failure"
    ],
    "tags": [
      "Guard"
    ],
    "responseSchemas": {
      "200": "schema-1",
      "400": "schema-2",
      "404": "schema-2",
      "409": "schema-2",
      "500": "schema-2",
      "501": "schema-2",
      "503": "schema-2"
    }
  },
  {
    "artifactPolicy": "Compact guard findings inline; full reports by artifactRef.",
    "capabilityDiscovery": [
      "/api/v1/guard",
      "/api/v1/rules"
    ],
    "contractId": "I21.listGuardRules",
    "errorKinds": [
      "invalid-input",
      "unavailable",
      "capability-mismatch",
      "internal-error"
    ],
    "exposureClasses": [
      "public",
      "consumer-needed",
      "diagnostic"
    ],
    "fixtureIds": [
      "guard.success",
      "guard.invalid-input"
    ],
    "functionClass": "rest-command",
    "method": "get",
    "operationId": "listGuardRules",
    "path": "/rules",
    "registryRowId": "I21",
    "summary": "Guard rules route family",
    "supportedScenarios": [
      "success",
      "failure"
    ],
    "tags": [
      "Guard"
    ],
    "responseSchemas": {
      "200": "schema-1",
      "400": "schema-2",
      "404": "schema-2",
      "409": "schema-2",
      "500": "schema-2",
      "501": "schema-2",
      "503": "schema-2"
    }
  },
  {
    "artifactPolicy": "Compact guard findings inline; full reports by artifactRef.",
    "capabilityDiscovery": [
      "/api/v1/guard",
      "/api/v1/rules"
    ],
    "contractId": "I21.listViolations",
    "errorKinds": [
      "invalid-input",
      "unavailable",
      "capability-mismatch",
      "internal-error"
    ],
    "exposureClasses": [
      "public",
      "consumer-needed",
      "diagnostic"
    ],
    "fixtureIds": [
      "guard.success",
      "guard.invalid-input"
    ],
    "functionClass": "rest-command",
    "method": "get",
    "operationId": "listViolations",
    "path": "/violations",
    "registryRowId": "I21",
    "summary": "Violations route family",
    "supportedScenarios": [
      "success",
      "failure"
    ],
    "tags": [
      "Guard"
    ],
    "responseSchemas": {
      "200": "schema-1",
      "400": "schema-2",
      "404": "schema-2",
      "409": "schema-2",
      "500": "schema-2",
      "501": "schema-2",
      "503": "schema-2"
    }
  },
  {
    "artifactPolicy": "Workflow and resident search summaries inline; reports/snapshots by artifactRef and degraded resident search state by canonical degraded telemetry.",
    "capabilityDiscovery": [
      "/api/v1/knowledge",
      "/api/v1/modules",
      "/api/v1/candidates"
    ],
    "contractId": "I22.listKnowledge",
    "errorKinds": [
      "invalid-input",
      "unavailable",
      "timeout",
      "not-found",
      "degraded",
      "partial",
      "capability-mismatch",
      "provider-error",
      "host-failure",
      "internal-error"
    ],
    "exposureClasses": [
      "public",
      "consumer-needed",
      "diagnostic"
    ],
    "fixtureIds": [
      "knowledge.success",
      "search.success",
      "search.degraded",
      "workflow.unavailable",
      "workflow.degraded",
      "workflow.partial",
      "workflow.capability-mismatch",
      "workflow.provider-error",
      "workflow.host-failure",
      "workflow.internal-error"
    ],
    "functionClass": "rest-command",
    "method": "get",
    "operationId": "listKnowledge",
    "path": "/knowledge",
    "registryRowId": "I22",
    "summary": "Knowledge route family",
    "supportedScenarios": [
      "success",
      "unavailable-runtime",
      "degraded",
      "partial",
      "capability-mismatch",
      "provider-error",
      "host-failure",
      "internal-error"
    ],
    "tags": [
      "Knowledge"
    ],
    "responseSchemas": {
      "200": "schema-1",
      "206": "schema-2",
      "400": "schema-2",
      "404": "schema-2",
      "424": "schema-2",
      "500": "schema-2",
      "501": "schema-2",
      "502": "schema-2",
      "503": "schema-2",
      "504": "schema-2"
    }
  },
  {
    "artifactPolicy": "Workflow and resident search summaries inline; reports/snapshots by artifactRef and degraded resident search state by canonical degraded telemetry.",
    "capabilityDiscovery": [
      "/api/v1/knowledge",
      "/api/v1/modules",
      "/api/v1/candidates"
    ],
    "contractId": "I22.searchKnowledge",
    "errorKinds": [
      "invalid-input",
      "unavailable",
      "timeout",
      "not-found",
      "degraded",
      "partial",
      "capability-mismatch",
      "provider-error",
      "host-failure",
      "internal-error"
    ],
    "exposureClasses": [
      "public",
      "consumer-needed",
      "diagnostic"
    ],
    "fixtureIds": [
      "knowledge.success",
      "search.success",
      "search.degraded",
      "workflow.unavailable",
      "workflow.degraded",
      "workflow.partial",
      "workflow.capability-mismatch",
      "workflow.provider-error",
      "workflow.host-failure",
      "workflow.internal-error"
    ],
    "functionClass": "rest-command",
    "method": "get",
    "operationId": "searchKnowledge",
    "path": "/search",
    "registryRowId": "I22",
    "summary": "Resident search query",
    "supportedScenarios": [
      "success",
      "unavailable-runtime",
      "degraded",
      "partial",
      "capability-mismatch",
      "provider-error",
      "host-failure",
      "internal-error"
    ],
    "tags": [
      "Knowledge"
    ],
    "responseSchemas": {
      "200": "schema-1",
      "206": "schema-2",
      "400": "schema-2",
      "404": "schema-2",
      "424": "schema-2",
      "500": "schema-2",
      "501": "schema-2",
      "502": "schema-2",
      "503": "schema-2",
      "504": "schema-2"
    }
  },
  {
    "artifactPolicy": "Workflow and resident search summaries inline; reports/snapshots by artifactRef and degraded resident search state by canonical degraded telemetry.",
    "capabilityDiscovery": [
      "/api/v1/knowledge",
      "/api/v1/modules",
      "/api/v1/candidates"
    ],
    "contractId": "I22.searchKnowledgeWithHostIntent",
    "errorKinds": [
      "invalid-input",
      "unavailable",
      "timeout",
      "not-found",
      "degraded",
      "partial",
      "capability-mismatch",
      "provider-error",
      "host-failure",
      "internal-error"
    ],
    "exposureClasses": [
      "public",
      "consumer-needed",
      "diagnostic"
    ],
    "fixtureIds": [
      "knowledge.success",
      "search.success",
      "search.degraded",
      "workflow.unavailable",
      "workflow.degraded",
      "workflow.partial",
      "workflow.capability-mismatch",
      "workflow.provider-error",
      "workflow.host-failure",
      "workflow.internal-error"
    ],
    "functionClass": "rest-command",
    "method": "post",
    "operationId": "searchKnowledgeWithHostIntent",
    "path": "/search",
    "registryRowId": "I22",
    "summary": "Resident search command",
    "supportedScenarios": [
      "success",
      "unavailable-runtime",
      "degraded",
      "partial",
      "capability-mismatch",
      "provider-error",
      "host-failure",
      "internal-error"
    ],
    "tags": [
      "Knowledge"
    ],
    "responseSchemas": {
      "200": "schema-1",
      "206": "schema-2",
      "400": "schema-2",
      "404": "schema-2",
      "424": "schema-2",
      "500": "schema-2",
      "501": "schema-2",
      "502": "schema-2",
      "503": "schema-2",
      "504": "schema-2"
    }
  },
  {
    "artifactPolicy": "Workflow and resident search summaries inline; reports/snapshots by artifactRef and degraded resident search state by canonical degraded telemetry.",
    "capabilityDiscovery": [
      "/api/v1/knowledge",
      "/api/v1/modules",
      "/api/v1/candidates"
    ],
    "contractId": "I22.listRecipes",
    "errorKinds": [
      "invalid-input",
      "unavailable",
      "timeout",
      "not-found",
      "degraded",
      "partial",
      "capability-mismatch",
      "provider-error",
      "host-failure",
      "internal-error"
    ],
    "exposureClasses": [
      "public",
      "consumer-needed",
      "diagnostic"
    ],
    "fixtureIds": [
      "knowledge.success",
      "search.success",
      "search.degraded",
      "workflow.unavailable",
      "workflow.degraded",
      "workflow.partial",
      "workflow.capability-mismatch",
      "workflow.provider-error",
      "workflow.host-failure",
      "workflow.internal-error"
    ],
    "functionClass": "rest-command",
    "method": "get",
    "operationId": "listRecipes",
    "path": "/recipes",
    "registryRowId": "I22",
    "summary": "Recipe route family",
    "supportedScenarios": [
      "success",
      "unavailable-runtime",
      "degraded",
      "partial",
      "capability-mismatch",
      "provider-error",
      "host-failure",
      "internal-error"
    ],
    "tags": [
      "Knowledge"
    ],
    "responseSchemas": {
      "200": "schema-1",
      "206": "schema-2",
      "400": "schema-2",
      "404": "schema-2",
      "424": "schema-2",
      "500": "schema-2",
      "501": "schema-2",
      "502": "schema-2",
      "503": "schema-2",
      "504": "schema-2"
    }
  },
  {
    "artifactPolicy": "Workflow and resident search summaries inline; reports/snapshots by artifactRef and degraded resident search state by canonical degraded telemetry.",
    "capabilityDiscovery": [
      "/api/v1/knowledge",
      "/api/v1/modules",
      "/api/v1/candidates"
    ],
    "contractId": "I22.scanModules",
    "errorKinds": [
      "invalid-input",
      "unavailable",
      "timeout",
      "not-found",
      "degraded",
      "partial",
      "capability-mismatch",
      "provider-error",
      "host-failure",
      "internal-error"
    ],
    "exposureClasses": [
      "public",
      "consumer-needed",
      "diagnostic"
    ],
    "fixtureIds": [
      "knowledge.success",
      "search.success",
      "search.degraded",
      "workflow.unavailable",
      "workflow.degraded",
      "workflow.partial",
      "workflow.capability-mismatch",
      "workflow.provider-error",
      "workflow.host-failure",
      "workflow.internal-error"
    ],
    "functionClass": "rest-command",
    "method": "post",
    "operationId": "scanModules",
    "path": "/modules/scan",
    "registryRowId": "I22",
    "summary": "Module scan command",
    "supportedScenarios": [
      "success",
      "unavailable-runtime",
      "degraded",
      "partial",
      "capability-mismatch",
      "provider-error",
      "host-failure",
      "internal-error"
    ],
    "tags": [
      "Knowledge"
    ],
    "responseSchemas": {
      "200": "schema-1",
      "206": "schema-2",
      "400": "schema-2",
      "404": "schema-2",
      "424": "schema-2",
      "500": "schema-2",
      "501": "schema-2",
      "502": "schema-2",
      "503": "schema-2",
      "504": "schema-2"
    }
  },
  {
    "artifactPolicy": "Workflow and resident search summaries inline; reports/snapshots by artifactRef and degraded resident search state by canonical degraded telemetry.",
    "capabilityDiscovery": [
      "/api/v1/knowledge",
      "/api/v1/modules",
      "/api/v1/candidates"
    ],
    "contractId": "I22.generateWiki",
    "errorKinds": [
      "invalid-input",
      "unavailable",
      "timeout",
      "not-found",
      "degraded",
      "partial",
      "capability-mismatch",
      "provider-error",
      "host-failure",
      "internal-error"
    ],
    "exposureClasses": [
      "public",
      "consumer-needed",
      "diagnostic"
    ],
    "fixtureIds": [
      "knowledge.success",
      "search.success",
      "search.degraded",
      "workflow.unavailable",
      "workflow.degraded",
      "workflow.partial",
      "workflow.capability-mismatch",
      "workflow.provider-error",
      "workflow.host-failure",
      "workflow.internal-error"
    ],
    "functionClass": "rest-command",
    "method": "post",
    "operationId": "generateWiki",
    "path": "/wiki/generate",
    "registryRowId": "I22",
    "summary": "Wiki generation command",
    "supportedScenarios": [
      "success",
      "unavailable-runtime",
      "degraded",
      "partial",
      "capability-mismatch",
      "provider-error",
      "host-failure",
      "internal-error"
    ],
    "tags": [
      "Knowledge"
    ],
    "responseSchemas": {
      "200": "schema-1",
      "206": "schema-2",
      "400": "schema-2",
      "404": "schema-2",
      "424": "schema-2",
      "500": "schema-2",
      "501": "schema-2",
      "502": "schema-2",
      "503": "schema-2",
      "504": "schema-2"
    }
  },
  {
    "artifactPolicy": "Workflow and resident search summaries inline; reports/snapshots by artifactRef and degraded resident search state by canonical degraded telemetry.",
    "capabilityDiscovery": [
      "/api/v1/knowledge",
      "/api/v1/modules",
      "/api/v1/candidates"
    ],
    "contractId": "I22.getPanorama",
    "errorKinds": [
      "invalid-input",
      "unavailable",
      "timeout",
      "not-found",
      "degraded",
      "partial",
      "capability-mismatch",
      "provider-error",
      "host-failure",
      "internal-error"
    ],
    "exposureClasses": [
      "public",
      "consumer-needed",
      "diagnostic"
    ],
    "fixtureIds": [
      "knowledge.success",
      "search.success",
      "search.degraded",
      "workflow.unavailable",
      "workflow.degraded",
      "workflow.partial",
      "workflow.capability-mismatch",
      "workflow.provider-error",
      "workflow.host-failure",
      "workflow.internal-error"
    ],
    "functionClass": "rest-command",
    "method": "get",
    "operationId": "getPanorama",
    "path": "/panorama",
    "registryRowId": "I22",
    "summary": "Panorama route family",
    "supportedScenarios": [
      "success",
      "unavailable-runtime",
      "degraded",
      "partial",
      "capability-mismatch",
      "provider-error",
      "host-failure",
      "internal-error"
    ],
    "tags": [
      "Knowledge"
    ],
    "responseSchemas": {
      "200": "schema-1",
      "206": "schema-2",
      "400": "schema-2",
      "404": "schema-2",
      "424": "schema-2",
      "500": "schema-2",
      "501": "schema-2",
      "502": "schema-2",
      "503": "schema-2",
      "504": "schema-2"
    }
  },
  {
    "artifactPolicy": "Workflow and resident search summaries inline; reports/snapshots by artifactRef and degraded resident search state by canonical degraded telemetry.",
    "capabilityDiscovery": [
      "/api/v1/knowledge",
      "/api/v1/modules",
      "/api/v1/candidates"
    ],
    "contractId": "I22.listEvolutionProposals",
    "errorKinds": [
      "invalid-input",
      "unavailable",
      "timeout",
      "not-found",
      "degraded",
      "partial",
      "capability-mismatch",
      "provider-error",
      "host-failure",
      "internal-error"
    ],
    "exposureClasses": [
      "public",
      "consumer-needed",
      "diagnostic"
    ],
    "fixtureIds": [
      "knowledge.success",
      "search.success",
      "search.degraded",
      "workflow.unavailable",
      "workflow.degraded",
      "workflow.partial",
      "workflow.capability-mismatch",
      "workflow.provider-error",
      "workflow.host-failure",
      "workflow.internal-error"
    ],
    "functionClass": "rest-command",
    "method": "get",
    "operationId": "listEvolutionProposals",
    "path": "/evolution/proposals",
    "registryRowId": "I22",
    "summary": "Evolution proposal route family",
    "supportedScenarios": [
      "success",
      "unavailable-runtime",
      "degraded",
      "partial",
      "capability-mismatch",
      "provider-error",
      "host-failure",
      "internal-error"
    ],
    "tags": [
      "Knowledge"
    ],
    "responseSchemas": {
      "200": "schema-1",
      "206": "schema-2",
      "400": "schema-2",
      "404": "schema-2",
      "424": "schema-2",
      "500": "schema-2",
      "501": "schema-2",
      "502": "schema-2",
      "503": "schema-2",
      "504": "schema-2"
    }
  },
  {
    "artifactPolicy": "Diagnostic summaries inline; logs and reports as detailRef.",
    "capabilityDiscovery": [
      "runtime health fileMonitor capability",
      "diagnostic routes"
    ],
    "contractId": "I23.submitFileChanges",
    "errorKinds": [
      "invalid-input",
      "unavailable",
      "permission-denied",
      "not-found",
      "internal-error"
    ],
    "exposureClasses": [
      "diagnostic",
      "internal",
      "consumer-needed",
      "sensitive"
    ],
    "fixtureIds": [
      "diagnostic.success",
      "diagnostic.failure",
      "diagnostic.internal-error"
    ],
    "functionClass": "diagnostic-observability",
    "method": "post",
    "operationId": "submitFileChanges",
    "path": "/file-changes",
    "registryRowId": "I23",
    "summary": "File change diagnostic intake",
    "supportedScenarios": [
      "success",
      "unavailable-runtime",
      "internal-error"
    ],
    "tags": [
      "Diagnostics"
    ],
    "responseSchemas": {
      "200": "schema-1",
      "400": "schema-2",
      "403": "schema-2",
      "404": "schema-2",
      "500": "schema-2",
      "503": "schema-2"
    }
  },
  {
    "artifactPolicy": "Diagnostic summaries inline; logs and reports as detailRef.",
    "capabilityDiscovery": [
      "runtime health fileMonitor capability",
      "diagnostic routes"
    ],
    "contractId": "I23.getSignalTrace",
    "errorKinds": [
      "invalid-input",
      "unavailable",
      "permission-denied",
      "not-found",
      "internal-error"
    ],
    "exposureClasses": [
      "diagnostic",
      "internal",
      "consumer-needed",
      "sensitive"
    ],
    "fixtureIds": [
      "diagnostic.success",
      "diagnostic.failure",
      "diagnostic.internal-error"
    ],
    "functionClass": "diagnostic-observability",
    "method": "get",
    "operationId": "getSignalTrace",
    "path": "/signals/trace",
    "registryRowId": "I23",
    "summary": "Signal trace diagnostic route",
    "supportedScenarios": [
      "success",
      "unavailable-runtime",
      "internal-error"
    ],
    "tags": [
      "Diagnostics"
    ],
    "responseSchemas": {
      "200": "schema-1",
      "400": "schema-2",
      "403": "schema-2",
      "404": "schema-2",
      "500": "schema-2",
      "503": "schema-2"
    }
  },
  {
    "artifactPolicy": "Diagnostic summaries inline; logs and reports as detailRef.",
    "capabilityDiscovery": [
      "runtime health fileMonitor capability",
      "diagnostic routes"
    ],
    "contractId": "I23.listAuditEntries",
    "errorKinds": [
      "invalid-input",
      "unavailable",
      "permission-denied",
      "not-found",
      "internal-error"
    ],
    "exposureClasses": [
      "diagnostic",
      "internal",
      "consumer-needed",
      "sensitive"
    ],
    "fixtureIds": [
      "diagnostic.success",
      "diagnostic.failure",
      "diagnostic.internal-error"
    ],
    "functionClass": "diagnostic-observability",
    "method": "get",
    "operationId": "listAuditEntries",
    "path": "/audit",
    "registryRowId": "I23",
    "summary": "Audit route family",
    "supportedScenarios": [
      "success",
      "unavailable-runtime",
      "internal-error"
    ],
    "tags": [
      "Diagnostics"
    ],
    "responseSchemas": {
      "200": "schema-1",
      "400": "schema-2",
      "403": "schema-2",
      "404": "schema-2",
      "500": "schema-2",
      "503": "schema-2"
    }
  },
  {
    "artifactPolicy": "Diagnostic summaries inline; logs and reports as detailRef.",
    "capabilityDiscovery": [
      "runtime health fileMonitor capability",
      "diagnostic routes"
    ],
    "contractId": "I23.getMonitoringHealth",
    "errorKinds": [
      "invalid-input",
      "unavailable",
      "permission-denied",
      "not-found",
      "internal-error"
    ],
    "exposureClasses": [
      "diagnostic",
      "internal",
      "consumer-needed",
      "sensitive"
    ],
    "fixtureIds": [
      "diagnostic.success",
      "diagnostic.failure",
      "diagnostic.internal-error"
    ],
    "functionClass": "diagnostic-observability",
    "method": "get",
    "operationId": "getMonitoringHealth",
    "path": "/monitoring/health",
    "registryRowId": "I23",
    "summary": "Monitoring health route",
    "supportedScenarios": [
      "success",
      "unavailable-runtime",
      "internal-error"
    ],
    "tags": [
      "Diagnostics"
    ],
    "responseSchemas": {
      "200": "schema-1",
      "400": "schema-2",
      "403": "schema-2",
      "404": "schema-2",
      "500": "schema-2",
      "503": "schema-2"
    }
  },
  {
    "artifactPolicy": "Diagnostic summaries inline; logs and reports as detailRef.",
    "capabilityDiscovery": [
      "runtime health fileMonitor capability",
      "diagnostic routes"
    ],
    "contractId": "I23.listLogs",
    "errorKinds": [
      "invalid-input",
      "unavailable",
      "permission-denied",
      "not-found",
      "internal-error"
    ],
    "exposureClasses": [
      "diagnostic",
      "internal",
      "consumer-needed",
      "sensitive"
    ],
    "fixtureIds": [
      "diagnostic.success",
      "diagnostic.failure",
      "diagnostic.internal-error"
    ],
    "functionClass": "diagnostic-observability",
    "method": "get",
    "operationId": "listLogs",
    "path": "/logs",
    "registryRowId": "I23",
    "summary": "Log route family",
    "supportedScenarios": [
      "success",
      "unavailable-runtime",
      "internal-error"
    ],
    "tags": [
      "Diagnostics"
    ],
    "responseSchemas": {
      "200": "schema-1",
      "400": "schema-2",
      "403": "schema-2",
      "404": "schema-2",
      "500": "schema-2",
      "503": "schema-2"
    }
  }
];
