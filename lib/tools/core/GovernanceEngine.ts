import { validateToolInputV2 } from '#tools/core/SchemaValidator.js';
import type { ToolServiceLocator } from '#tools/core/ToolCallContext.js';
import type { ToolCallRequest } from '#tools/core/ToolContracts.js';
import {
  allowToolDecision,
  denyToolDecision,
  type ToolDecision,
} from '#tools/core/ToolDecision.js';
import type { ToolCapabilityManifest } from '../catalog/CapabilityManifest.js';

export interface GovernanceEngineOptions {
  failClosedForSideEffectsWithoutApproval?: boolean;
}

export interface GovernanceDecisionRuntime {
  services?: ToolServiceLocator | null;
}

interface GatewayCheckOnlyLike {
  checkOnly(request: {
    actor: string;
    action: string;
    resource?: string;
    data?: Record<string, unknown>;
    session?: string;
  }): Promise<{
    success: boolean;
    requestId?: string;
    error?: { message?: string; code?: string; statusCode?: number };
  }>;
}

export class GovernanceEngine {
  #failClosedForSideEffectsWithoutApproval: boolean;

  constructor(options: GovernanceEngineOptions = {}) {
    this.#failClosedForSideEffectsWithoutApproval =
      options.failClosedForSideEffectsWithoutApproval ?? true;
  }

  async decide(
    request: ToolCallRequest,
    manifest: ToolCapabilityManifest | null,
    runtime: GovernanceDecisionRuntime = {}
  ): Promise<ToolDecision> {
    const discover = this.#discover(request, manifest);
    if (!discover.allowed || !manifest) {
      return discover;
    }

    const plan = await this.#plan(request, manifest);
    if (!plan.allowed) {
      return plan;
    }

    const approve = await this.#approve(request, manifest, runtime);
    if (!approve.allowed || approve.requiresConfirmation) {
      return approve;
    }

    const execute = this.#execute(request);
    if (!execute.allowed) {
      return execute;
    }

    return allowToolDecision('execute', {
      auditLevel: manifest.governance.auditLevel,
      policyProfile: manifest.governance.policyProfile,
      requestId: approve.requestId,
    });
  }

  #discover(request: ToolCallRequest, manifest: ToolCapabilityManifest | null): ToolDecision {
    if (!manifest) {
      return denyToolDecision('discover', `Capability '${request.toolId}' not found`);
    }
    if (manifest.lifecycle === 'disabled') {
      return denyToolDecision('discover', `Capability '${request.toolId}' is disabled`);
    }
    if (request.surface === 'composer') {
      if (!manifest.governance.allowInComposer) {
        return denyToolDecision('discover', `Capability '${request.toolId}' is not composable`);
      }
      return allowToolDecision('discover');
    }
    if (request.surface === 'system') {
      if (!manifest.surfaces.includes('runtime') && !manifest.surfaces.includes('internal')) {
        return denyToolDecision(
          'discover',
          `Capability '${request.toolId}' is not exposed on system`
        );
      }
      return allowToolDecision('discover');
    }
    if (!manifest.surfaces.includes(request.surface)) {
      return denyToolDecision(
        'discover',
        `Capability '${request.toolId}' is not exposed on ${request.surface}`
      );
    }
    return allowToolDecision('discover');
  }

  async #plan(request: ToolCallRequest, manifest: ToolCapabilityManifest): Promise<ToolDecision> {
    if (!manifest.inputSchema || typeof manifest.inputSchema !== 'object') {
      return denyToolDecision('plan', `Capability '${manifest.id}' has no input schema`);
    }

    const v2Result = await validateToolInputV2(
      request.args,
      manifest.inputSchema as Record<string, unknown>,
      manifest.id
    );
    if (!v2Result.valid) {
      return denyToolDecision(
        'plan',
        `Capability '${manifest.id}' input validation failed: ${v2Result.errors.join('; ')}`
      );
    }
    return allowToolDecision('plan');
  }

  async #approve(
    request: ToolCallRequest,
    manifest: ToolCapabilityManifest,
    runtime: GovernanceDecisionRuntime
  ): Promise<ToolDecision> {
    const roleDecision = this.#approveRole(request, manifest);
    if (!roleDecision.allowed) {
      return roleDecision;
    }

    const runtimePolicyDecision = this.#approveRuntimePolicy(request);
    if (!runtimePolicyDecision.allowed) {
      return runtimePolicyDecision;
    }

    if (
      this.#failClosedForSideEffectsWithoutApproval &&
      manifest.risk.sideEffect &&
      !manifest.governance.gatewayAction &&
      manifest.governance.approvalPolicy === 'auto'
    ) {
      return denyToolDecision(
        'approve',
        `Capability '${manifest.id}' is side-effecting but has no approval policy`
      );
    }

    if (manifest.governance.approvalPolicy === 'confirm-every-time') {
      if (isBootstrapTerminalTestRequest(request)) {
        return allowToolDecision('approve', {
          policyProfile: manifest.governance.policyProfile,
          auditLevel: manifest.governance.auditLevel,
        });
      }
      return allowToolDecision('approve', {
        requiresConfirmation: true,
        confirmationMessage: `Confirm execution of ${manifest.id}`,
      });
    }

    const gatewayDecision = await this.#approveGateway(request, manifest, runtime);
    if (!gatewayDecision.allowed) {
      return gatewayDecision;
    }

    return allowToolDecision('approve');
  }

  #execute(request: ToolCallRequest): ToolDecision {
    if (request.abortSignal?.aborted) {
      return denyToolDecision('execute', 'Tool execution aborted before start', {
        resultStatus: 'aborted',
      });
    }
    return allowToolDecision('execute');
  }

  #approveRuntimePolicy(request: ToolCallRequest): ToolDecision {
    const policyValidator = request.runtime?.policyValidator;
    if (!policyValidator) {
      return allowToolDecision('approve');
    }

    try {
      const result = policyValidator.validateToolCall(request.toolId, request.args);
      if (result.ok) {
        return allowToolDecision('approve');
      }
      return denyToolDecision(
        'approve',
        result.reason || `Runtime policy denied capability '${request.toolId}'`
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return denyToolDecision('approve', `Runtime policy validation failed: ${message}`);
    }
  }

  #approveRole(request: ToolCallRequest, manifest: ToolCapabilityManifest): ToolDecision {
    if (!['http', 'mcp', 'dashboard'].includes(request.surface)) {
      return allowToolDecision('approve');
    }

    const allowedRoles = manifest.governance.allowedRoles || [];
    if (allowedRoles.length === 0) {
      return allowToolDecision('approve');
    }

    const role = request.actor.role || 'anonymous';
    if (
      allowedRoles.includes(role) ||
      (role === 'external_agent' && allowedRoles.includes('agent'))
    ) {
      return allowToolDecision('approve');
    }

    return denyToolDecision(
      'approve',
      `Role '${role}' is not allowed to execute capability '${manifest.id}'`
    );
  }

  async #approveGateway(
    request: ToolCallRequest,
    manifest: ToolCapabilityManifest,
    runtime: GovernanceDecisionRuntime
  ): Promise<ToolDecision> {
    const action = request.governance?.gatewayAction ?? manifest.governance.gatewayAction;
    if (!action || action.startsWith('dynamic:')) {
      return allowToolDecision('approve');
    }

    const gateway = getOptionalService<GatewayCheckOnlyLike>(runtime.services, 'gateway');
    if (!gateway?.checkOnly) {
      return allowToolDecision('approve');
    }

    const result = await gateway.checkOnly({
      actor: request.actor.role || request.actor.user || 'anonymous',
      action,
      resource:
        request.governance?.gatewayResource || manifest.governance.gatewayResource || 'agent_tools',
      data: request.governance?.gatewayData || {
        tool: request.toolId,
        args: request.args,
        surface: request.surface,
        source: request.source.name,
        _resolvedUser: request.actor.user,
      },
      session: request.actor.sessionId,
    });

    if (result.success) {
      return allowToolDecision('approve', { requestId: result.requestId });
    }

    return denyToolDecision(
      'approve',
      result.error?.message || `Gateway denied capability '${manifest.id}'`,
      { requestId: result.requestId }
    );
  }
}

function isBootstrapTerminalTestRequest(request: ToolCallRequest) {
  if (request.surface !== 'runtime' || request.runtime?.terminalTest !== true) {
    return false;
  }
  const modes = new Set(request.runtime.allowedTerminalModes || []);
  if (request.toolId === 'terminal_run') {
    return modes.has('run');
  }
  if (request.toolId === 'terminal_shell') {
    return modes.has('shell');
  }
  if (request.toolId === 'terminal_pty') {
    return modes.has('pty');
  }
  return false;
}

function getOptionalService<T>(
  services: ToolServiceLocator | null | undefined,
  name: string
): T | null {
  try {
    return (services?.get?.(name) as T | undefined) || null;
  } catch {
    return null;
  }
}

export default GovernanceEngine;
