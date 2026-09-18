import type { CompanyTask, PlannedCompanyTask } from './types.js';

export class CompanyTaskStore {
  private readonly tasks = new Map<string, CompanyTask>();
  private nextId = 1;

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
    return task;
  }

  update(id: string, patch: Partial<Pick<CompanyTask, 'status' | 'result' | 'error'>>): CompanyTask {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`Unknown company task: ${id}`);
    Object.assign(task, patch, { updatedAt: Date.now() });
    return task;
  }

  list(): CompanyTask[] {
    return [...this.tasks.values()];
  }
}
