import path from "node:path";
import type { EngineeringWorkspaceReader } from "./ProjectDiscoverer.js";

export interface DiscovererPreferenceData {
  readonly selectedDiscoverer: string;
  readonly selectedAt: string;
  readonly alternatives: readonly string[];
  readonly userConfirmed: boolean;
}

export interface DetectMatch {
  readonly discovererId: string;
  readonly displayName: string;
  readonly confidence: number;
}

export interface ConflictResult {
  readonly ambiguous: boolean;
  readonly reason?: string;
  readonly matches: readonly DetectMatch[];
  readonly recommended?: DetectMatch;
}

export interface PreferenceStore {
  load(dataRoot: string): Promise<DiscovererPreferenceData | null>;
  save(
    dataRoot: string,
    discovererId: string,
    alternatives: readonly string[],
    userConfirmed: boolean,
  ): Promise<void>;
}

const PREFERENCE_FILE = "discoverer-preference.json";
const AMBIGUITY_THRESHOLD = 0.1;
const HEURISTIC_UNCERTAIN_THRESHOLD = 0.6;

export function detectConflict(matches: readonly DetectMatch[]): ConflictResult {
  if (matches.length === 0) {
    return { ambiguous: false, matches };
  }
  const top = matches[0];
  if (top === undefined || matches.length === 1) {
    return { ambiguous: false, matches, ...(top === undefined ? {} : { recommended: top }) };
  }
  const second = matches[1];
  if (second === undefined) {
    return { ambiguous: false, matches, recommended: top };
  }

  const highConfidenceCount = matches.filter((match) => match.confidence >= 0.6).length;
  const closeDelta = top.confidence - second.confidence < AMBIGUITY_THRESHOLD;
  const heuristicOnly = top.confidence < HEURISTIC_UNCERTAIN_THRESHOLD;

  if (highConfidenceCount >= 2 && closeDelta) {
    return {
      ambiguous: true,
      reason: `Multiple build systems detected with similar confidence (${top.displayName}: ${top.confidence.toFixed(2)} vs ${second.displayName}: ${second.confidence.toFixed(2)})`,
      matches,
      recommended: top,
    };
  }

  if (heuristicOnly) {
    return {
      ambiguous: true,
      reason: `No definitive build system identified (highest: ${top.displayName} at ${top.confidence.toFixed(2)})`,
      matches,
      recommended: top,
    };
  }

  return { ambiguous: false, matches, recommended: top };
}

export async function choosePreferredDiscoverer(
  matches: readonly DetectMatch[],
  preference: DiscovererPreferenceData | null,
): Promise<readonly DetectMatch[]> {
  if (preference?.userConfirmed !== true) {
    return matches;
  }
  const index = matches.findIndex((match) => match.discovererId === preference.selectedDiscoverer);
  if (index <= 0) {
    return matches;
  }
  const ordered = [...matches];
  const [preferred] = ordered.splice(index, 1);
  return preferred === undefined ? matches : [preferred, ...ordered];
}

export class FilePreferenceStore implements PreferenceStore {
  constructor(private readonly reader: EngineeringWorkspaceReader) {}

  async load(dataRoot: string): Promise<DiscovererPreferenceData | null> {
    const prefPath = path.join(dataRoot, ".asd", PREFERENCE_FILE);
    if (!(await this.reader.exists(prefPath))) {
      return null;
    }
    try {
      const parsed: unknown = JSON.parse(await this.reader.readText(prefPath));
      if (!isPreferenceData(parsed)) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  async save(
    dataRoot: string,
    discovererId: string,
    alternatives: readonly string[],
    userConfirmed: boolean,
  ): Promise<void> {
    const fs = await import("node:fs/promises");
    const prefDir = path.join(dataRoot, ".asd");
    await fs.mkdir(prefDir, { recursive: true });
    const data: DiscovererPreferenceData = {
      selectedDiscoverer: discovererId,
      selectedAt: new Date().toISOString(),
      alternatives,
      userConfirmed,
    };
    await fs.writeFile(path.join(prefDir, PREFERENCE_FILE), `${JSON.stringify(data, null, 2)}\n`);
  }
}

function isPreferenceData(value: unknown): value is DiscovererPreferenceData {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { selectedDiscoverer?: unknown }).selectedDiscoverer === "string" &&
    typeof (value as { selectedAt?: unknown }).selectedAt === "string" &&
    Array.isArray((value as { alternatives?: unknown }).alternatives) &&
    typeof (value as { userConfirmed?: unknown }).userConfirmed === "boolean"
  );
}
