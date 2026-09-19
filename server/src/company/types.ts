import type { AiGenerateResponse } from '../../../core/src/provider.js';

export type CompanySessionStatus = 'running' | 'completed' | 'failed';
export type CompanyTaskStatus = 'queued' | 'running' | 'completed' | 'failed';
export type CompanyRunStatus = 'running' | 'completed' | 'failed';

export interface PlannedCompanyTask {
  title: string;
  description: string;
  assignee: string;
}

export interface ManagerPlan {
  reply?: string;
  tasks: PlannedCompanyTask[];
}

export interface CompanySession {
  id: string;
  /**
   * Null is reserved for migrated history where the original user request
   * was never persisted and therefore cannot be reconstructed safely.
   */
  userRequest: string | null;
  status: CompanySessionStatus;
  finalResponse?: string;
  createdAt: number;
  updatedAt: number;
}

export interface CompanyTask {
  id: string;
  /**
   * Temporarily nullable for callers that have not been upgraded to create a
   * CompanySession yet. New session-aware callers should always provide one.
   */
  sessionId: string | null;
  title: string;
  description: string;
  assignee: string;
  status: CompanyTaskStatus;
  /**
   * Compatibility projection of the latest run. Run history is stored in
   * CompanyRun so retries do not erase earlier outcomes.
   */
  result?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export interface CompanyRun {
  id: string;
  taskId: string;
  attempt: number;
  /**
   * Null means the exact worker input was unavailable (for example migrated
   * v1 history or the temporary pre-session dispatcher path).
   */
  input: string | null;
  status: CompanyRunStatus;
  result?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export interface CompanyWorker {
  role: string;
  displayName: string;
  agentId: number;
  run(task: string): Promise<AiGenerateResponse>;
}
