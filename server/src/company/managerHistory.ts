import type {
  ManagerHistoryRun,
  ManagerHistorySession,
  ManagerHistoryTask,
} from '../../../core/src/messages.js';
import type { CompanyTaskStore } from './companyTaskStore.js';

export function buildManagerHistory(taskStore: CompanyTaskStore): ManagerHistorySession[] {
  const tasks = taskStore.list();
  const runs = taskStore.listRuns();

  return taskStore
    .listSessions()
    .slice()
    .sort((left, right) => right.createdAt - left.createdAt)
    .map((session) => {
      const sessionTasks: ManagerHistoryTask[] = tasks
        .filter((task) => task.sessionId === session.id)
        .sort((left, right) => left.createdAt - right.createdAt)
        .map((task) => ({
          id: task.id,
          title: task.title,
          assignee: task.assignee,
          status: task.status,
          ...(task.result !== undefined ? { result: task.result } : {}),
          ...(task.error !== undefined ? { error: task.error } : {}),
          runs: runs
            .filter((run) => run.taskId === task.id)
            .sort((left, right) => left.attempt - right.attempt)
            .map(
              (run): ManagerHistoryRun => ({
                id: run.id,
                attempt: run.attempt,
                status: run.status,
                ...(run.result !== undefined ? { result: run.result } : {}),
                ...(run.error !== undefined ? { error: run.error } : {}),
                createdAt: run.createdAt,
              }),
            ),
        }));

      return {
        id: session.id,
        userRequest: session.userRequest,
        status: session.status,
        ...(session.finalResponse !== undefined ? { finalResponse: session.finalResponse } : {}),
        createdAt: session.createdAt,
        tasks: sessionTasks,
      };
    });
}
