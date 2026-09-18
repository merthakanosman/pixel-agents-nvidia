import { useEffect, useRef, useState } from 'react';

import type { ManagerTaskResult } from '../../../core/src/messages.js';
import { transport } from '../transport/index.js';
import { Button } from './ui/Button.js';

export function ManagerTaskPanel() {
  const [task, setTask] = useState('');
  const [pendingRequestId, setPendingRequestId] = useState<string | null>(null);
  const pendingRequestIdRef = useRef<string | null>(null);
  const [response, setResponse] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    return transport.onMessage((message) => {
      if (message.type !== 'managerTaskResult') return;
      const result = message as ManagerTaskResult;
      if (result.requestId !== pendingRequestIdRef.current) return;

      pendingRequestIdRef.current = null;
      setPendingRequestId(null);
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
    setResponse('');
    setError('');
    transport.send({ type: 'managerTask', requestId, task: trimmed });
  };

  return (
    <div className="absolute bottom-10 right-10 z-20 w-[560px] max-w-[calc(100vw-20px)] pixel-panel p-6">
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
        placeholder="Manager'a bir görev ver..."
        className="w-full min-h-24 resize-y bg-btn-bg border-2 border-border p-4 text-sm text-text outline-none focus:border-accent"
      />
      <div className="flex items-center justify-between gap-4 mt-4">
        <span className="text-2xs text-text-muted">Ctrl + Enter</span>
        <Button
          variant={pendingRequestId ? 'disabled' : 'accent'}
          size="sm"
          disabled={pendingRequestId !== null || task.trim().length === 0}
          onClick={submitTask}
        >
          {pendingRequestId ? 'Working...' : 'Send to Manager'}
        </Button>
      </div>

      {(response || error) && (
        <div className="mt-6 border-t-2 border-border pt-5">
          <div className="text-sm text-text-muted mb-3 font-bold">
            {error ? 'Error' : 'Manager response'}
          </div>
          <div className="text-base leading-relaxed text-text whitespace-pre-wrap max-h-[360px] min-h-24 overflow-y-auto pr-2">
            {error || response}
          </div>
        </div>
      )}
    </div>
  );
}
