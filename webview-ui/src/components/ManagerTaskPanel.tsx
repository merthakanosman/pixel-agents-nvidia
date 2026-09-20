import { useEffect, useRef, useState } from 'react';

import type {
  ManagerHistory,
  ManagerHistorySession,
  ManagerHistoryTask,
  ManagerTaskResult,
} from '../../../core/src/messages.js';
import { transport } from '../transport/index.js';
import { Button } from './ui/Button.js';

function statusLabel(status: string): string {
  switch (status) {
    case 'completed':
      return 'Tamamlandı';
    case 'failed':
      return 'Başarısız';
    case 'running':
      return 'Çalışıyor';
    case 'queued':
      return 'Sırada';
    default:
      return status;
  }
}

function statusIcon(status: string): string {
  switch (status) {
    case 'completed':
      return '✓';
    case 'failed':
      return '✕';
    case 'running':
      return '•';
    default:
      return '·';
  }
}

function statusClassName(status: string): string {
  switch (status) {
    case 'completed':
      return 'text-status-success';
    case 'failed':
      return 'text-status-error';
    case 'running':
      return 'text-status-active';
    default:
      return 'text-text-muted';
  }
}

function formatCreatedAt(createdAt: number): string {
  return new Date(createdAt).toLocaleString('tr-TR', {
    dateStyle: 'short',
    timeStyle: 'short',
  });
}

function TaskHistory({
  task,
  busy,
  retryingTaskId,
  onRetry,
}: {
  task: ManagerHistoryTask;
  busy: boolean;
  retryingTaskId: string | null;
  onRetry: (taskId: string) => void;
}) {
  return (
    <div className="border-2 border-border bg-bg-dark p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="text-sm text-text">
            <span className={statusClassName(task.status)}>{statusIcon(task.status)}</span>{' '}
            <span className="text-text-muted">{task.assignee}</span> — {task.title}
          </div>
          {(task.error || task.result) && (
            <div className="mt-2 text-xs text-text-muted whitespace-pre-wrap max-h-20 overflow-y-auto pixel-scrollbar">
              {task.error ?? task.result}
            </div>
          )}
        </div>
        <span className={`shrink-0 text-xs ${statusClassName(task.status)}`}>
          {statusLabel(task.status)}
        </span>
      </div>

      {task.runs.length > 0 && (
        <div className="mt-3 border-t-2 border-border pt-3 space-y-2">
          {task.runs.map((run) => (
            <div key={run.id} className="text-xs">
              <div className="flex items-center justify-between gap-3">
                <span className="text-text-muted">Run #{run.attempt}</span>
                <span className={statusClassName(run.status)}>
                  {statusIcon(run.status)} {statusLabel(run.status)}
                </span>
              </div>
              {(run.error || run.result) && (
                <div className="mt-1 text-text-muted whitespace-pre-wrap max-h-16 overflow-y-auto pixel-scrollbar">
                  {run.error ?? run.result}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {task.status === 'failed' && (
        <div className="mt-4 flex justify-end">
          <Button
            variant={busy ? 'disabled' : 'default'}
            size="sm"
            className="px-4!"
            disabled={busy}
            onClick={() => onRetry(task.id)}
          >
            {retryingTaskId === task.id ? 'Tekrar deneniyor...' : 'Tekrar Dene'}
          </Button>
        </div>
      )}
    </div>
  );
}

function SessionHistory({
  session,
  expanded,
  busy,
  retryingTaskId,
  onToggle,
  onRetry,
}: {
  session: ManagerHistorySession;
  expanded: boolean;
  busy: boolean;
  retryingTaskId: string | null;
  onToggle: () => void;
  onRetry: (taskId: string) => void;
}) {
  return (
    <div className="border-2 border-border">
      <button
        type="button"
        className="w-full bg-btn-bg hover:bg-btn-hover p-4 text-left cursor-pointer"
        aria-expanded={expanded}
        onClick={onToggle}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="text-sm text-text break-words">
              <span className="text-text-muted mr-2">{expanded ? '▼' : '▶'}</span>
              {session.userRequest ?? 'Eski görev geçmişi'}
            </div>
            <div className="mt-1 text-2xs text-text-muted">
              {formatCreatedAt(session.createdAt)}
            </div>
          </div>
          <span className={`shrink-0 text-xs ${statusClassName(session.status)}`}>
            {statusIcon(session.status)} {statusLabel(session.status)}
          </span>
        </div>
      </button>

      {expanded && (
        <div className="p-3 space-y-3 bg-bg">
          {session.tasks.length === 0 ? (
            <div className="text-xs text-text-muted px-1 py-2">Bu istekte worker görevi yok.</div>
          ) : (
            session.tasks.map((task) => (
              <TaskHistory
                key={task.id}
                task={task}
                busy={busy}
                retryingTaskId={retryingTaskId}
                onRetry={onRetry}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

export function ManagerTaskPanel() {
  const [task, setTask] = useState('');
  const [pendingRequestId, setPendingRequestId] = useState<string | null>(null);
  const pendingRequestIdRef = useRef<string | null>(null);
  const [retryingTaskId, setRetryingTaskId] = useState<string | null>(null);
  const [response, setResponse] = useState('');
  const [error, setError] = useState('');
  const [history, setHistory] = useState<ManagerHistorySession[]>([]);
  const [isHistoryOpen, setIsHistoryOpen] = useState(true);
  const [expandedSessionIds, setExpandedSessionIds] = useState<Set<string>>(new Set());
  const latestSessionIdRef = useRef<string | null>(null);

  useEffect(() => {
    return transport.onMessage((message) => {
      if (message.type === 'managerHistory') {
        const snapshot = (message as ManagerHistory).sessions;
        setHistory(snapshot);

        const latestSessionId = snapshot[0]?.id ?? null;
        if (latestSessionId && latestSessionId !== latestSessionIdRef.current) {
          setExpandedSessionIds((current) => {
            const next = new Set(current);
            next.add(latestSessionId);
            return next;
          });
        }
        latestSessionIdRef.current = latestSessionId;
        return;
      }

      if (message.type !== 'managerTaskResult') return;
      const result = message as ManagerTaskResult;
      if (result.requestId !== pendingRequestIdRef.current) return;

      pendingRequestIdRef.current = null;
      setPendingRequestId(null);
      setRetryingTaskId(null);
      if (result.ok) {
        setResponse(result.response ?? '');
        setError('');
      } else {
        setResponse('');
        setError(result.error ?? 'Manager task failed.');
      }
    });
  }, []);

  const submitTask = () => {
    const trimmed = task.trim();
    if (!trimmed || pendingRequestId) return;

    const requestId = crypto.randomUUID();
    pendingRequestIdRef.current = requestId;
    setPendingRequestId(requestId);
    setRetryingTaskId(null);
    setResponse('');
    setError('');
    transport.send({ type: 'managerTask', requestId, task: trimmed });
  };

  const retryTask = (taskId: string) => {
    if (pendingRequestId) return;

    const requestId = crypto.randomUUID();
    pendingRequestIdRef.current = requestId;
    setPendingRequestId(requestId);
    setRetryingTaskId(taskId);
    setResponse('');
    setError('');
    transport.send({ type: 'managerRetryTask', requestId, taskId });
  };

  const toggleSession = (sessionId: string) => {
    setExpandedSessionIds((current) => {
      const next = new Set(current);
      if (next.has(sessionId)) {
        next.delete(sessionId);
      } else {
        next.add(sessionId);
      }
      return next;
    });
  };

  const busy = pendingRequestId !== null;

  return (
    <div className="absolute bottom-10 right-10 z-20 w-[560px] max-w-[calc(100vw-20px)] max-h-[calc(100vh-20px)] overflow-y-auto pixel-scrollbar pixel-panel p-6">
      <div className="text-base text-accent-bright mb-4">Manager</div>
      <textarea
        value={task}
        onChange={(event) => setTask(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            submitTask();
          }
        }}
        maxLength={8000}
        disabled={busy}
        placeholder="Manager'a bir görev ver..."
        className="w-full min-h-24 resize-y bg-btn-bg border-2 border-border p-4 text-sm text-text outline-none focus:border-accent disabled:opacity-[var(--btn-disabled-opacity)]"
      />
      <div className="flex items-center justify-between gap-4 mt-4">
        <span className="text-2xs text-text-muted">Ctrl + Enter</span>
        <Button
          variant={busy ? 'disabled' : 'accent'}
          size="sm"
          disabled={busy || task.trim().length === 0}
          onClick={submitTask}
        >
          {busy && retryingTaskId === null ? 'Working...' : 'Send to Manager'}
        </Button>
      </div>

      {(response || error) && (
        <div className="mt-6 border-t-2 border-border pt-5">
          <div className="text-sm text-text-muted mb-3 font-bold">
            {error ? 'Error' : 'Manager response'}
          </div>
          <div className="text-base leading-relaxed text-text whitespace-pre-wrap max-h-[240px] min-h-24 overflow-y-auto pr-2 pixel-scrollbar">
            {error || response}
          </div>
        </div>
      )}

      {history.length > 0 && (
        <div className="mt-6 border-t-2 border-border pt-5">
          <button
            type="button"
            className="w-full flex items-center justify-between gap-4 text-left cursor-pointer"
            aria-expanded={isHistoryOpen}
            onClick={() => setIsHistoryOpen((current) => !current)}
          >
            <span className="text-sm text-text-muted font-bold">
              Görev Geçmişi ({history.length})
            </span>
            <span className="text-sm text-accent-bright">{isHistoryOpen ? '▲' : '▼'}</span>
          </button>

          {isHistoryOpen && (
            <div className="mt-4 space-y-3 max-h-[420px] overflow-y-auto pr-2 pixel-scrollbar">
              {history.map((session) => (
                <SessionHistory
                  key={session.id}
                  session={session}
                  expanded={expandedSessionIds.has(session.id)}
                  busy={busy}
                  retryingTaskId={retryingTaskId}
                  onToggle={() => toggleSession(session.id)}
                  onRetry={retryTask}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
