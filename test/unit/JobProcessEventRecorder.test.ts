import { describe, expect, test, vi } from 'vitest';
import { JobProcessEventRecorder } from '../../lib/daemon/JobProcessEventRecorder.js';

describe('JobProcessEventRecorder', () => {
  test('records Core job process events and broadcasts developer views', () => {
    const broadcast = vi.fn();
    const recorder = new JobProcessEventRecorder({ broadcast, maxEventsPerJob: 5 });

    const first = recorder.record({
      jobId: 'bootstrap_test',
      kind: 'workflow',
      phase: 'queued',
      summary: 'Job queued',
      title: 'Daemon job enqueued',
    });
    const second = recorder.record({
      jobId: 'bootstrap_test',
      kind: 'summary',
      phase: 'complete',
      severity: 'success',
      summary: 'Job complete',
      title: 'Daemon job completed',
    });

    expect(first.event).toMatchObject({
      contractVersion: 1,
      displayPolicy: 'full',
      jobId: 'bootstrap_test',
      kind: 'workflow',
      sequence: 1,
    });
    expect(second.developerView).toMatchObject({
      eventId: 'bootstrap_test_process_0002',
      jobId: 'bootstrap_test',
      sequence: 2,
      title: 'Daemon job completed',
    });
    expect(broadcast).toHaveBeenCalledTimes(2);
    expect(broadcast).toHaveBeenLastCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({ title: 'Daemon job completed' }),
        eventId: 'bootstrap_test_process_0002',
        jobId: 'bootstrap_test',
        type: 'job_process_event',
      })
    );
  });

  test('keeps a bounded recent event list and hides machine-only events by default', () => {
    const broadcast = vi.fn();
    const recorder = new JobProcessEventRecorder({ broadcast, maxEventsPerJob: 2 });

    recorder.record({ jobId: 'job_1', kind: 'workflow', title: 'one' });
    recorder.record({
      jobId: 'job_1',
      kind: 'checkpoint',
      sourceClass: 'machine-only',
      title: 'machine checkpoint',
    });
    recorder.record({ jobId: 'job_1', kind: 'summary', title: 'three' });

    const publicList = recorder.list('job_1', { includeHidden: false, limit: 10 });
    const internalList = recorder.list('job_1', { includeHidden: true, limit: 10 });

    expect(publicList.events.map((event) => event.title)).toEqual(['three']);
    expect(publicList.hiddenCount).toBe(1);
    expect(internalList.events.map((event) => event.title)).toEqual([
      'machine checkpoint',
      'three',
    ]);
    expect(broadcast).toHaveBeenCalledTimes(2);
  });

  test('keeps large job artifacts behind artifact refs in developer views', () => {
    const recorder = new JobProcessEventRecorder({ maxEventsPerJob: 5 });

    recorder.record({
      artifactRefs: [
        {
          kind: 'llm-output',
          label: 'Full LLM output',
          mimeType: 'text/markdown',
          ref: '/api/v1/jobs/job_1/artifacts/llm-output-full.md',
        },
      ],
      content: null,
      jobId: 'job_1',
      kind: 'llm.output',
      metadata: {
        contentOriginalChars: 64_000,
        contentRetainedChars: 0,
        contentTruncated: true,
      },
      phase: 'dimension-output',
      summary: 'LLM output stored as artifact.',
      title: 'LLM output artifact available',
    });

    const publicList = recorder.list('job_1', { limit: 10 });

    expect(publicList.developerViews).toEqual([
      expect.objectContaining({
        artifactRefs: [
          expect.objectContaining({
            kind: 'llm-output',
            ref: '/api/v1/jobs/job_1/artifacts/llm-output-full.md',
          }),
        ],
        content: null,
        metadata: expect.objectContaining({
          contentOriginalChars: 64_000,
          contentTruncated: true,
        }),
        summary: 'LLM output stored as artifact.',
      }),
    ]);
  });
});
