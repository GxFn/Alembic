import type { AlembicMcpHarness } from './McpHarness.js';
import type { CodexSessionScenario } from './ScenarioTypes.js';
import type { TranscriptWriter } from './TranscriptWriter.js';

interface PendingAiConfig {
  apiKey: string;
  provider: string;
}

export class CodexScenarioAgentSimulator {
  readonly harness: AlembicMcpHarness;
  readonly projectRoot: string;
  readonly scenario: CodexSessionScenario;
  readonly transcript: TranscriptWriter;
  #lastAssistant = '';
  #pendingAiConfig: PendingAiConfig | null = null;
  #statusChecked = false;

  constructor(options: {
    harness: AlembicMcpHarness;
    projectRoot: string;
    scenario: CodexSessionScenario;
    transcript: TranscriptWriter;
  }) {
    this.harness = options.harness;
    this.projectRoot = options.projectRoot;
    this.scenario = options.scenario;
    this.transcript = options.transcript;
  }

  get finalAssistantText(): string {
    return this.#lastAssistant;
  }

  async runTurn(turn: number, userText: string): Promise<void> {
    this.transcript.record({ text: userText, turn, type: 'user.message' });
    const projectRootArgs = this.#projectRootArgs();
    if (!this.#statusChecked) {
      const status = await this.harness.callTool(turn, 'alembic_codex_status', projectRootArgs);
      this.#statusChecked = true;
      if (this.#projectRootMissing(status)) {
        this.#reply(
          turn,
          'Alembic 需要目标项目的绝对 projectRoot。当前 Codex 插件没有拿到可信项目目录，请提供项目根目录后再继续。'
        );
        return;
      }
    }

    const pendingReply = await this.#maybeHandlePendingAiConfirmation(
      turn,
      userText,
      projectRootArgs
    );
    if (pendingReply) {
      return;
    }

    const aiConfig = this.#parseAiConfig(userText);
    if (aiConfig) {
      this.#pendingAiConfig = aiConfig;
      this.#reply(
        turn,
        '检测到你提供了 AI Provider 和 API key。为了避免误把 secret 通过工具调用保存，请明确确认允许 Alembic Codex 保存这个 key。'
      );
      return;
    }

    if (this.#asksForInit(userText)) {
      const result = await this.harness.callTool(turn, 'alembic_codex_init', {
        ...projectRootArgs,
        ...(this.scenario.fixture.initArgs || {}),
      });
      if (isSuccess(result)) {
        this.#reply(
          turn,
          'Alembic Codex 初始化已完成。这里只完成工作区初始化，还没有开始知识挖掘。'
        );
      } else {
        this.#reply(turn, 'Alembic Codex 初始化没有完成，请查看工具返回的诊断信息后重试。');
      }
      return;
    }

    if (this.#asksForBootstrap(userText)) {
      const result = await this.harness.callTool(turn, 'alembic_codex_bootstrap', {
        ...projectRootArgs,
        ...(this.scenario.fixture.bootstrapArgs || {}),
      });
      const errorCode = extractErrorCode(result);
      if (errorCode === 'AI_PROVIDER_REQUIRED') {
        this.#reply(
          turn,
          '知识挖掘没有启动。Alembic internal bootstrap 需要先配置真实 AI Provider 和 API key，可以使用 alembic_codex_ai_config 配置，或改走外部 Agent 路线。'
        );
        return;
      }
      if (isSuccess(result)) {
        this.#reply(turn, 'Alembic 知识挖掘任务已入队，可以通过 alembic_codex_job 查询进度。');
      } else {
        this.#reply(turn, 'Alembic 知识挖掘没有启动，请查看工具返回的错误信息。');
      }
      return;
    }

    this.#reply(turn, '我已经检查 Alembic Codex 状态。请说明要初始化、配置 AI，还是开始知识挖掘。');
  }

  #projectRootArgs(): Record<string, unknown> {
    return this.scenario.fixture.projectRoot === 'explicit'
      ? { projectRoot: this.projectRoot }
      : {};
  }

  async #maybeHandlePendingAiConfirmation(
    turn: number,
    userText: string,
    projectRootArgs: Record<string, unknown>
  ): Promise<boolean> {
    if (!this.#pendingAiConfig || !/确认|允许|同意|approve|confirm/i.test(userText)) {
      return false;
    }
    const pending = this.#pendingAiConfig;
    this.#pendingAiConfig = null;
    const result = await this.harness.callTool(turn, 'alembic_codex_ai_config', {
      ...projectRootArgs,
      apiKey: pending.apiKey,
      confirmChatSecret: true,
      mode: 'configure',
      provider: pending.provider,
    });
    if (isSuccess(result)) {
      this.#reply(
        turn,
        'AI Provider 已配置完成，返回结果已脱敏。现在可以继续启动 Alembic 知识挖掘。'
      );
    } else {
      this.#reply(turn, 'AI Provider 配置没有完成，请查看工具返回的错误信息。');
    }
    return true;
  }

  #parseAiConfig(userText: string): PendingAiConfig | null {
    const provider = /deepseek/i.test(userText) ? 'deepseek' : '';
    const key = userText.match(/\bscenario-secret-[A-Za-z0-9_-]+\b/)?.[0] || '';
    if (!provider || !key) {
      return null;
    }
    return { apiKey: key, provider };
  }

  #projectRootMissing(status: unknown): boolean {
    if (this.scenario.fixture.projectRoot !== 'missing') {
      return false;
    }
    const resolution = ((status as { data?: Record<string, unknown> })?.data
      ?.projectRootResolution || {}) as Record<string, unknown>;
    return resolution.trust !== 'trusted';
  }

  #asksForBootstrap(userText: string): boolean {
    return /bootstrap|知识挖掘|挖掘|扫描|冷启动/.test(userText);
  }

  #asksForInit(userText: string): boolean {
    return /初始化|init/i.test(userText) && !this.#asksForBootstrap(userText);
  }

  #reply(turn: number, text: string): void {
    this.#lastAssistant = text;
    this.transcript.record({ text, turn, type: 'assistant.final' });
  }
}

function extractErrorCode(result: unknown): string {
  if (!result || typeof result !== 'object') {
    return '';
  }
  const data = (result as { data?: unknown }).data;
  if (
    data &&
    typeof data === 'object' &&
    typeof (data as { errorCode?: unknown }).errorCode === 'string'
  ) {
    return (data as { errorCode: string }).errorCode;
  }
  return '';
}

function isSuccess(result: unknown): boolean {
  return Boolean(
    result && typeof result === 'object' && (result as { success?: unknown }).success === true
  );
}
