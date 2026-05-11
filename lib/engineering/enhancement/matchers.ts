/**
 * Enhancement Pack 匹配信号。
 *
 * 真实能力在 packs/* 的成熟实现里；这里仅保留工程扫描阶段需要的识别线索，
 * 用于从 tech stack、import、路径和 panorama role 中决定哪些 pack 参与本次扫描。
 */

export interface EngineeringEnhancementPackMatcher {
  readonly aliases: readonly string[];
  readonly fileHints: readonly RegExp[];
  readonly roleHints: readonly RegExp[];
}

const MATCHERS: Readonly<Record<string, EngineeringEnhancementPackMatcher>> = {
  react: matcher({
    aliases: ["react", "react-dom", "jsx", "tsx", "zustand", "jotai", "@reduxjs"],
    fileHints: [/\.tsx$/, /(^|\/)components?\//, /(^|\/)hooks?\//],
    roleHints: [/front.?end/i, /ui/i, /component/i],
  }),
  nextjs: matcher({
    aliases: ["next", "nextjs", "next/navigation", "next/server", "app-router"],
    fileHints: [/next\.config\.[cm]?[jt]s$/, /(^|\/)app\/.*(page|layout|route)\.[jt]sx?$/],
    roleHints: [/front.?end/i, /web/i],
  }),
  vue: matcher({
    aliases: ["vue", "nuxt", "pinia", "@vue", "vue-router"],
    fileHints: [/\.vue$/, /nuxt\.config\.[jt]s$/, /(^|\/)composables?\//],
    roleHints: [/front.?end/i, /ui/i],
  }),
  "node-server": matcher({
    aliases: ["express", "fastify", "@nestjs", "koa", "hono", "node:http", "zod", "joi"],
    fileHints: [/server\.[cm]?[jt]s$/, /(^|\/)(routes?|controllers?|middleware)\//],
    roleHints: [/server/i, /api/i, /backend/i],
  }),
  django: matcher({
    aliases: ["django", "rest_framework", "celery", "channels"],
    fileHints: [/(^|\/)(models|views|serializers|admin)\.py$/, /manage\.py$/],
    roleHints: [/backend/i, /api/i],
  }),
  fastapi: matcher({
    aliases: ["fastapi", "pydantic", "sqlalchemy", "uvicorn", "starlette"],
    fileHints: [/(^|\/)(routers?|api|schemas|deps)\//, /main\.py$/],
    roleHints: [/backend/i, /api/i],
  }),
  spring: matcher({
    aliases: ["spring", "spring-boot", "springframework", "jakarta"],
    fileHints: [/(^|\/)src\/main\/java\//, /pom\.xml$/, /build\.gradle/],
    roleHints: [/backend/i, /api/i],
  }),
  android: matcher({
    aliases: ["android", "jetpack", "compose", "gradle", "androidx"],
    fileHints: [/AndroidManifest\.xml$/, /(^|\/)app\/src\/main\//, /\.kt$/],
    roleHints: [/mobile/i, /android/i],
  }),
  "rust-web": matcher({
    aliases: ["axum", "actix", "rocket", "warp", "tower", "hyper"],
    fileHints: [/Cargo\.toml$/, /(^|\/)src\/(main|lib)\.rs$/],
    roleHints: [/backend/i, /api/i],
  }),
  "rust-tokio": matcher({
    aliases: ["tokio", "async-std", "futures", "mpsc", "oneshot"],
    fileHints: [/Cargo\.toml$/, /\.rs$/],
    roleHints: [/runtime/i, /concurrency/i, /backend/i],
  }),
  "go-web": matcher({
    aliases: ["gin", "echo", "fiber", "chi", "net/http", "gorilla/mux"],
    fileHints: [/go\.mod$/, /(^|\/)(handlers?|routes?|middleware)\//],
    roleHints: [/backend/i, /api/i],
  }),
  "go-grpc": matcher({
    aliases: ["google.golang.org/grpc", "grpc", "protobuf", "proto"],
    fileHints: [/\.proto$/, /go\.mod$/, /(^|\/)proto\//],
    roleHints: [/service/i, /rpc/i],
  }),
  "python-ml": matcher({
    aliases: ["torch", "tensorflow", "sklearn", "pandas", "numpy", "mlflow", "transformers"],
    fileHints: [/(^|\/)(models?|training|notebooks?|features?)\//, /\.ipynb$/],
    roleHints: [/ml/i, /model/i, /data/i],
  }),
  "python-langchain": matcher({
    aliases: ["langchain", "langgraph", "llama_index", "openai", "chromadb", "faiss"],
    fileHints: [/(^|\/)(agents?|chains?|prompts?|retrievers?)\//],
    roleHints: [/agent/i, /rag/i, /llm/i],
  }),
};

export function getEngineeringEnhancementPackMatcher(
  packId: string,
): EngineeringEnhancementPackMatcher {
  return MATCHERS[packId] ?? matcher({ aliases: [], fileHints: [], roleHints: [] });
}

function matcher(input: EngineeringEnhancementPackMatcher): EngineeringEnhancementPackMatcher {
  return input;
}
