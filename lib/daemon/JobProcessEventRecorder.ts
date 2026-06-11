import {
  ALEMBIC_JOB_PROCESS_EVENTS_PATH,
  type CreateJobProcessEventInput,
  createJobProcessDeveloperView,
  createJobProcessEvent,
  createJobProcessEventEndpointCapability,
  isJobProcessEventDeveloperVisible,
  type JobProcessDeveloperView,
  type JobProcessEvent,
  type JobProcessEventEndpointCapability,
  normalizeJobProcessEvent,
} from '@alembic/core/daemon';

export const DEFAULT_JOB_PROCESS_EVENT_LIMIT = 240;
export const DEFAULT_GLOBAL_PROCESS_EVENT_LIMIT = 2400;

export interface JobProcessEventRecordInput
  extends Omit<CreateJobProcessEventInput, 'createdAt' | 'id' | 'sequence'> {
  createdAt?: string;
  id?: string;
  sequence?: number;
}

export interface JobProcessEventBroadcastPayload {
  event: JobProcessDeveloperView;
  eventId: string;
  jobId: string;
  sequence: number;
  type: 'job_process_event';
}

export interface JobProcessEventBroadcastFailure {
  error: string;
  eventId: string;
  jobId: string;
  occurredAt: string;
  sequence: number;
}

export interface JobProcessEventListOptions {
  afterSequence?: number;
  includeHidden?: boolean;
  limit?: number;
}

export interface JobProcessEventListResult {
  count: number;
  developerViews: JobProcessDeveloperView[];
  diagnostics?: {
    broadcastFailures: JobProcessEventBroadcastFailure[];
  };
  endpointCapability: JobProcessEventEndpointCapability;
  events: JobProcessEvent[];
  hiddenCount: number;
  jobId: string;
  nextSequence: number;
  retainedCount: number;
}

interface JobProcessEventRecorderOptions {
  broadcast?: (payload: JobProcessEventBroadcastPayload) => void;
  logger?: { warn(message: string, meta?: Record<string, unknown>): void };
  maxEventsPerJob?: number;
  maxGlobalEvents?: number;
}

export class JobProcessEventRecorder {
  readonly maxEventsPerJob: number;
  readonly maxGlobalEvents: number;

  #broadcast: ((payload: JobProcessEventBroadcastPayload) => void) | null;
  #broadcastFailuresByJob = new Map<string, JobProcessEventBroadcastFailure[]>();
  #eventsByJob = new Map<string, JobProcessEvent[]>();
  #lastSequenceByJob = new Map<string, number>();
  #logger: { warn(message: string, meta?: Record<string, unknown>): void } | null;

  constructor(options: JobProcessEventRecorderOptions = {}) {
    this.maxEventsPerJob = Math.max(1, options.maxEventsPerJob ?? DEFAULT_JOB_PROCESS_EVENT_LIMIT);
    this.maxGlobalEvents = Math.max(
      this.maxEventsPerJob,
      options.maxGlobalEvents ?? DEFAULT_GLOBAL_PROCESS_EVENT_LIMIT
    );
    this.#broadcast = options.broadcast ?? null;
    this.#logger = options.logger ?? null;
  }

  record(input: JobProcessEventRecordInput): {
    developerView: JobProcessDeveloperView | null;
    event: JobProcessEvent;
  } {
    const sequence = this.#nextSequence(input.jobId, input.sequence);
    const event = createJobProcessEvent({
      ...input,
      createdAt: input.createdAt ?? new Date().toISOString(),
      id: input.id ?? createEventId(input.jobId, sequence),
      sequence,
    });

    if (event.retention !== 'transient') {
      this.#append(event);
    }

    const developerView = createJobProcessDeveloperView(event);
    if (developerView) {
      this.#broadcastDeveloperView(developerView);
    }

    return { developerView, event };
  }

  ingest(value: unknown): JobProcessEvent | null {
    const event = normalizeJobProcessEvent(value);
    if (!event) {
      return null;
    }
    this.#lastSequenceByJob.set(
      event.jobId,
      Math.max(this.#lastSequenceByJob.get(event.jobId) ?? 0, event.sequence)
    );
    if (event.retention !== 'transient') {
      this.#append(event);
    }
    return event;
  }

  list(jobId: string, options: JobProcessEventListOptions = {}): JobProcessEventListResult {
    const afterSequence = numberOrFallback(options.afterSequence, 0);
    const limit = Math.max(1, Math.min(numberOrFallback(options.limit, 100), this.maxEventsPerJob));
    const retained = this.#eventsByJob.get(jobId) ?? [];
    const afterCursor = retained.filter((event) => event.sequence > afterSequence);
    const visibleEvents = options.includeHidden
      ? afterCursor
      : afterCursor.filter(isJobProcessEventDeveloperVisible);
    const events = visibleEvents.slice(-limit).map(cloneEvent);
    const developerViews = events
      .map((event) => createJobProcessDeveloperView(event))
      .filter((view): view is JobProcessDeveloperView => Boolean(view));
    const hiddenCount =
      afterCursor.length - afterCursor.filter(isJobProcessEventDeveloperVisible).length;
    const broadcastFailures = (this.#broadcastFailuresByJob.get(jobId) ?? [])
      .filter((failure) => failure.sequence > afterSequence)
      .slice(-limit)
      .map((failure) => ({ ...failure }));

    return {
      count: events.length,
      developerViews,
      ...(broadcastFailures.length > 0 ? { diagnostics: { broadcastFailures } } : {}),
      endpointCapability: createAvailableJobProcessEventCapability(),
      events,
      hiddenCount,
      jobId,
      nextSequence: this.#lastSequenceByJob.get(jobId) ?? 0,
      retainedCount: retained.length,
    };
  }

  resetJob(jobId: string): void {
    this.#eventsByJob.delete(jobId);
    this.#lastSequenceByJob.delete(jobId);
    this.#broadcastFailuresByJob.delete(jobId);
  }

  #append(event: JobProcessEvent): void {
    const existing = this.#eventsByJob.get(event.jobId) ?? [];
    const withoutDuplicate = existing.filter((candidate) => candidate.id !== event.id);
    withoutDuplicate.push(cloneEvent(event));
    if (withoutDuplicate.length > this.maxEventsPerJob) {
      withoutDuplicate.splice(0, withoutDuplicate.length - this.maxEventsPerJob);
    }
    this.#eventsByJob.set(event.jobId, withoutDuplicate);
    this.#trimGlobalEvents();
  }

  #broadcastDeveloperView(event: JobProcessDeveloperView): void {
    if (!this.#broadcast) {
      return;
    }
    const payload = {
      event,
      eventId: event.eventId,
      jobId: event.jobId,
      sequence: event.sequence,
      type: 'job_process_event' as const,
    };
    try {
      this.#broadcast({
        ...payload,
      });
    } catch (error: unknown) {
      const failure: JobProcessEventBroadcastFailure = {
        error: error instanceof Error ? error.message : String(error),
        eventId: event.eventId,
        jobId: event.jobId,
        occurredAt: new Date().toISOString(),
        sequence: event.sequence,
      };
      this.#appendBroadcastFailure(failure);
      this.#logger?.warn('Job process event broadcast failed', {
        error: failure.error,
        eventId: failure.eventId,
        jobId: failure.jobId,
        sequence: failure.sequence,
      });
    }
  }

  #appendBroadcastFailure(failure: JobProcessEventBroadcastFailure): void {
    const failures = this.#broadcastFailuresByJob.get(failure.jobId) ?? [];
    failures.push({ ...failure });
    if (failures.length > this.maxEventsPerJob) {
      failures.splice(0, failures.length - this.maxEventsPerJob);
    }
    this.#broadcastFailuresByJob.set(failure.jobId, failures);
  }

  #nextSequence(jobId: string, explicitSequence?: number): number {
    const last = this.#lastSequenceByJob.get(jobId) ?? 0;
    const sequence =
      typeof explicitSequence === 'number' && Number.isFinite(explicitSequence)
        ? Math.max(explicitSequence, last + 1)
        : last + 1;
    this.#lastSequenceByJob.set(jobId, sequence);
    return sequence;
  }

  #trimGlobalEvents(): void {
    let total = 0;
    for (const events of this.#eventsByJob.values()) {
      total += events.length;
    }

    while (total > this.maxGlobalEvents) {
      let oldestJobId: string | null = null;
      let oldestCreatedAt = Number.POSITIVE_INFINITY;
      for (const [jobId, events] of this.#eventsByJob.entries()) {
        const first = events[0];
        if (!first) {
          this.#eventsByJob.delete(jobId);
          continue;
        }
        const createdAt = Date.parse(first.createdAt);
        const normalizedCreatedAt = Number.isFinite(createdAt) ? createdAt : 0;
        if (normalizedCreatedAt < oldestCreatedAt) {
          oldestCreatedAt = normalizedCreatedAt;
          oldestJobId = jobId;
        }
      }
      if (!oldestJobId) {
        return;
      }
      const oldestEvents = this.#eventsByJob.get(oldestJobId);
      oldestEvents?.shift();
      if (!oldestEvents || oldestEvents.length === 0) {
        this.#eventsByJob.delete(oldestJobId);
      }
      total -= 1;
    }
  }
}

export function createAvailableJobProcessEventCapability(): JobProcessEventEndpointCapability {
  return createJobProcessEventEndpointCapability({
    available: true,
    endpoint: ALEMBIC_JOB_PROCESS_EVENTS_PATH,
  });
}

function createEventId(jobId: string, sequence: number): string {
  const safeJobId = jobId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `${safeJobId}_process_${String(sequence).padStart(4, '0')}`;
}

function cloneEvent(event: JobProcessEvent): JobProcessEvent {
  return {
    ...event,
    artifactRefs: event.artifactRefs.map((artifactRef) => ({ ...artifactRef })),
    content: event.content ? { ...event.content } : null,
    metadata: { ...event.metadata },
  };
}

function numberOrFallback(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
