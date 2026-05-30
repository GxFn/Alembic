import { describe, expect, test } from 'vitest';
import {
  buildPcvN11ProduceEvidence,
  buildPcvN11SourceRefReplayEvidence,
} from '../../lib/workflows/capabilities/execution/internal-agent/BootstrapPcvNodeLocalEvidence.js';
import type { BootstrapDimensionProjection } from '../../lib/workflows/capabilities/execution/internal-agent/BootstrapProjections.js';
import { WAVE4E_N11_SOURCE_REF_REPLAY_FIXTURE } from '../fixtures/pcv-n11-source-ref-replay.js';

describe('PCV N11 sourceRef replay', () => {
  test('replays the Wave 4E 9/33 sourceRef baseline through the N11 builder', () => {
    const fixture = WAVE4E_N11_SOURCE_REF_REPLAY_FIXTURE;
    const evidence = buildPcvN11SourceRefReplayEvidence({
      acceptedCount: fixture.acceptedCount,
      dimId: fixture.dimId,
      projectRoot: fixture.projectRoot,
      sourceRefs: [...fixture.sourceRefs],
      validSourceRefs: [...fixture.validSourceRefs],
    });

    expect(evidence).toMatchObject({
      acceptedCount: fixture.acceptedCount,
      invalidSourceRefCount: fixture.expected.invalid,
      invalidSourceRefRatio: fixture.expected.ratio,
      missingLinkReasons: ['producer_source_refs_invalid'],
      sourceRefValidityStatus: 'invalid',
      status: 'blocked-by-observability-gap',
      submittedCount: fixture.acceptedCount,
      totalSourceRefCount: fixture.expected.total,
      validSourceRefCount: fixture.expected.valid,
    });
    expect(evidence.sourceRefs).toEqual(fixture.sourceRefs);
    expect(evidence.invalidSourceRefs.map((entry) => entry.ref)).toEqual(
      fixture.invalidSourceRefs.slice(0, evidence.invalidSourceRefs.length)
    );
    expect(evidence.sourceRefValidity).toMatchObject({
      checked: true,
      invalidSourceRefCount: fixture.expected.invalid,
      invalidSourceRefRatio: fixture.expected.ratio,
      status: 'invalid',
      totalSourceRefCount: fixture.expected.total,
      uncheckedReason: null,
      validSourceRefCount: fixture.expected.valid,
    });
  });

  test('is deterministic for repeated replay input', () => {
    const fixture = WAVE4E_N11_SOURCE_REF_REPLAY_FIXTURE;
    const input = {
      acceptedCount: fixture.acceptedCount,
      dimId: fixture.dimId,
      projectRoot: fixture.projectRoot,
      sourceRefs: [...fixture.sourceRefs],
      validSourceRefs: [...fixture.validSourceRefs],
    };

    expect(buildPcvN11SourceRefReplayEvidence(input)).toEqual(
      buildPcvN11SourceRefReplayEvidence(input)
    );
  });

  test('carries AlembicAgent sourceRefValidation repair and reject taxonomy', () => {
    const projection: BootstrapDimensionProjection = {
      analysisReport: { analysisText: '', findings: [], referencedFiles: [] },
      analysisText: '',
      artifact: {},
      combinedTokenUsage: { input: 0, output: 0 },
      efficiency: null,
      producerResult: { candidateCount: 1, rejectedCount: 1, toolCalls: [] },
      produceResult: {
        toolCalls: [
          {
            args: {
              params: {
                action: 'submit',
                sourceRefs: ['README.m', 'CookieManager.swift'],
              },
            },
            result: {
              sourceRefs: ['README.md', 'Sources/Infrastructure/Account/CookieManager.swift'],
              sourceRefValidation: {
                invalidSourceRefCount: 0,
                mode: 'strict',
                policy: { mode: 'strict' },
                rejectedSourceRefs: [],
                repairedSourceRefs: [
                  { from: 'README.m', reason: 'wrong-extension-unique-sibling', to: 'README.md' },
                  {
                    from: 'CookieManager.swift',
                    reason: 'missing-prefix-unique-basename',
                    to: 'Sources/Infrastructure/Account/CookieManager.swift',
                  },
                ],
                status: 'repaired',
                warnings: [],
              },
              status: 'created',
            },
            tool: 'knowledge',
          },
          {
            args: {
              params: {
                action: 'submit',
                sourceRefs: [
                  'Sources/Infrastructure/Networking/NetworkMonitor.swift',
                  'ClosureCookieProvider.swift',
                  'Duplicate.swift',
                  '/outside/project/Secret.swift',
                ],
              },
            },
            result: {
              data: {
                sourceRefValidation: {
                  invalidSourceRefCount: 4,
                  mode: 'strict',
                  policy: { mode: 'strict' },
                  rejectedSourceRefs: [
                    {
                      reason: 'package-path-mismatch',
                      ref: 'Sources/Infrastructure/Networking/NetworkMonitor.swift',
                    },
                    { reason: 'entity-not-file', ref: 'ClosureCookieProvider.swift' },
                    { reason: 'ambiguous-basename', ref: 'Duplicate.swift' },
                    { reason: 'outside-project-root', ref: '/outside/project/Secret.swift' },
                  ],
                  repairedSourceRefs: [],
                  status: 'rejected',
                  warnings: [],
                },
              },
              error: 'source_ref_validation_failed',
              status: 'error',
            },
            tool: 'knowledge',
          },
        ],
      },
      rejectedCount: 1,
      runtimeToolCalls: [],
      submitCalls: [],
      successCount: 1,
    };

    const evidence = buildPcvN11ProduceEvidence({
      dimId: 'design-patterns',
      needsCandidates: true,
      projection,
      sourceRefValidation: {
        allFiles: [
          { relativePath: 'README.md' },
          { relativePath: 'Sources/Infrastructure/Account/CookieManager.swift' },
          {
            relativePath:
              'Packages/AOXFoundationKit/Sources/AOXFoundationKit/Network/NetworkMonitor.swift',
          },
          { relativePath: 'Sources/FeatureA/Duplicate.swift' },
          { relativePath: 'Sources/FeatureB/Duplicate.swift' },
        ],
        projectRoot: '/fixture/BiliDili',
      },
    });

    expect(evidence).toMatchObject({
      invalidSourceRefCount: 4,
      missingLinkReasons: ['producer_source_refs_invalid'],
      repairedSourceRefCount: 2,
      rejectedCount: 1,
      rejectedSourceRefCount: 4,
      sourceRefValidationMode: 'strict',
      sourceRefValidityStatus: 'invalid',
      status: 'blocked-by-observability-gap',
    });
    expect(evidence.sourceRefReasonCounts).toMatchObject({
      'ambiguous-basename': 1,
      'entity-not-file': 1,
      'missing-prefix': 1,
      'outside-project-root': 1,
      'package-path-mismatch': 1,
      'wrong-extension': 1,
    });
    expect(
      evidence.repairedSourceRefs.map((entry) => [entry.from, entry.to, entry.reason])
    ).toEqual([
      ['README.m', 'README.md', 'wrong-extension'],
      [
        'CookieManager.swift',
        'Sources/Infrastructure/Account/CookieManager.swift',
        'missing-prefix',
      ],
    ]);
    expect(evidence.rejectedSourceRefs.map((entry) => [entry.ref, entry.reason])).toEqual([
      ['Sources/Infrastructure/Networking/NetworkMonitor.swift', 'package-path-mismatch'],
      ['ClosureCookieProvider.swift', 'entity-not-file'],
      ['Duplicate.swift', 'ambiguous-basename'],
      ['/outside/project/Secret.swift', 'outside-project-root'],
    ]);
  });

  test('classifies report-time fallback sourceRef reasons with the P7 taxonomy', () => {
    const evidence = buildPcvN11SourceRefReplayEvidence({
      acceptedCount: 1,
      dimId: 'design-patterns',
      projectRoot: '/fixture/BiliDili',
      sourceRefs: [
        'README.md',
        'README.m',
        'CookieManager.swift',
        'Sources/Infrastructure/Networking/NetworkMonitor.swift',
        'ClosureCookieProvider.swift',
        'Duplicate.swift',
        '../../outside.swift',
        'docs/MissingThing.md',
      ],
      validSourceRefs: [
        'README.md',
        'docs/LaunchFlow.md',
        'Sources/Infrastructure/Account/CookieManager.swift',
        'Packages/AOXFoundationKit/Sources/AOXFoundationKit/Network/NetworkMonitor.swift',
        'Sources/FeatureA/Duplicate.swift',
        'Sources/FeatureB/Duplicate.swift',
      ],
    });

    expect(evidence.sourceRefValidity.reasonCounts).toMatchObject({
      'ambiguous-basename': 1,
      'entity-not-file': 1,
      'file-not-found': 1,
      'missing-prefix': 1,
      'outside-project-root': 1,
      'package-path-mismatch': 1,
      'wrong-extension': 1,
    });
    expect(
      Object.fromEntries(evidence.invalidSourceRefs.map((entry) => [entry.ref, entry.reason]))
    ).toMatchObject({
      '../../outside.swift': 'outside-project-root',
      'ClosureCookieProvider.swift': 'entity-not-file',
      'CookieManager.swift': 'missing-prefix',
      'Duplicate.swift': 'ambiguous-basename',
      'README.m': 'wrong-extension',
      'Sources/Infrastructure/Networking/NetworkMonitor.swift': 'package-path-mismatch',
      'docs/MissingThing.md': 'file-not-found',
    });
  });
});
