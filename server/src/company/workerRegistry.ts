import type { CompanyWorker } from './types.js';

export class WorkerRegistry {
  private readonly workers = new Map<string, CompanyWorker>();

  register(worker: CompanyWorker): void {
    const role = worker.role.trim().toLowerCase();
    if (!role) throw new Error('Worker role cannot be empty.');
    if (this.workers.has(role)) {
      throw new Error(`Worker role "${role}" is already registered.`);
    }
    this.workers.set(role, { ...worker, role });
  }

  get(role: string): CompanyWorker | undefined {
    return this.workers.get(role.trim().toLowerCase());
  }

  list(): CompanyWorker[] {
    return [...this.workers.values()];
  }

  describeForManager(): string {
    return this.list()
      .map((worker) => `- ${worker.role}: ${worker.displayName}`)
      .join('\n');
  }
}
