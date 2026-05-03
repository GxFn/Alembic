import { DIMENSION_REGISTRY } from '#domain/dimension/DimensionRegistry.js';

const DIMENSION_IDS = DIMENSION_REGISTRY.map((dimension) => dimension.id);

export default function migrate(db: import('better-sqlite3').Database) {
  try {
    db.exec(`ALTER TABLE knowledge_entries ADD COLUMN dimensionId TEXT DEFAULT ''`);
  } catch {
    /* column already exists */
  }

  db.exec(`CREATE INDEX IF NOT EXISTS idx_ke3_dimensionId ON knowledge_entries(dimensionId)`);

  const quoted = DIMENSION_IDS.map((id) => `'${id.replace(/'/g, "''")}'`).join(', ');
  db.exec(`
    UPDATE knowledge_entries
    SET dimensionId = CASE
      WHEN category IN (${quoted}) THEN category
      WHEN json_valid(agentNotes) AND json_extract(agentNotes, '$.dimensionId') IN (${quoted})
        THEN json_extract(agentNotes, '$.dimensionId')
      WHEN knowledgeType IN (${quoted}) THEN knowledgeType
      ELSE COALESCE(dimensionId, '')
    END
    WHERE dimensionId IS NULL OR dimensionId = ''
  `);
}
