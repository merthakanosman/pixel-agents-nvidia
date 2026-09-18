import type { AiGenerateResponse } from '../../../core/src/provider.js';

export type CompanyTaskStatus = 'queued' | 'running' | 'completed' | 'failed';

export interface PlannedCompanyTask {
  title: string;
  description: string;
  assignee: string;
}

export interface ManagerPlan {
  reply?: string;
  tasks: PlannedCompanyTask[];
}

export interface CompanyTask {
  id: string;
  title: string;
  description: string;
  assignee: string;
  status: CompanyTaskStatus;
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
