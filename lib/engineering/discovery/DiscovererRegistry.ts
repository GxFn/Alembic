import type {
  EngineeringDetection,
  EngineeringDiscoverer,
} from "../foundation/EngineeringCoreTypes.js";
import { CustomConfigDiscoverer } from "./CustomConfigDiscoverer.js";
import { DartDiscoverer } from "./DartDiscoverer.js";
import {
  type ConflictResult,
  choosePreferredDiscoverer,
  type DetectMatch,
  detectConflict,
  FilePreferenceStore,
  type PreferenceStore,
} from "./DiscovererPreference.js";
import { GenericDiscoverer } from "./GenericDiscoverer.js";
import { GoDiscoverer } from "./GoDiscoverer.js";
import { JvmDiscoverer } from "./JvmDiscoverer.js";
import { NodeDiscoverer } from "./NodeDiscoverer.js";
import { type EngineeringWorkspaceReader, ProjectDiscoverer } from "./ProjectDiscoverer.js";
import { PythonDiscoverer } from "./PythonDiscoverer.js";
import { RustDiscoverer } from "./RustDiscoverer.js";
import { SpmDiscoverer } from "./SpmDiscoverer.js";

export interface DiscovererRegistryOptions {
  readonly dataRoot?: string;
  readonly preferenceStore?: PreferenceStore;
}

export interface DiscoveryMatch {
  readonly discoverer: EngineeringDiscoverer;
  readonly confidence: number;
  readonly reason: string;
}

export class DiscovererRegistry {
  readonly #discoverers: EngineeringDiscoverer[] = [];
  readonly #options: DiscovererRegistryOptions;

  constructor(options: DiscovererRegistryOptions = {}) {
    this.#options = options;
  }

  register(discoverer: EngineeringDiscoverer): this {
    this.#discoverers.push(discoverer);
    return this;
  }

  async detect(projectRoot: string): Promise<EngineeringDiscoverer> {
    const matched = await this.detectAll(projectRoot);
    const first = matched[0]?.discoverer;
    if (first !== undefined) {
      return first;
    }
    const generic = this.#discoverers.find((discoverer) => discoverer.id === "generic");
    if (generic !== undefined) {
      return generic;
    }
    throw new Error("No discoverer matched and no GenericDiscoverer registered");
  }

  async detectAll(projectRoot: string): Promise<readonly DiscoveryMatch[]> {
    const results = await this.#detectResults(projectRoot);
    const matches = results
      .filter((item) => item.result.match)
      .sort((left, right) => right.result.confidence - left.result.confidence)
      .map((item) => ({
        discoverer: item.discoverer,
        confidence: item.result.confidence,
        reason: item.result.reason,
      }));

    const preferenceStore =
      this.#options.preferenceStore ?? preferenceStoreFromDiscoverers(this.#discoverers);
    const preference = await preferenceStore?.load(this.#options.dataRoot ?? projectRoot);
    const ordered = await choosePreferredDiscoverer(
      matches.map((match) => ({
        discovererId: match.discoverer.id,
        displayName: match.discoverer.displayName,
        confidence: match.confidence,
      })),
      preference ?? null,
    );
    return ordered.flatMap((orderedMatch) => {
      const match = matches.find(
        (candidate) => candidate.discoverer.id === orderedMatch.discovererId,
      );
      return match === undefined ? [] : [match];
    });
  }

  async analyzeConflict(projectRoot: string): Promise<ConflictResult> {
    const matches = (await this.detectAll(projectRoot)).map(
      (match): DetectMatch => ({
        discovererId: match.discoverer.id,
        displayName: match.discoverer.displayName,
        confidence: match.confidence,
      }),
    );
    return detectConflict(matches);
  }

  async selectPreference(
    projectRoot: string,
    discovererId: string,
    userConfirmed = true,
  ): Promise<void> {
    const preferenceStore =
      this.#options.preferenceStore ?? preferenceStoreFromDiscoverers(this.#discoverers);
    if (preferenceStore === undefined) {
      return;
    }
    const alternatives = (await this.detectAll(projectRoot)).map((match) => match.discoverer.id);
    await preferenceStore.save(
      this.#options.dataRoot ?? projectRoot,
      discovererId,
      alternatives,
      userConfirmed,
    );
  }

  getAll(): readonly EngineeringDiscoverer[] {
    return [...this.#discoverers];
  }

  async #detectResults(
    projectRoot: string,
  ): Promise<
    readonly { readonly discoverer: EngineeringDiscoverer; readonly result: EngineeringDetection }[]
  > {
    return Promise.all(
      this.#discoverers.map(async (discoverer) => ({
        discoverer,
        result: await discoverer
          .detect(projectRoot)
          .catch(() => ({ match: false, confidence: 0, reason: "detect error" })),
      })),
    );
  }
}

export function createDefaultDiscovererRegistry(
  reader?: EngineeringWorkspaceReader,
): DiscovererRegistry {
  const options = reader === undefined ? {} : { reader };
  return new DiscovererRegistry()
    .register(new SpmDiscoverer(options))
    .register(new NodeDiscoverer(options))
    .register(new PythonDiscoverer(options))
    .register(new JvmDiscoverer(options))
    .register(new GoDiscoverer(options))
    .register(new DartDiscoverer(options))
    .register(new RustDiscoverer(options))
    .register(new CustomConfigDiscoverer(options))
    .register(new GenericDiscoverer(options));
}

function preferenceStoreFromDiscoverers(
  discoverers: readonly EngineeringDiscoverer[],
): PreferenceStore | undefined {
  const projectDiscoverer = discoverers.find(
    (discoverer): discoverer is ProjectDiscoverer => discoverer instanceof ProjectDiscoverer,
  );
  return projectDiscoverer === undefined
    ? undefined
    : new FilePreferenceStore(projectDiscoverer.workspaceReader);
}
