/**
 * Global type declarations for AutoSnippet project.
 *
 * Types are organized into modular files:
 *   - ast.d.ts       — TreeSitter, ClassInfo, MethodInfo, FileSymbols, etc.
 *   - agent.d.ts     — Plan, PlanStep, Round, DistilledContext
 *   - bootstrap.d.ts — DimensionDigest, CandidateSummary, etc.
 *   - guard.d.ts     — ComplianceReport
 *   - common.d.ts    — WikiResult, ProjectOverview, FieldDef, OverrideInfo
 *
 * All files use ambient declarations (no import/export) so types are
 * globally available via JSDoc @param {TypeName} annotations.
 */

