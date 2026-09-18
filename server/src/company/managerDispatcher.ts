import type { ManagerWorker } from '../workers/managerWorker.js';
import { CompanyTaskStore } from './companyTaskStore.js';
import type { CompanyTask, ManagerPlan } from './types.js';
import type { WorkerRegistry } from './workerRegistry.js';

function extractJsonObject(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed;
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('Manager did not return a valid task plan.');
  }
  return trimmed.slice(start, end + 1);
}

function parsePlan(text: string): ManagerPlan {
  const parsed = JSON.parse(extractJsonObject(text)) as Partial<ManagerPlan>;
  const tasks = Array.isArray(parsed.tasks) ? parsed.tasks : [];
  return {
    reply: typeof parsed.reply === 'string' ? parsed.reply : undefined,
    tasks: tasks
      .filter(
        (task): task is ManagerPlan['tasks'][number] =>
          typeof task?.title === 'string' &&
          typeof task?.description === 'string' &&
          typeof task?.assignee === 'string',
      )
      .map((task) => ({
        title: task.title.trim(),
        description: task.description.trim(),
        assignee: task.assignee.trim().toLowerCase(),
      }))
      .filter((task) => task.title && task.description && task.assignee),
  };
}

export class ManagerDispatcher {
  constructor(
    private readonly manager: ManagerWorker,
    private readonly registry: WorkerRegistry,
    private readonly taskStore: CompanyTaskStore,
  ) {}

  async run(userRequest: string): Promise<string> {
    const planResponse = await this.manager.plan(userRequest, this.registry.describeForManager());
    const plan = parsePlan(planResponse.content);

    if (plan.tasks.length === 0) {
      return plan.reply ?? (await this.manager.run(userRequest)).content;
    }

    const completed: CompanyTask[] = [];

    for (const planned of plan.tasks) {
      const worker = this.registry.get(planned.assignee);
      const task = this.taskStore.create(planned);

      if (!worker) {
        this.taskStore.update(task.id, {
          status: 'failed',
          error: `No worker registered for role "${planned.assignee}".`,
        });
        completed.push(task);
        continue;
      }

      this.taskStore.update(task.id, { status: 'running' });

      try {
        const previousResults = completed
          .filter((previous) => previous.status === 'completed' && previous.result)
          .map(
            (previous) =>
              `[${previous.assignee}] ${previous.title}:\n${previous.result ?? ''}`,
          )
          .join('\n\n');

        const result = await worker.run(
          [
            `Company task: ${task.title}`,
            task.description,
            `Original user request:\n${userRequest}`,
            previousResults
              ? `Previous completed company work you may need to validate or build on:\n\n${previousResults}`
              : '',
            'Return a concise work result for the Manager.',
          ]
            .filter(Boolean)
            .join('\n\n'),
        );
        this.taskStore.update(task.id, {
          status: 'completed',
          result: result.content,
        });
      } catch (err) {
        this.taskStore.update(task.id, {
          status: 'failed',
          error: err instanceof Error ? err.message : String(err),
        });
      }

      completed.push(task);
    }

    return (
      await this.manager.summarize(
        userRequest,
        plan,
        completed.map((task) => ({
          title: task.title,
          assignee: task.assignee,
          status: task.status,
          result: task.result,
          error: task.error,
        })),
      )
    ).content;
  }
}
