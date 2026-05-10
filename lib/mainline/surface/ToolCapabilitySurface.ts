export type MainlineToolCapabilityKind =
  | "internal-tool"
  | "workflow"
  | "terminal-profile"
  | "skill"
  | "mcp-tool"
  | "host-adapter";

export type MainlineToolCapabilitySurface = "runtime" | "mcp" | "skill" | "ide" | "internal";

export interface MainlineToolRiskProfile {
  readonly sideEffect: boolean;
  readonly dataAccess: "none" | "project" | "workspace" | "user-home" | "network" | "secrets";
  readonly writeScope: "none" | "project" | "data-root" | "workspace" | "system";
  readonly network: "none" | "allowlisted" | "open";
  readonly credentialAccess: "none" | "masked" | "scoped-token" | "raw-secret";
  readonly requiresHumanConfirmation: "never" | "on-risk" | "always";
}

export interface MainlineToolExecutionProfile {
  readonly adapter: "internal" | "terminal" | "skill" | "mcp" | "host-adapter" | "workflow";
  readonly timeoutMs: number;
  readonly concurrency: "single" | "parallel-safe" | "exclusive";
  readonly cachePolicy: "none" | "session" | "scope" | "persistent";
}

export interface MainlineToolCapabilityManifest {
  readonly id: string;
  readonly title: string;
  readonly kind: MainlineToolCapabilityKind;
  readonly description: string;
  readonly owner: string;
  readonly lifecycle: "experimental" | "active" | "deprecated" | "disabled";
  readonly surfaces: MainlineToolCapabilitySurface[];
  readonly inputSchema: Record<string, unknown>;
  readonly outputSchema?: Record<string, unknown>;
  readonly risk: MainlineToolRiskProfile;
  readonly execution: MainlineToolExecutionProfile;
}

export interface MainlineToolSchemaProjection {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
}

export function projectMainlineToolSchema(
  manifest: MainlineToolCapabilityManifest,
): MainlineToolSchemaProjection {
  return {
    name: manifest.id,
    description: manifest.description,
    parameters: manifest.inputSchema,
  };
}

export function isMainlineToolCapabilityUsable(
  manifest: MainlineToolCapabilityManifest,
  surface: MainlineToolCapabilitySurface,
): boolean {
  return manifest.lifecycle !== "disabled" && manifest.surfaces.includes(surface);
}
