import type { AiGenerateResponse, AiProvider } from '../../../core/src/provider.js';
import type { AgentStateStore } from '../agentStateStore.js';
import type { ManagerPlan } from '../company/types.js';
import { DEFAULT_MAX_CONTEXT_TOKENS } from '../constants.js';
import type { AgentState } from '../types.js';

const MANAGER_AGENT_ID = 100_001;

const MANAGER_SYSTEM_PROMPT = `You are the Manager of an autonomous AI company.
The user speaks only with you. You decide what work should be delegated, assign it to available specialist workers, collect their results, and report back to the user.
Be concise, practical, and explicit.
Never claim that work was completed unless a worker result confirms it.
Never invent workers that are not listed as available.`;

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

  run(task: string): Promise<AiGenerateResponse> {
    return this.runTurn('Thinking', 'Reasoning', task, 1200);
  }

  plan(userRequest: string, availableWorkers: string): Promise<AiGenerateResponse> {
    const planningPrompt = `Create a delegation plan for the user's request.

Available workers:
${availableWorkers || '- none'}

Return JSON only, with exactly this shape:
{
  "reply": "optional direct reply when no delegation is needed",
  "tasks": [
    {
      "title": "short task title",
      "description": "clear task instructions",
      "assignee": "one available worker role"
    }
  ]
}

Rules:
- Use only roles from the available workers list.
- If this is casual conversation or no specialist work is needed, return an empty tasks array and put the answer in reply.
- Split real work into the smallest useful tasks.
- Order tasks by dependency because they execute sequentially.
- For software implementation, normally use Developer first, then Tester, then Reviewer when those roles are available and useful.
- Tester and Reviewer should validate earlier worker output instead of repeating the same task.
- Do not invent completion or results.
- Maximum 6 tasks.

User request:
${userRequest}`;

    return this.runTurn('Planning company work', 'Planning', planningPrompt, 1600);
  }

  summarize(
    userRequest: string,
    plan: ManagerPlan,
    results: Array<{
      title: string;
      assignee: string;
      status: string;
      result?: string;
      error?: string;
    }>,
  ): Promise<AiGenerateResponse> {
    const summaryPrompt = `Report the company's completed work back to the user.

Original user request:
${userRequest}

Delegation plan:
${JSON.stringify(plan, null, 2)}

Worker results:
${JSON.stringify(results, null, 2)}

Give the user one concise final report.
Clearly distinguish completed work from failed or incomplete work.
Do not invent actions, files, sales, designs, tests, or other outcomes that are not present in the worker results.`;

    return this.runTurn('Reviewing team results', 'Reviewing', summaryPrompt, 1800);
  }

  private async runTurn(
    status: string,
    toolName: string,
    prompt: string,
    maxTokens: number,
  ): Promise<AiGenerateResponse> {
    const id = this.spawn();
    const agent = this.store.get(id);
    if (!agent) {
      throw new Error('Manager worker could not be created.');
    }

    const toolId = `manager-turn-${Date.now()}`;
    agent.activeToolIds.add(toolId);
    agent.activeToolStatuses.set(toolId, status);
    agent.activeToolNames.set(toolId, toolName);
    agent.isWaiting = false;
    agent.lastDataAt = Date.now();

    this.store.broadcast({
      type: 'agentToolStart',
      id,
      toolId,
      status,
      toolName,
    });
    this.store.broadcast({ type: 'agentStatus', id, status: 'active' });

    try {
      const response = await this.provider.generate({
        model: this.model,
        messages: [
          { role: 'system', content: MANAGER_SYSTEM_PROMPT },
          { role: 'user', content: prompt },
        ],
        temperature: 0.2,
        maxTokens,
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
