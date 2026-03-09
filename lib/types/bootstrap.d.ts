/** Bootstrap 类型声明 */

interface DimensionDigest {
  dimId: string;
  label: string;
  status: string;
  candidateCount: number;
  [key: string]: unknown;
}

interface DimensionContextSnapshot {
  dimId: string;
  context: unknown;
  timestamp: number;
  [key: string]: unknown;
}

interface CandidateSummary {
  id: string;
  title: string;
  knowledgeType: string;
  score?: number;
  [key: string]: unknown;
}
