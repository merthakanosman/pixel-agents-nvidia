import type { AiGenerateResponse, AiProvider } from '../../../core/src/provider.js';
import type { AgentStateStore } from '../agentStateStore.js';
import { DEFAULT_MAX_CONTEXT_TOKENS } from '../constants.js';
import type { AgentState } from '../types.js';

const REVIEWER_AGENT_ID = 100_004;

const REVIEWER_SYSTEM_PROMPT = `You are the Reviewer in an autonomous AI software company.
Your job is to independently review implementation and test evidence before work is reported as complete.
Look for correctness, maintainability, security, data integrity, missing requirements, and unsupported claims.
Do not approve work merely because another worker says it is complete.
Return a concise result for the Manager with: review verdict, blocking issues, non-blocking issues, and required next action.`;

export class ReviewerWorker {
  private agentId: number | null = null;

  constructor(
    private readonly store: AgentStateStore,
    private readonly provider: AiProvider,
    private readonly model: string,
    private readonly projectDir: string,
  ) {}

  spawn(): number {
    if (this.agentId !== null && this.store.has(this.agentId)) {
      return this.agentId;
    }

    const id = REVIEWER_AGENT_ID;
    const agent: AgentState = {
      id,
      sessionId: `nvidia-reviewer-${id}`,
      terminalRef: undefined,
      isExternal: false,
      projectDir: this.projectDir,
      jsonlFile: '',
      fileOffset: 0,
      lineBuffer: '',
      activeToolIds: new Set(),
      activeToolStatuses: new Map(),
      activeToolNames: new Map(),
      activeSubagentToolIds: new Map(),
      activeSubagentToolNames: new Map(),
      backgroundAgentToolIds: new Set(),
      isWaiting: false,
      permissionSent: false,
      hadToolsInTurn: false,
      lastDataAt: Date.now(),
      linesProcessed: 0,
      seenUnknownRecordTypes: new Set(),
      hookDelivered: false,
      hooksOnly: true,
      providerId: this.provider.id,
      contextTokens: 0,
      maxContextTokens: DEFAULT_MAX_CONTEXT_TOKENS,
      agentName: 'Reviewer',
    };

    this.store.set(id, agent);
    this.store.broadcast({ type: 'agentTeamInfo', id, agentName: 'Reviewer' });
    this.agentId = id;
    return id;
  }

  async run(task: string): Promise<AiGenerateResponse> {
    const id = this.spawn();
    const agent = this.store.get(id);
    if (!agent) throw new Error('Reviewer worker could not be created.');

    const toolId = `reviewer-turn-${Date.now()}`;
    agent.activeToolIds.add(toolId);
    agent.activeToolStatuses.set(toolId, 'Reviewing work');
    agent.activeToolNames.set(toolId, 'Reviewing');
    agent.isWaiting = false;
    agent.lastDataAt = Date.now();

    this.store.broadcast({
      type: 'agentToolStart',
      id,
      toolId,
      status: 'Reviewing work',
      toolName: 'Reviewing',
    });
    this.store.broadcast({ type: 'agentStatus', id, status: 'active' });

    try {
      const response = await this.provider.generate({
        model: this.model,
        messages: [
          { role: 'system', content: REVIEWER_SYSTEM_PROMPT },
          { role: 'user', content: task },
        ],
        temperature: 0.1,
        maxTokens: 1600,
      });

      const totalTokens = response.usage?.totalTokens;
      if (totalTokens !== undefined) {
        agent.contextTokens = totalTokens;
        this.store.broadcast({
          type: 'agentContextUsage',
          id,
          contextTokens: agent.contextTokens,
          maxContextTokens: agent.maxContextTokens,
        });
      }

      return response;
    } finally {
      agent.activeToolIds.delete(toolId);
      agent.activeToolStatuses.delete(toolId);
      agent.activeToolNames.delete(toolId);
      agent.isWaiting = true;
      agent.lastDataAt = Date.now();

      this.store.broadcast({ type: 'agentToolDone', id, toolId });
      this.store.broadcast({
        type: 'agentStatus',
        id,
        status: 'waiting',
        awaitingInput: false,
      });
    }
  }
}
