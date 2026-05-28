import { describe, expect, test } from 'vitest';
import { buildPcvN11SourceRefReplayEvidence } from '../../lib/workflows/capabilities/execution/internal-agent/BootstrapPcvNodeLocalEvidence.js';
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
});
