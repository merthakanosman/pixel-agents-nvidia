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
    const session = this.taskStore.createSession(userRequest);

    try {
      const planResponse = await this.manager.plan(userRequest, this.registry.describeForManager());
      const plan = parsePlan(planResponse.content);

      if (plan.tasks.length === 0) {
        const response = plan.reply ?? (await this.manager.run(userRequest)).content;
        this.taskStore.updateSession(session.id, {
          status: 'completed',
          finalResponse: response,
        });
        return response;
      }

      const completed: CompanyTask[] = [];

      for (const planned of plan.tasks) {
        const worker = this.registry.get(planned.assignee);
        const task = this.taskStore.create(planned, session.id);

        if (!worker) {
          this.taskStore.update(task.id, {
            status: 'failed',
            error: `No worker registered for role "${planned.assignee}".`,
          });
          completed.push(task);
          continue;
        }

        const workerInput = this.buildWorkerInput(task, userRequest, completed);
        const run = this.taskStore.startRun(task.id, workerInput);

        try {
          const result = await worker.run(workerInput);
          this.taskStore.updateRun(run.id, {
            status: 'completed',
            result: result.content,
          });
        } catch (err) {
          this.taskStore.updateRun(run.id, {
            status: 'failed',
            error: err instanceof Error ? err.message : String(err),
          });
        }

        completed.push(task);
      }

      const finalResponse = await this.summarizeSession(userRequest, plan, completed);
      this.taskStore.updateSession(session.id, {
        status: completed.every((task) => task.status === 'completed') ? 'completed' : 'failed',
        finalResponse,
      });

      return finalResponse;
    } catch (err) {
      this.taskStore.updateSession(session.id, { status: 'failed' });
      throw err;
    }
  }

  async retryTask(taskId: string): Promise<string> {
    const task = this.taskStore.list().find((candidate) => candidate.id === taskId);
    if (!task) {
      throw new Error(`Unknown company task: ${taskId}`);
    }
    if (task.status !== 'failed') {
      throw new Error(`Only failed company tasks can be retried: ${taskId}`);
    }
    if (!task.sessionId) {
      throw new Error(`Company task is not attached to a retryable session: ${taskId}`);
    }

    const session = this.taskStore
      .listSessions()
      .find((candidate) => candidate.id === task.sessionId);
    if (!session) {
      throw new Error(`Unknown company session: ${task.sessionId}`);
    }
    if (session.userRequest === null) {
      throw new Error(`Cannot retry legacy task without its original user request: ${taskId}`);
    }

    const worker = this.registry.get(task.assignee);
    if (!worker) {
      throw new Error(`No worker registered for role "${task.assignee}".`);
    }

    const sessionTasks = this.taskStore
      .list()
      .filter((candidate) => candidate.sessionId === session.id);
    const completedContext = sessionTasks.filter(
      (candidate) => candidate.id !== task.id && candidate.status === 'completed',
    );
    const previousRuns = this.taskStore
      .listRuns()
      .filter((run) => run.taskId === task.id)
      .sort((left, right) => left.attempt - right.attempt);
    const previousRun = previousRuns.at(-1);
    const previousFailure = previousRun?.error ?? task.error ?? 'Unknown failure';

    const retryContext = [
      `This is retry attempt ${(previousRun?.attempt ?? 0) + 1} for the same company task.`,
      `Previous attempt failed with:\n${previousFailure}`,
      'Inspect the current workspace state first. Preserve work that is already correct and only complete or repair what remains.',
    ].join('\n\n');

    this.taskStore.updateSession(session.id, { status: 'running' });

    try {
      const workerInput = this.buildWorkerInput(
        task,
        session.userRequest,
        completedContext,
        retryContext,
      );
      const run = this.taskStore.startRun(task.id, workerInput);

      try {
        const result = await worker.run(workerInput);
        this.taskStore.updateRun(run.id, {
          status: 'completed',
          result: result.content,
        });
      } catch (err) {
        this.taskStore.updateRun(run.id, {
          status: 'failed',
          error: err instanceof Error ? err.message : String(err),
        });
      }

      const refreshedTasks = this.taskStore
        .list()
        .filter((candidate) => candidate.sessionId === session.id);
      const retryPlan: ManagerPlan = {
        tasks: refreshedTasks.map((candidate) => ({
          title: candidate.title,
          description: candidate.description,
          assignee: candidate.assignee,
        })),
      };

      const finalResponse = await this.summarizeSession(
        session.userRequest,
        retryPlan,
        refreshedTasks,
      );
      this.taskStore.updateSession(session.id, {
        status: refreshedTasks.every((candidate) => candidate.status === 'completed')
          ? 'completed'
          : 'failed',
        finalResponse,
      });

      return finalResponse;
    } catch (err) {
      this.taskStore.updateSession(session.id, { status: 'failed' });
      throw err;
    }
  }

  private buildWorkerInput(
    task: CompanyTask,
    userRequest: string,
    completed: readonly CompanyTask[],
    retryContext?: string,
  ): string {
    const previousResults = completed
      .filter((previous) => previous.status === 'completed' && previous.result)
      .map(
        (previous) =>
          `[${previous.assignee}] ${previous.title}:\n${previous.result ?? ''}`,
      )
      .join('\n\n');

    return [
      `Company task: ${task.title}`,
      task.description,
      `Original user request:\n${userRequest}`,
      previousResults
        ? `Previous completed company work you may need to validate or build on:\n\n${previousResults}`
        : '',
      retryContext ?? '',
      'Return a concise work result for the Manager.',
    ]
      .filter(Boolean)
      .join('\n\n');
  }

  private async summarizeSession(
    userRequest: string,
    plan: ManagerPlan,
    tasks: readonly CompanyTask[],
  ): Promise<string> {
    return (
      await this.manager.summarize(
        userRequest,
        plan,
        tasks.map((task) => ({
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
