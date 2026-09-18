import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { LAYOUT_FILE_DIR } from '../constants.js';
import type { CompanyTask, CompanyTaskStatus, PlannedCompanyTask } from './types.js';

const STORE_VERSION = 1;
const TASK_ID_PATTERN = /^task-(\d+)$/;

interface PersistedCompanyTaskState {
  version: number;
  nextId: number;
  tasks: CompanyTask[];
}

export interface CompanyTaskStoreOptions {
  workspaceRoot?: string;
  storageDir?: string;
}

function isTaskStatus(value: unknown): value is CompanyTaskStatus {
  return value === 'queued' || value === 'running' || value === 'completed' || value === 'failed';
}

function parseTask(value: unknown): CompanyTask | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  const task = value as Record<string, unknown>;
  if (
    typeof task['id'] !== 'string' ||
    typeof task['title'] !== 'string' ||
    typeof task['description'] !== 'string' ||
    typeof task['assignee'] !== 'string' ||
    !isTaskStatus(task['status']) ||
    typeof task['createdAt'] !== 'number' ||
    typeof task['updatedAt'] !== 'number'
  ) {
    return null;
  }

  const result = task['result'];
  const error = task['error'];
  if (result !== undefined && typeof result !== 'string') return null;
  if (error !== undefined && typeof error !== 'string') return null;

  return {
    id: task['id'],
    title: task['title'],
    description: task['description'],
    assignee: task['assignee'],
    status: task['status'],
    ...(result !== undefined ? { result } : {}),
    ...(error !== undefined ? { error } : {}),
    createdAt: task['createdAt'],
    updatedAt: task['updatedAt'],
  };
}

function nextIdFromTasks(tasks: readonly CompanyTask[]): number {
  let highest = 0;
  for (const task of tasks) {
    const match = TASK_ID_PATTERN.exec(task.id);
    if (!match) continue;
    highest = Math.max(highest, Number(match[1]));
  }
  return highest + 1;
}

function workspaceId(workspaceRoot: string): string {
  const normalized =
    process.platform === 'win32' ? workspaceRoot.toLowerCase() : workspaceRoot;
  return createHash('sha256').update(normalized).digest('hex').slice(0, 24);
}

export class CompanyTaskStore {
  private readonly tasks = new Map<string, CompanyTask>();
  private nextId = 1;
  private readonly stateFilePath: string | null;

  constructor(options: CompanyTaskStoreOptions = {}) {
    if (!options.workspaceRoot) {
      this.stateFilePath = null;
      return;
    }

    const resolvedWorkspace = fs.realpathSync(path.resolve(options.workspaceRoot));
    const storageDir =
      options.storageDir ?? path.join(os.homedir(), LAYOUT_FILE_DIR, 'company');
    this.stateFilePath = path.join(storageDir, `${workspaceId(resolvedWorkspace)}.json`);
    this.loadState();
  }

  create(planned: PlannedCompanyTask): CompanyTask {
    const now = Date.now();
    const task: CompanyTask = {
      id: `task-${this.nextId++}`,
      title: planned.title,
      description: planned.description,
      assignee: planned.assignee.trim().toLowerCase(),
      status: 'queued',
      createdAt: now,
      updatedAt: now,
    };
    this.tasks.set(task.id, task);
    this.persistState();
    return task;
  }

  update(id: string, patch: Partial<Pick<CompanyTask, 'status' | 'result' | 'error'>>): CompanyTask {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`Unknown company task: ${id}`);
    Object.assign(task, patch, { updatedAt: Date.now() });
    this.persistState();
    return task;
  }

  list(): CompanyTask[] {
    return [...this.tasks.values()];
  }

  private loadState(): void {
    if (!this.stateFilePath || !fs.existsSync(this.stateFilePath)) return;

    try {
      const raw = fs.readFileSync(this.stateFilePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<PersistedCompanyTaskState>;
      const loadedTasks = Array.isArray(parsed.tasks)
        ? parsed.tasks.map(parseTask).filter((task): task is CompanyTask => task !== null)
        : [];

      this.tasks.clear();
      for (const task of loadedTasks) {
        this.tasks.set(task.id, task);
      }

      const persistedNextId =
        typeof parsed.nextId === 'number' && Number.isInteger(parsed.nextId) && parsed.nextId > 0
          ? parsed.nextId
          : 1;
      this.nextId = Math.max(persistedNextId, nextIdFromTasks(loadedTasks));

      let recovered = false;
      const recoveredAt = Date.now();
      for (const task of this.tasks.values()) {
        if (task.status !== 'running') continue;
        task.status = 'failed';
        task.error = 'Process restarted before task completed.';
        task.updatedAt = recoveredAt;
        recovered = true;
      }

      if (recovered) this.persistState();
    } catch (err) {
      console.error('[Pixel Agents] Failed to read company task state:', err);
      this.tasks.clear();
      this.nextId = 1;
    }
  }

  private persistState(): void {
    if (!this.stateFilePath) return;

    try {
      const dir = path.dirname(this.stateFilePath);
      fs.mkdirSync(dir, { recursive: true });

      const state: PersistedCompanyTaskState = {
        version: STORE_VERSION,
        nextId: this.nextId,
        tasks: this.list(),
      };
      const tempPath = `${this.stateFilePath}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify(state, null, 2), 'utf8');
      fs.renameSync(tempPath, this.stateFilePath);
    } catch (err) {
      console.error('[Pixel Agents] Failed to write company task state:', err);
    }
  }
}
