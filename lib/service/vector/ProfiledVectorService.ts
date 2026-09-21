/** 查询前的本地索引门禁；不把模型空间迁移误计为 embedding 服务熔断失败。 */
import Logger from '@alembic/core/logging';
import { VectorService } from '@alembic/core/vector';

type Options = ConstructorParameters<typeof VectorService>[0];
type ProfileFailure = 'embedding-profile-migration-required' | 'vector-store-unavailable';

export class ProfiledVectorService extends VectorService {
  readonly #hybrid: Options['hybridRetriever'];
  readonly #configured: boolean;

  constructor(
    options: Options,
    private readonly assertProfile: () => Promise<void>
  ) {
    super(options);
    this.#hybrid = options.hybridRetriever;
    this.#configured = !!options.embedProvider;
  }

  override async search(
    query: string,
    options: NonNullable<Parameters<VectorService['search']>[1]> = {}
  ): ReturnType<VectorService['search']> {
    if (this.#configured && (await this.#profileFailure())) {
      return [];
    }
    return super.search(query, options);
  }

  override async hybridSearch(
    query: string,
    options: NonNullable<Parameters<VectorService['hybridSearch']>[1]> = {}
  ): ReturnType<VectorService['hybridSearch']> {
    const fallbackReason = this.#configured ? await this.#profileFailure() : null;
    if (!fallbackReason) {
      return super.hybridSearch(query, options);
    }
    if (!this.#hybrid) {
      return [];
    }
    const hits = await this.#hybrid.search(query, null, {
      ...options,
      sparseSearchFn: options.sparseSearchFn ?? undefined,
    });
    return hits.map((hit) => ({
      ...hit,
      id: String(hit.id ?? ''),
      score: Number(hit.score) || 0,
      vectorUsed: false,
      semanticUsed: false,
      fallbackReason,
    }));
  }

  async #profileFailure(): Promise<ProfileFailure | null> {
    try {
      await this.assertProfile();
      return null;
    } catch (err: unknown) {
      // 本地索引不可读与模型空间变更分开报告；二者都不应给远端服务累计失败。
      const reason =
        err instanceof Error && 'code' in err && err.code === 'EMBEDDING_PROFILE_MIGRATION_REQUIRED'
          ? 'embedding-profile-migration-required'
          : 'vector-store-unavailable';
      Logger.getInstance().warn('[vector] dense profile unavailable; sparse retrieval only', {
        reason,
      });
      return reason;
    }
  }
}
