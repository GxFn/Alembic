export const MAINLINE_DEFAULT_KNOWLEDGE_DIR = "Alembic";
export const MAINLINE_DEFAULT_RUNTIME_DIR = ".asd";
export const MAINLINE_BOX_SPEC_FILENAME = "Alembic.boxspec.json";
export const MAINLINE_DEFAULT_RECIPES_DIR = "Alembic/recipes";

export interface MainlineProjectMarkerSnapshot {
  readonly alembicProject: boolean;
  readonly knowledgeDir?: string;
  readonly runtimeDirPresent: boolean;
  readonly boxspecDir?: string;
}

export function inspectMainlineProjectMarkers(
  entryNames: readonly string[],
): MainlineProjectMarkerSnapshot {
  const entries = new Set(entryNames);
  const boxspecDir = entryNames
    .filter((name) => name.includes("/"))
    .find((name) => name.endsWith(`/${MAINLINE_BOX_SPEC_FILENAME}`))
    ?.split("/")[0];
  const knowledgeDir =
    boxspecDir ??
    (entries.has(MAINLINE_DEFAULT_KNOWLEDGE_DIR) ? MAINLINE_DEFAULT_KNOWLEDGE_DIR : undefined);
  const runtimeDirPresent = entries.has(MAINLINE_DEFAULT_RUNTIME_DIR);
  return {
    alembicProject: Boolean(knowledgeDir || runtimeDirPresent),
    runtimeDirPresent,
    ...(knowledgeDir === undefined ? {} : { knowledgeDir }),
    ...(boxspecDir === undefined ? {} : { boxspecDir }),
  };
}
