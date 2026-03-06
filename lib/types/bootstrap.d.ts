/**
 * Bootstrap 类型声明
 */

interface DimensionDigest {
  dimId: string;
  label: string;
  status: string;
  candidateCount: number;
  [key: string]: any;
}

interface DimensionContextSnapshot {
  dimId: string;
  context: any;
  timestamp: number;
  [key: string]: any;
}

interface CandidateSummary {
  id: string;
  title: string;
  knowledgeType: string;
  score?: number;
  [key: string]: any;
}
