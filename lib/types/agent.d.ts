/** Agent / Task / Plan 类型声明 */

interface Plan {
  steps: PlanStep[];
  goal: string;
  status: string;
  [key: string]: unknown;
}

interface PlanStep {
  id: string;
  description: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  result?: unknown;
  [key: string]: unknown;
}

interface Round {
  index: number;
  startedAt: number;
  endedAt?: number;
  toolCalls: number;
  hasNewInfo: boolean;
  [key: string]: unknown;
}

interface DistilledContext {
  summary: string;
  keyFacts: string[];
  openQuestions: string[];
  [key: string]: unknown;
}
