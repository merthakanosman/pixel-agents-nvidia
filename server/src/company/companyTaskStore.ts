import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { LAYOUT_FILE_DIR } from '../constants.js';
import type {
  CompanyRun,
  CompanyRunStatus,
  CompanySession,
  CompanySessionStatus,
  CompanyTask,
  CompanyTaskStatus,
  PlannedCompanyTask,
} from './types.js';

const STORE_VERSION = 2;
const LEGACY_SESSION_ID = 'session-legacy';
const SESSION_ID_PATTERN = /^session-(\d+)$/;
const TASK_ID_PATTERN = /^task-(\d+)$/;
const RUN_ID_PATTERN = /^run-(\d+)$/;
const RESTART_ERROR = 'Process restarted before task completed.';

interface PersistedCompanyTaskStateV1 {
  version: 1;
  nextId: number;
  tasks: unknown[];
}

interface PersistedCompanyTaskStateV2 {
  version: 2;
  nextSessionId: number;
  nextTaskId: number;
  nextRunId: number;
  sessions: CompanySession[];
  tasks: CompanyTask[];
  runs: CompanyRun[];
}

interface LegacyCompanyTask {
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

export interface CompanyTaskStoreOptions {
  workspaceRoot?: string;
  storageDir?: string;
}

function isSessionStatus(value: unknown): value is CompanySessionStatus {
  return value === 'running' || value === 'completed' || value === 'failed';
}

function isTaskStatus(value: unknown): value is CompanyTaskStatus {
  return value === 'queued' || value === 'running' || value === 'completed' || value === 'failed';
}

function isRunStatus(value: unknown): value is CompanyRunStatus {
  return value === 'running' || value === 'completed' || value === 'failed';
}

function parseOptionalString(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  return typeof value === 'string' ? value : null;
}

function parseSession(value: unknown): CompanySession | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  const session = value as Record<string, unknown>;
  if (
    typeof session['id'] !== 'string' ||
    (session['userRequest'] !== null && typeof session['userRequest'] !== 'string') ||
    !isSessionStatus(session['status']) ||
    typeof session['createdAt'] !== 'number' ||
    typeof session['updatedAt'] !== 'number'
  ) {
    return null;
  }

  const finalResponse = parseOptionalString(session['finalResponse']);
  if (finalResponse === null) return null;

  return {
    id: session['id'],
    userRequest: session['userRequest'],
    status: session['status'],
    ...(finalResponse !== undefined ? { finalResponse } : {}),
    createdAt: session['createdAt'],
    updatedAt: session['updatedAt'],
  };
}

function parseLegacyTask(value: unknown): LegacyCompanyTask | null {
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

  const result = parseOptionalString(task['result']);
  const error = parseOptionalString(task['error']);
  if (result === null || error === null) return null;

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

function parseTask(value: unknown): CompanyTask | null {
  const legacy = parseLegacyTask(value);
  if (!legacy || !value || typeof value !== 'object' || Array.isArray(value)) return null;

  const task = value as Record<string, unknown>;
  if (task['sessionId'] !== null && typeof task['sessionId'] !== 'string') return null;

  return {
    ...legacy,
    sessionId: task['sessionId'],
  };
}

function parseRun(value: unknown): CompanyRun | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  const run = value as Record<string, unknown>;
  if (
    typeof run['id'] !== 'string' ||
    typeof run['taskId'] !== 'string' ||
    typeof run['attempt'] !== 'number' ||
    !Number.isInteger(run['attempt']) ||
    run['attempt'] < 1 ||
    (run['input'] !== null && typeof run['input'] !== 'string') ||
    !isRunStatus(run['status']) ||
    typeof run['createdAt'] !== 'number' ||
    typeof run['updatedAt'] !== 'number'
  ) {
    return null;
  }

  const result = parseOptionalString(run['result']);
  const error = parseOptionalString(run['error']);
  if (result === null || error === null) return null;

  return {
    id: run['id'],
    taskId: run['taskId'],
    attempt: run['attempt'],
    input: run['input'],
    status: run['status'],
    ...(result !== undefined ? { result } : {}),
    ...(error !== undefined ? { error } : {}),
    createdAt: run['createdAt'],
    updatedAt: run['updatedAt'],
  };
}

function nextIdFromPattern(ids: Iterable<string>, pattern: RegExp): number {
  let highest = 0;
  for (const id of ids) {
    const match = pattern.exec(id);
    if (!match) continue;
    highest = Math.max(highest, Number(match[1]));
  }
  return highest + 1;
}

function validNextId(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : 1;
}

function workspaceId(workspaceRoot: string): string {
  const normalized = process.platform === 'win32' ? workspaceRoot.toLowerCase() : workspaceRoot;
  return createHash('sha256').update(normalized).digest('hex').slice(0, 24);
}

export class CompanyTaskStore {
  private readonly sessions = new Map<string, CompanySession>();
  private readonly tasks = new Map<string, CompanyTask>();
  private readonly runs = new Map<string, CompanyRun>();
  private nextSessionId = 1;
  private nextTaskId = 1;
  private nextRunId = 1;
  private readonly stateFilePath: string | null;

  constructor(options: CompanyTaskStoreOptions = {}) {
    if (!options.workspaceRoot) {
      this.stateFilePath = null;
      return;
    }

    const resolvedWorkspace = fs.realpathSync(path.resolve(options.workspaceRoot));
    const storageDir = options.storageDir ?? path.join(os.homedir(), LAYOUT_FILE_DIR, 'company');
    this.stateFilePath = path.join(storageDir, `${workspaceId(resolvedWorkspace)}.json`);
    this.loadState();
  }

  createSession(userRequest: string): CompanySession {
    const now = Date.now();
    const session: CompanySession = {
      id: `session-${this.nextSessionId++}`,
      userRequest,
      status: 'running',
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.set(session.id, session);
    this.persistState();
    return session;
  }

  updateSession(
    id: string,
    patch: Partial<Pick<CompanySession, 'status' | 'finalResponse'>>,
  ): CompanySession {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Unknown company session: ${id}`);
    Object.assign(session, patch, { updatedAt: Date.now() });
    this.persistState();
    return session;
  }

  create(planned: PlannedCompanyTask, sessionId: string | null = null): CompanyTask {
    if (sessionId !== null && !this.sessions.has(sessionId)) {
      throw new Error(`Unknown company session: ${sessionId}`);
    }

    const now = Date.now();
    const task: CompanyTask = {
      id: `task-${this.nextTaskId++}`,
      sessionId,
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

    const now = Date.now();
    if (patch.status === 'running' && task.status !== 'running') {
      this.createRunRecord(task.id, null, now);
      delete task.result;
      delete task.error;
    }

    Object.assign(task, patch, { updatedAt: now });

    if (patch.status === 'completed' || patch.status === 'failed') {
      const activeRun = this.latestRun(task.id, 'running');
      if (activeRun) {
        activeRun.status = patch.status;
        if (patch.result !== undefined) activeRun.result = patch.result;
        if (patch.error !== undefined) activeRun.error = patch.error;
        activeRun.updatedAt = now;
      }
    }

    this.persistState();
    return task;
  }

  startRun(taskId: string, input: string | null): CompanyRun {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Unknown company task: ${taskId}`);
    if (this.latestRun(taskId, 'running')) {
      throw new Error(`Company task already has a running attempt: ${taskId}`);
    }

    const now = Date.now();
    const run = this.createRunRecord(taskId, input, now);
    task.status = 'running';
    delete task.result;
    delete task.error;
    task.updatedAt = now;
    this.persistState();
    return run;
  }

  updateRun(
    id: string,
    patch: Partial<Pick<CompanyRun, 'status' | 'result' | 'error'>>,
  ): CompanyRun {
    const run = this.runs.get(id);
    if (!run) throw new Error(`Unknown company run: ${id}`);

    const now = Date.now();
    Object.assign(run, patch, { updatedAt: now });

    const task = this.tasks.get(run.taskId);
    if (task && (run.status === 'completed' || run.status === 'failed')) {
      task.status = run.status;
      if (run.result !== undefined) task.result = run.result;
      else delete task.result;
      if (run.error !== undefined) task.error = run.error;
      else delete task.error;
      task.updatedAt = now;
    }

    this.persistState();
    return run;
  }

  list(): CompanyTask[] {
    return [...this.tasks.values()];
  }

  listSessions(): CompanySession[] {
    return [...this.sessions.values()];
  }

  listRuns(): CompanyRun[] {
    return [...this.runs.values()];
  }

  private createRunRecord(taskId: string, input: string | null, now: number): CompanyRun {
    const previousAttempts = this.listRuns().filter((run) => run.taskId === taskId);
    const attempt = previousAttempts.reduce((highest, run) => Math.max(highest, run.attempt), 0) + 1;
    const run: CompanyRun = {
      id: `run-${this.nextRunId++}`,
      taskId,
      attempt,
      input,
      status: 'running',
      createdAt: now,
      updatedAt: now,
    };
    this.runs.set(run.id, run);
    return run;
  }

  private latestRun(taskId: string, status?: CompanyRunStatus): CompanyRun | undefined {
    let latest: CompanyRun | undefined;
    for (const run of this.runs.values()) {
      if (run.taskId !== taskId || (status && run.status !== status)) continue;
      if (!latest || run.attempt > latest.attempt) latest = run;
    }
    return latest;
  }

  private loadState(): void {
    if (!this.stateFilePath || !fs.existsSync(this.stateFilePath)) return;

    try {
      const raw = fs.readFileSync(this.stateFilePath, 'utf8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      let migrated = false;

      if (parsed['version'] === 1) {
        this.loadV1(parsed as unknown as PersistedCompanyTaskStateV1);
        migrated = true;
      } else if (parsed['version'] === STORE_VERSION) {
        this.loadV2(parsed as unknown as PersistedCompanyTaskStateV2);
      } else {
        throw new Error(`Unsupported company task state version: ${String(parsed['version'])}`);
      }

      const recovered = this.recoverInterruptedWork();
      if (migrated || recovered) this.persistState();
    } catch (err) {
      console.error('[Pixel Agents] Failed to read company task state:', err);
      this.sessions.clear();
      this.tasks.clear();
      this.runs.clear();
      this.nextSessionId = 1;
      this.nextTaskId = 1;
      this.nextRunId = 1;
    }
  }

  private loadV1(parsed: PersistedCompanyTaskStateV1): void {
    const legacyTasks = Array.isArray(parsed.tasks)
      ? parsed.tasks.map(parseLegacyTask).filter((task): task is LegacyCompanyTask => task !== null)
      : [];

    this.sessions.clear();
    this.tasks.clear();
    this.runs.clear();

    if (legacyTasks.length > 0) {
      const createdAt = Math.min(...legacyTasks.map((task) => task.createdAt));
      const updatedAt = Math.max(...legacyTasks.map((task) => task.updatedAt));
      const status: CompanySessionStatus = legacyTasks.every((task) => task.status === 'completed')
        ? 'completed'
        : legacyTasks.some((task) => task.status === 'running' || task.status === 'queued')
          ? 'running'
          : 'failed';

      this.sessions.set(LEGACY_SESSION_ID, {
        id: LEGACY_SESSION_ID,
        userRequest: null,
        status,
        createdAt,
        updatedAt,
      });
    }

    let migratedRunId = 1;
    for (const legacy of legacyTasks) {
      const task: CompanyTask = {
        ...legacy,
        sessionId: LEGACY_SESSION_ID,
      };
      this.tasks.set(task.id, task);

      if (task.status === 'queued') continue;
      const run: CompanyRun = {
        id: `run-${migratedRunId++}`,
        taskId: task.id,
        attempt: 1,
        input: null,
        status: task.status,
        ...(task.result !== undefined ? { result: task.result } : {}),
        ...(task.error !== undefined ? { error: task.error } : {}),
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
      };
      this.runs.set(run.id, run);
    }

    this.nextSessionId = 1;
    this.nextTaskId = Math.max(
      validNextId(parsed.nextId),
      nextIdFromPattern(this.tasks.keys(), TASK_ID_PATTERN),
    );
    this.nextRunId = Math.max(
      migratedRunId,
      nextIdFromPattern(this.runs.keys(), RUN_ID_PATTERN),
    );
  }

  private loadV2(parsed: PersistedCompanyTaskStateV2): void {
    const loadedSessions = Array.isArray(parsed.sessions)
      ? parsed.sessions.map(parseSession).filter((session): session is CompanySession => session !== null)
      : [];
    const loadedTasks = Array.isArray(parsed.tasks)
      ? parsed.tasks.map(parseTask).filter((task): task is CompanyTask => task !== null)
      : [];
    const taskIds = new Set(loadedTasks.map((task) => task.id));
    const loadedRuns = Array.isArray(parsed.runs)
      ? parsed.runs
          .map(parseRun)
          .filter((run): run is CompanyRun => run !== null && taskIds.has(run.taskId))
      : [];

    this.sessions.clear();
    this.tasks.clear();
    this.runs.clear();

    for (const session of loadedSessions) this.sessions.set(session.id, session);
    for (const task of loadedTasks) this.tasks.set(task.id, task);
    for (const run of loadedRuns) this.runs.set(run.id, run);

    this.nextSessionId = Math.max(
      validNextId(parsed.nextSessionId),
      nextIdFromPattern(this.sessions.keys(), SESSION_ID_PATTERN),
    );
    this.nextTaskId = Math.max(
      validNextId(parsed.nextTaskId),
      nextIdFromPattern(this.tasks.keys(), TASK_ID_PATTERN),
    );
    this.nextRunId = Math.max(
      validNextId(parsed.nextRunId),
      nextIdFromPattern(this.runs.keys(), RUN_ID_PATTERN),
    );
  }

  private recoverInterruptedWork(): boolean {
    let recovered = false;
    const recoveredAt = Date.now();

    for (const run of this.runs.values()) {
      if (run.status !== 'running') continue;
      run.status = 'failed';
      run.error = RESTART_ERROR;
      run.updatedAt = recoveredAt;
      recovered = true;
    }

    for (const task of this.tasks.values()) {
      if (task.status !== 'running') continue;
      task.status = 'failed';
      task.error = RESTART_ERROR;
      task.updatedAt = recoveredAt;
      recovered = true;
    }

    for (const session of this.sessions.values()) {
      if (session.status !== 'running') continue;
      session.status = 'failed';
      session.updatedAt = recoveredAt;
      recovered = true;
    }

    return recovered;
  }

  private persistState(): void {
    if (!this.stateFilePath) return;

    try {
      const dir = path.dirname(this.stateFilePath);
      fs.mkdirSync(dir, { recursive: true });

      const state: PersistedCompanyTaskStateV2 = {
        version: STORE_VERSION,
        nextSessionId: this.nextSessionId,
        nextTaskId: this.nextTaskId,
        nextRunId: this.nextRunId,
        sessions: this.listSessions(),
        tasks: this.list(),
        runs: this.listRuns(),
      };
      const tempPath = `${this.stateFilePath}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify(state, null, 2), 'utf8');
      fs.renameSync(tempPath, this.stateFilePath);
    } catch (err) {
      console.error('[Pixel Agents] Failed to write company task state:', err);
    }
  }
}
