export type MainlineCapabilityStatus =
  | "available"
  | "degraded"
  | "experimental"
  | "disabled"
  | "unavailable";

export interface MainlineCapability {
  readonly id: string;
  readonly layer:
    | "core"
    | "knowledge"
    | "data"
    | "code"
    | "search"
    | "graph"
    | "compile"
    | "runtime"
    | "agent"
    | "ai"
    | "surface"
    | "legacy";
  readonly status: MainlineCapabilityStatus;
  readonly reason?: string;
  readonly metadata?: Record<string, unknown>;
}

/**
 * MainlineCapabilityRegistry 是新主线的共享能力目录。
 * 它替代“到处 try/catch 探测模块”的写法，让上层能先判断能力再决定是否进入重路径。
 */
export class MainlineCapabilityRegistry {
  readonly #capabilities = new Map<string, MainlineCapability>();

  set(capability: MainlineCapability): void {
    this.#capabilities.set(capability.id, cloneCapability(capability));
  }

  get(id: string): MainlineCapability | undefined {
    const capability = this.#capabilities.get(id);
    return capability ? cloneCapability(capability) : undefined;
  }

  list(): MainlineCapability[] {
    return [...this.#capabilities.values()]
      .map((capability) => cloneCapability(capability))
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  assertAvailable(id: string): MainlineCapability {
    const capability = this.get(id);
    if (!capability) {
      throw new Error(`Mainline capability not registered: ${id}`);
    }
    if (capability.status !== "available") {
      throw new Error(`Mainline capability unavailable: ${id}${formatReason(capability.reason)}`);
    }
    return capability;
  }
}

function formatReason(reason: string | undefined): string {
  return reason ? ` (${reason})` : "";
}

function cloneCapability(capability: MainlineCapability): MainlineCapability {
  return {
    ...capability,
    ...(capability.metadata ? { metadata: { ...capability.metadata } } : {}),
  };
}
