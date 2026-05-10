import type { ToolCompressionMeta, ToolCompressionOptions, ToolResultEnvelope } from "./types.js";

const DEFAULT_COMPRESSION: Required<ToolCompressionOptions> = {
  maxDepth: 6,
  maxArrayItems: 25,
  maxStringLength: 2_000,
};

interface CompressionState {
  readonly options: Required<ToolCompressionOptions>;
  truncatedArrays: number;
  truncatedStrings: number;
  truncatedObjects: number;
}

export class ToolOutputCompressor {
  readonly #defaults: Required<ToolCompressionOptions>;

  constructor(defaults: ToolCompressionOptions = {}) {
    this.#defaults = { ...DEFAULT_COMPRESSION, ...definedOptions(defaults) };
  }

  compressEnvelope(
    envelope: ToolResultEnvelope,
    options: ToolCompressionOptions = {},
  ): ToolResultEnvelope {
    const state: CompressionState = {
      options: { ...this.#defaults, ...definedOptions(options) },
      truncatedArrays: 0,
      truncatedStrings: 0,
      truncatedObjects: 0,
    };
    const compressedEnvelope = compressValue(envelope, state, 0) as ToolResultEnvelope;
    const meta = compressionMeta(state);
    if (!meta.applied) {
      return compressedEnvelope;
    }
    return {
      ...compressedEnvelope,
      meta: {
        ...compressedEnvelope.meta,
        compression: meta,
      },
    };
  }
}

export function compressToolEnvelope(
  envelope: ToolResultEnvelope,
  options?: ToolCompressionOptions,
): ToolResultEnvelope {
  return new ToolOutputCompressor().compressEnvelope(envelope, options);
}

function compressValue(value: unknown, state: CompressionState, depth: number): unknown {
  if (typeof value === "string") {
    if (value.length <= state.options.maxStringLength) {
      return value;
    }
    state.truncatedStrings += 1;
    return `${value.slice(0, state.options.maxStringLength)}...`;
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  if (depth >= state.options.maxDepth) {
    state.truncatedObjects += 1;
    return "[compressed:max-depth]";
  }

  if (Array.isArray(value)) {
    const visible = value
      .slice(0, state.options.maxArrayItems)
      .map((item) => compressValue(item, state, depth + 1));
    if (value.length > state.options.maxArrayItems) {
      state.truncatedArrays += 1;
      visible.push({
        omitted: value.length - state.options.maxArrayItems,
        reason: "compressed:max-array-items",
      });
    }
    return visible;
  }

  const output: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    output[key] = compressValue(nested, state, depth + 1);
  }
  return output;
}

function compressionMeta(state: CompressionState): ToolCompressionMeta {
  return {
    ...state.options,
    applied: state.truncatedArrays > 0 || state.truncatedStrings > 0 || state.truncatedObjects > 0,
    truncatedArrays: state.truncatedArrays,
    truncatedStrings: state.truncatedStrings,
    truncatedObjects: state.truncatedObjects,
  };
}

function definedOptions(options: ToolCompressionOptions): ToolCompressionOptions {
  return {
    ...(options.maxDepth === undefined ? {} : { maxDepth: options.maxDepth }),
    ...(options.maxArrayItems === undefined ? {} : { maxArrayItems: options.maxArrayItems }),
    ...(options.maxStringLength === undefined ? {} : { maxStringLength: options.maxStringLength }),
  };
}
