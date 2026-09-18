import type { AiGenerateResponse, AiProvider } from '../../../core/src/provider.js';
import { DEFAULT_MAX_CONTEXT_TOKENS } from '../constants.js';
import type { AgentStateStore } from '../agentStateStore.js';
import type { AgentState } from '../types.js';

const MANAGER_AGENT_ID = 100_001;

const MANAGER_SYSTEM_PROMPT = `You are the Manager in an AI software team.
Your job is to understand the user's goal, turn it into a clear plan, and decide which specialist should handle each part.
Available specialist roles will include Developer, Tester, and Reviewer.
Be concise, practical, and explicit about the next action.
Do not pretend work was completed when it was not.`;

export class ManagerWorker {
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

    const id = MANAGER_AGENT_ID;
    const agent: AgentState = {
      id,
      sessionId: `nvidia-manager-${id}`,
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
      agentName: 'Manager',
    };

    this.store.set(id, agent);
    this.store.broadcast({
      type: 'agentTeamInfo',
      id,
      agentName: 'Manager',
    });
    this.agentId = id;
    return id;
  }

  async run(task: string): Promise<AiGenerateResponse> {
    const id = this.spawn();
    const agent = this.store.get(id);
    if (!agent) {
      throw new Error('Manager worker could not be created.');
    }

    const toolId = `manager-turn-${Date.now()}`;
    agent.activeToolIds.add(toolId);
    agent.activeToolStatuses.set(toolId, 'Planning task');
    agent.activeToolNames.set(toolId, 'Reasoning');
    agent.isWaiting = false;
    agent.lastDataAt = Date.now();

    this.store.broadcast({
      type: 'agentToolStart',
      id,
      toolId,
      status: 'Planning task',
      toolName: 'Reasoning',
    });
    this.store.broadcast({ type: 'agentStatus', id, status: 'active' });

    try {
      const response = await this.provider.generate({
        model: this.model,
        messages: [
          { role: 'system', content: MANAGER_SYSTEM_PROMPT },
          { role: 'user', content: task },
        ],
        temperature: 0.2,
        maxTokens: 1200,
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
