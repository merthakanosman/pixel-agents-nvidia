import { useEffect, useRef, useState } from 'react';

import type { SalesSimulatorMessageView, SalesSimulatorResult } from '../../../core/src/messages.js';
import { transport } from '../transport/index.js';
import { Button } from './ui/Button.js';

export function SalesDmSimulatorPanel() {
  const [open, setOpen] = useState(false);
  const [instagramUserId, setInstagramUserId] = useState('local-customer-1');
  const [username, setUsername] = useState('test-musteri');
  const [message, setMessage] = useState('');
  const [messages, setMessages] = useState<SalesSimulatorMessageView[]>([]);
  const [leadStage, setLeadStage] = useState<string | null>(null);
  const [orderStatus, setOrderStatus] = useState<string | null>(null);
  const [paymentStatus, setPaymentStatus] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const requestIdRef = useRef<string | null>(null);

  useEffect(() => {
    return transport.onMessage((raw) => {
      if (raw.type !== 'salesSimulatorResult') return;
      const result = raw as SalesSimulatorResult;
      if (result.requestId !== requestIdRef.current) return;

      requestIdRef.current = null;
      setPending(false);

      if (!result.ok) {
        setError(result.error ?? 'Sales simulator failed.');
        return;
      }

      setError('');
      setMessages(result.messages ?? []);
      setLeadStage(result.leadStage ?? null);
      setOrderStatus(result.orderStatus ?? null);
      setPaymentStatus(result.paymentStatus ?? null);
    });
  }, []);

  const sendMessage = () => {
    const trimmedUserId = instagramUserId.trim();
    const trimmedMessage = message.trim();
    if (pending || !trimmedUserId || !trimmedMessage) return;

    const requestId = crypto.randomUUID();
    requestIdRef.current = requestId;
    setPending(true);
    setError('');

    transport.send({
      type: 'salesSimulatorMessage',
      requestId,
      instagramUserId: trimmedUserId,
      ...(username.trim() ? { username: username.trim() } : {}),
      message: trimmedMessage,
      messageId: `local-${crypto.randomUUID()}`,
    });
    setMessage('');
  };

  if (!open) {
    return (
      <Button
        variant="accent"
        size="sm"
        className="absolute bottom-10 left-10 z-20"
        onClick={() => setOpen(true)}
      >
        Sales DM
      </Button>
    );
  }

  return (
    <div className="absolute bottom-10 left-10 z-20 w-[520px] max-w-[calc(100vw-20px)] max-h-[calc(100vh-20px)] overflow-y-auto pixel-scrollbar pixel-panel p-6">
      <div className="flex items-center justify-between gap-4 mb-4">
        <div>
          <div className="text-base text-accent-bright">Sales DM Simulator</div>
          <div className="text-2xs text-warning mt-1">SANDBOX — gerçek Instagram veya ödeme yok</div>
        </div>
        <Button variant="default" size="sm" onClick={() => setOpen(false)}>
          Kapat
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-3 mb-4">
        <input
          value={instagramUserId}
          onChange={(event) => setInstagramUserId(event.target.value)}
          disabled={pending}
          placeholder="Instagram user id"
          className="bg-btn-bg border-2 border-border p-3 text-xs text-text outline-none focus:border-accent"
        />
        <input
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          disabled={pending}
          placeholder="@username"
          className="bg-btn-bg border-2 border-border p-3 text-xs text-text outline-none focus:border-accent"
        />
      </div>

      {(leadStage || orderStatus || paymentStatus) && (
        <div className="mb-4 flex flex-wrap gap-2 text-2xs">
          {leadStage && <span className="border border-border px-2 py-1">Lead: {leadStage}</span>}
          {orderStatus && <span className="border border-border px-2 py-1">Order: {orderStatus}</span>}
          {paymentStatus && (
            <span className="border border-border px-2 py-1">Payment: {paymentStatus}</span>
          )}
        </div>
      )}

      <div className="min-h-44 max-h-[340px] overflow-y-auto pixel-scrollbar border-2 border-border bg-bg-dark p-4 space-y-3">
        {messages.length === 0 ? (
          <div className="text-xs text-text-muted">
            Aynı Instagram user id ile mesaj gönderdikçe konuşma kaldığı yerden devam eder.
          </div>
        ) : (
          messages.map((item) => (
            <div
              key={item.id}
              className={
                item.direction === 'inbound'
                  ? 'mr-12 border-l-2 border-accent pl-3'
                  : 'ml-12 border-l-2 border-status-success pl-3'
              }
            >
              <div className="text-2xs text-text-muted mb-1">
                {item.direction === 'inbound' ? 'Müşteri' : 'Sales Agent'}
              </div>
              <div className="text-sm text-text whitespace-pre-wrap">{item.text}</div>
            </div>
          ))
        )}
      </div>

      {error && <div className="mt-3 text-xs text-status-error whitespace-pre-wrap">{error}</div>}

      <textarea
        value={message}
        onChange={(event) => setMessage(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            sendMessage();
          }
        }}
        maxLength={4000}
        disabled={pending}
        placeholder="Müşteri mesajı..."
        className="mt-4 w-full min-h-20 resize-y bg-btn-bg border-2 border-border p-4 text-sm text-text outline-none focus:border-accent disabled:opacity-[var(--btn-disabled-opacity)]"
      />

      <div className="mt-3 flex justify-end">
        <Button
          variant={pending ? 'disabled' : 'accent'}
          size="sm"
          disabled={pending || !instagramUserId.trim() || !message.trim()}
          onClick={sendMessage}
        >
          {pending ? 'Sales Agent düşünüyor...' : 'Mesaj Gönder'}
        </Button>
      </div>
    </div>
  );
}
