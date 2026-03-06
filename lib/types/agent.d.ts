/**
 * Agent / Task / Plan 类型声明
 */

interface Plan {
  steps: PlanStep[];
  goal: string;
  status: string;
  [key: string]: any;
}

interface PlanStep {
  id: string;
  description: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  result?: any;
  [key: string]: any;
}

interface Round {
  index: number;
  startedAt: number;
  endedAt?: number;
  toolCalls: number;
  hasNewInfo: boolean;
  [key: string]: any;
}

interface DistilledContext {
  summary: string;
  keyFacts: string[];
  openQuestions: string[];
  [key: string]: any;
}
