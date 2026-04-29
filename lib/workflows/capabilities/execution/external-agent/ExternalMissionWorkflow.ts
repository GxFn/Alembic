import path from 'node:path';
import type {
  DimensionDef,
  MissionBriefingResult,
  ProjectSnapshot,
} from '#types/project-snapshot.js';
import { toSessionCache } from '#types/snapshot-views.js';
import { buildMissionBriefing } from '#workflows/capabilities/execution/external-agent/mission-briefing/MissionBriefingBuilder.js';
import type {
  BriefingProfile,
  RescanBriefingInput,
} from '#workflows/capabilities/execution/external-agent/mission-briefing/MissionBriefingProfiles.js';
import { getOrCreateSessionManager } from '#workflows/capabilities/execution/external-agent/session/WorkflowSessionManagerProvider.js';
import { buildLanguageExtension } from '#workflows/capabilities/presentation/LanguageExtensionBuilder.js';

export type ExternalSessionContainer = Parameters<typeof getOrCreateSessionManager>[0];
export type ExternalWorkflowSession = ReturnType<
  ReturnType<typeof getOrCreateSessionManager>['createSession']
>;
export type ExternalMissionBriefingInput = Parameters<typeof buildMissionBriefing>[0];
export type ExternalMissionBriefingResult = MissionBriefingResult;

export function createExternalWorkflowSession(opts: {
  container: ExternalSessionContainer;
  projectRoot: string;
  dimensions: DimensionDef[];
  snapshot: ProjectSnapshot;
  primaryLang: string | null;
  fileCount: number;
  moduleCount: number;
}): ExternalWorkflowSession {
  const sessionManager = getOrCreateSessionManager(opts.container);
  const session = sessionManager.createSession({
    projectRoot: opts.projectRoot,
    dimensions: opts.dimensions,
    projectContext: {
      projectName: path.basename(opts.projectRoot),
      primaryLang: opts.primaryLang,
      fileCount: opts.fileCount,
      modules: opts.moduleCount,
    },
  });
  session.setSnapshotCache(toSessionCache(opts.snapshot));
  return session;
}

export function buildExternalMissionBriefing(opts: {
  projectRoot: string;
  primaryLang: string | null;
  secondaryLanguages?: string[];
  isMultiLang?: boolean;
  fileCount: number;
  projectType: string;
  profile?: BriefingProfile;
  rescan?: RescanBriefingInput;
  briefing: Omit<
    ExternalMissionBriefingInput,
    'projectMeta' | 'languageExtension' | 'profile' | 'rescan'
  >;
}): MissionBriefingResult {
  const projectMeta = {
    name: path.basename(opts.projectRoot),
    primaryLanguage: opts.primaryLang,
    secondaryLanguages: opts.secondaryLanguages || [],
    isMultiLang: opts.isMultiLang || false,
    fileCount: opts.fileCount,
    projectType: opts.projectType,
    projectRoot: opts.projectRoot,
  };

  return buildMissionBriefing({
    ...opts.briefing,
    profile: opts.profile,
    rescan: opts.rescan,
    projectMeta,
    languageExtension: buildLanguageExtension(opts.primaryLang),
  }) as MissionBriefingResult;
}

export function getActiveExternalWorkflowSession(
  container: ExternalSessionContainer,
  sessionId?: string
): ExternalWorkflowSession | null {
  const sessionManager = getOrCreateSessionManager(container);
  const session = sessionManager.getSession(sessionId);
  if (session) {
    return session;
  }

  if (sessionId) {
    const anySession = sessionManager.getAnySession();
    if (anySession && anySession.id === sessionId) {
      return anySession;
    }
  }

  return null;
}
