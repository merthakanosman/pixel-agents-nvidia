import type { AiGenerateResponse, AiProvider } from '../../../core/src/provider.js';
import type { AgentStateStore } from '../agentStateStore.js';
import { DEFAULT_MAX_CONTEXT_TOKENS } from '../constants.js';
import type { AgentState } from '../types.js';

const TESTER_AGENT_ID = 100_003;

const TESTER_SYSTEM_PROMPT = `You are the Tester in an autonomous AI software company.
Your job is to validate assigned work, identify defects, edge cases, regressions, and missing acceptance criteria.
When actual execution tools are unavailable, produce a concrete test plan and evaluate the supplied implementation evidence.
Never claim that tests passed unless the supplied evidence proves they ran successfully.
Return a concise result for the Manager with: tested scope, findings, risks, and next action.\nAlways write your work result in Turkish.`;

export class TesterWorker {
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

    const id = TESTER_AGENT_ID;
    const agent: AgentState = {
      id,
      sessionId: `nvidia-tester-${id}`,
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
      agentName: 'Tester',
    };

    this.store.set(id, agent);
    this.store.broadcast({ type: 'agentTeamInfo', id, agentName: 'Tester' });
    this.agentId = id;
    return id;
  }

  async run(task: string): Promise<AiGenerateResponse> {
    const id = this.spawn();
    const agent = this.store.get(id);
    if (!agent) throw new Error('Tester worker could not be created.');

    const toolId = `tester-turn-${Date.now()}`;
    agent.activeToolIds.add(toolId);
    agent.activeToolStatuses.set(toolId, 'Testing work');
    agent.activeToolNames.set(toolId, 'Testing');
    agent.isWaiting = false;
    agent.lastDataAt = Date.now();

    this.store.broadcast({
      type: 'agentToolStart',
      id,
      toolId,
      status: 'Testing work',
      toolName: 'Testing',
    });
    this.store.broadcast({ type: 'agentStatus', id, status: 'active' });

    try {
      const response = await this.provider.generate({
        model: this.model,
        messages: [
          { role: 'system', content: TESTER_SYSTEM_PROMPT },
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
