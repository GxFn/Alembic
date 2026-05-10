export interface MainlineMcpToolDeclaration {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: Record<string, unknown>;
  readonly serverId: string;
  readonly serverSource: "workspace-config" | "plugin-manifest";
}

export interface MainlineSkillManifest {
  readonly name: string;
  readonly description: string;
  readonly triggers: string[];
  readonly resources?: string[];
}

export interface MainlineSkillValidation {
  readonly ok: boolean;
  readonly issues: string[];
}

interface MainlineMcpConfigServer {
  readonly tools?: readonly unknown[];
}

interface MainlineMcpConfig {
  readonly servers?: Record<string, MainlineMcpConfigServer>;
  readonly mcpServers?: Record<string, MainlineMcpConfigServer>;
}

export function extractMainlineMcpToolDeclarations(
  config: unknown,
  serverSource: MainlineMcpToolDeclaration["serverSource"] = "workspace-config",
): MainlineMcpToolDeclaration[] {
  const parsed = isObject(config) ? (config as MainlineMcpConfig) : {};
  const servers = parsed.servers ?? parsed.mcpServers ?? {};
  const declarations: MainlineMcpToolDeclaration[] = [];

  for (const [serverId, serverConfig] of Object.entries(servers)) {
    for (const tool of Array.isArray(serverConfig.tools) ? serverConfig.tools : []) {
      if (!isObject(tool) || typeof tool.name !== "string" || tool.name.trim() === "") {
        continue;
      }
      declarations.push({
        name: tool.name,
        ...(typeof tool.description === "string" ? { description: tool.description } : {}),
        ...(isObject(tool.inputSchema)
          ? { inputSchema: tool.inputSchema as Record<string, unknown> }
          : {}),
        serverId,
        serverSource,
      });
    }
  }

  return declarations;
}

export function validateMainlineSkillManifest(
  manifest: Partial<MainlineSkillManifest>,
): MainlineSkillValidation {
  const issues: string[] = [];
  if (!manifest.name || manifest.name.trim().length === 0) {
    issues.push("Skill manifest requires a non-empty name.");
  }
  if (!manifest.description || manifest.description.trim().length < 12) {
    issues.push("Skill manifest requires a useful description.");
  }
  if (!Array.isArray(manifest.triggers) || manifest.triggers.length === 0) {
    issues.push("Skill manifest should declare at least one trigger.");
  }
  return { ok: issues.length === 0, issues };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
