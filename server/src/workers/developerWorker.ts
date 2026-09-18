import type { AiGenerateResponse, AiProvider } from '../../../core/src/provider.js';
import type { AgentStateStore } from '../agentStateStore.js';
import { DEFAULT_MAX_CONTEXT_TOKENS } from '../constants.js';
import type { AgentState } from '../types.js';

const DEVELOPER_AGENT_ID = 100_002;

const DEVELOPER_SYSTEM_PROMPT = `You are the Developer in an AI software team.
Your job is to turn an assigned software task into a concrete technical implementation.
Be concise and practical. Explain the files, code, and checks needed.
Do not claim that files were changed unless a tool actually changed them.
When you do not have filesystem or shell tools, return the implementation you would apply instead.`;

export class DeveloperWorker {
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

    const id = DEVELOPER_AGENT_ID;
    const agent: AgentState = {
      id,
      sessionId: `nvidia-developer-${id}`,
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
      agentName: 'Developer',
    };

    this.store.set(id, agent);
    this.store.broadcast({
      type: 'agentTeamInfo',
      id,
      agentName: 'Developer',
    });
    this.agentId = id;
    return id;
  }

  async run(task: string): Promise<AiGenerateResponse> {
    const id = this.spawn();
    const agent = this.store.get(id);
    if (!agent) {
      throw new Error('Developer worker could not be created.');
    }

    const toolId = `developer-turn-${Date.now()}`;
    agent.activeToolIds.add(toolId);
    agent.activeToolStatuses.set(toolId, 'Implementing task');
    agent.activeToolNames.set(toolId, 'Coding');
    agent.isWaiting = false;
    agent.lastDataAt = Date.now();

    this.store.broadcast({
      type: 'agentToolStart',
      id,
      toolId,
      status: 'Implementing task',
      toolName: 'Coding',
    });
    this.store.broadcast({ type: 'agentStatus', id, status: 'active' });

    try {
      const response = await this.provider.generate({
        model: this.model,
        messages: [
          { role: 'system', content: DEVELOPER_SYSTEM_PROMPT },
          { role: 'user', content: task },
        ],
        temperature: 0.2,
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
