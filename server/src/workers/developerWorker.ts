import type {
  AiGenerateResponse,
  AiMessage,
  AiProvider,
} from '../../../core/src/provider.js';
import type { AgentStateStore } from '../agentStateStore.js';
import { DEFAULT_MAX_CONTEXT_TOKENS } from '../constants.js';
import { WorkspaceFileTools } from '../tools/workspaceFileTools.js';
import type { AgentState } from '../types.js';

const DEVELOPER_AGENT_ID = 100_002;
const MAX_TOOL_STEPS = 12;

type DeveloperAction =
  | { action: 'list'; path?: string }
  | { action: 'read'; path: string }
  | { action: 'write'; path: string; content: string }
  | { action: 'final'; summary: string };

const DEVELOPER_SYSTEM_PROMPT = `You are the Developer in an autonomous AI software company.
Your job is to perform assigned implementation work inside the provided project workspace.

You have real workspace tools. For EVERY turn, respond with exactly one JSON object and no markdown.

Allowed actions:
{"action":"list","path":"."}
{"action":"read","path":"relative/file.ts"}
{"action":"write","path":"relative/file.ts","content":"complete file content"}
{"action":"final","summary":"Turkish summary of what was actually done"}

Rules:
- Paths must be relative to the workspace.
- Never request or expose secrets.
- Inspect relevant files before changing them.
- If implementation is requested, use write actions to make the actual file changes.
- A write action replaces the entire target file, so preserve existing content that must remain.
- Do not claim a file was created or changed unless a write tool result confirms it.
- Do not claim tests ran; terminal/test execution belongs to the Tester runtime and is not available to you yet.
- Finish only when the assigned implementation work is complete or you are genuinely blocked.
- The final summary must be in Turkish.`;

function extractJsonObject(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed;

  const fenced = trimmed.match(/\`\`\`(?:json)?\s*([\s\S]*?)\s*\`\`\`/i);
  if (fenced?.[1]) return fenced[1].trim();

  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('Developer did not return a JSON action.');
  }
  return trimmed.slice(start, end + 1);
}

function parseAction(text: string): DeveloperAction {
  const value = JSON.parse(extractJsonObject(text)) as Record<string, unknown>;
  const action = value['action'];

  if (action === 'list') {
    const rawPath = value['path'];
    if (rawPath !== undefined && typeof rawPath !== 'string') {
      throw new Error('Developer list action path must be a string.');
    }
    return { action, path: rawPath ?? '.' };
  }

  if (action === 'read') {
    if (typeof value['path'] !== 'string' || !value['path']) {
      throw new Error('Developer read action requires a path.');
    }
    return { action, path: value['path'] };
  }

  if (action === 'write') {
    if (typeof value['path'] !== 'string' || !value['path']) {
      throw new Error('Developer write action requires a path.');
    }
    if (typeof value['content'] !== 'string') {
      throw new Error('Developer write action requires string content.');
    }
    return { action, path: value['path'], content: value['content'] };
  }

  if (action === 'final') {
    if (typeof value['summary'] !== 'string' || !value['summary'].trim()) {
      throw new Error('Developer final action requires a summary.');
    }
    return { action, summary: value['summary'].trim() };
  }

  throw new Error('Developer returned an unsupported action.');
}

export class DeveloperWorker {
  private agentId: number | null = null;
  private readonly fileTools: WorkspaceFileTools;

  constructor(
    private readonly store: AgentStateStore,
    private readonly provider: AiProvider,
    private readonly model: string,
    private readonly projectDir: string,
  ) {
    this.fileTools = new WorkspaceFileTools(projectDir);
  }

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

    const turnToolId = `developer-turn-${Date.now()}`;
    agent.activeToolIds.add(turnToolId);
    agent.activeToolStatuses.set(turnToolId, 'Implementing task');
    agent.activeToolNames.set(turnToolId, 'Coding');
    agent.isWaiting = false;
    agent.lastDataAt = Date.now();

    this.store.broadcast({
      type: 'agentToolStart',
      id,
      toolId: turnToolId,
      status: 'Implementing task',
      toolName: 'Coding',
    });
    this.store.broadcast({ type: 'agentStatus', id, status: 'active' });

    try {
      const messages: AiMessage[] = [
        { role: 'system', content: DEVELOPER_SYSTEM_PROMPT },
        {
          role: 'user',
          content: `Workspace root: ${this.fileTools.getRoot()}\n\nAssigned task:\n${task}`,
        },
      ];

      const evidence: string[] = [];
      let lastResponse: AiGenerateResponse | null = null;

      for (let step = 0; step < MAX_TOOL_STEPS; step++) {
        const response = await this.provider.generate({
          model: this.model,
          messages,
          temperature: 0.1,
          maxTokens: 3000,
        });
        lastResponse = response;
        this.updateContext(agent, id, response);

        let action: DeveloperAction;
        try {
          action = parseAction(response.content);
        } catch (err) {
          messages.push({ role: 'assistant', content: response.content });
          messages.push({
            role: 'user',
            content: `Geçersiz araç cevabı: ${err instanceof Error ? err.message : String(err)}. Yalnızca izin verilen tek bir JSON action döndür.`,
          });
          continue;
        }

        messages.push({ role: 'assistant', content: response.content });

        if (action.action === 'final') {
          const writeEvidence = evidence.filter((entry) => entry.startsWith('WRITE '));
          const evidenceText =
            evidence.length > 0
              ? evidence.map((entry) => `- ${entry}`).join('\n')
              : '- Bu görevde workspace aracı kullanılmadı.';
          const writeText =
            writeEvidence.length > 0
              ? `Gerçek dosya değişiklikleri: ${writeEvidence.length}`
              : 'Gerçek dosya değişikliği yapılmadı.';

          return {
            ...response,
            content: `${action.summary}\n\nAraç kanıtı:\n${evidenceText}\n\n${writeText}`,
          };
        }

        const toolResult = this.executeAction(id, agent, step, action);
        evidence.push(toolResult.evidence);
        messages.push({
          role: 'user',
          content: `TOOL_RESULT\n${JSON.stringify(toolResult.result)}`,
        });
      }

      throw new Error(
        `Developer reached the ${MAX_TOOL_STEPS}-step workspace tool limit without finishing.${lastResponse ? '' : ' No model response was received.'}`,
      );
    } finally {
      agent.activeToolIds.delete(turnToolId);
      agent.activeToolStatuses.delete(turnToolId);
      agent.activeToolNames.delete(turnToolId);
      agent.isWaiting = true;
      agent.lastDataAt = Date.now();

      this.store.broadcast({ type: 'agentToolDone', id, toolId: turnToolId });
      this.store.broadcast({
        type: 'agentStatus',
        id,
        status: 'waiting',
        awaitingInput: false,
      });
    }
  }

  private executeAction(
    agentId: number,
    agent: AgentState,
    step: number,
    action: Exclude<DeveloperAction, { action: 'final' }>,
  ): { evidence: string; result: unknown } {
    const toolId = `developer-fs-${Date.now()}-${step}`;
    const pathValue = action.path ?? '.';
    const status =
      action.action === 'list'
        ? `Listing ${pathValue}`
        : action.action === 'read'
          ? `Reading ${pathValue}`
          : `Writing ${pathValue}`;
    const toolName = action.action === 'write' ? 'Write' : action.action === 'read' ? 'Read' : 'List';

    agent.activeToolIds.add(toolId);
    agent.activeToolStatuses.set(toolId, status);
    agent.activeToolNames.set(toolId, toolName);
    this.store.broadcast({
      type: 'agentToolStart',
      id: agentId,
      toolId,
      status,
      toolName,
    });

    try {
      if (action.action === 'list') {
        const entries = this.fileTools.list(action.path ?? '.');
        return {
          evidence: `LIST ${pathValue} (${entries.length} entries)`,
          result: { ok: true, action: 'list', path: pathValue, entries },
        };
      }

      if (action.action === 'read') {
        const read = this.fileTools.read(action.path);
        return {
          evidence: `READ ${read.path} (${read.bytes} bytes)`,
          result: { ok: true, action: 'read', ...read },
        };
      }

      const written = this.fileTools.write(action.path, action.content);
      return {
        evidence: `WRITE ${written.path} (${written.created ? 'created' : 'updated'}, ${written.bytes} bytes)`,
        result: { ok: true, action: 'write', ...written },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        evidence: `${action.action.toUpperCase()} ${pathValue} FAILED: ${message}`,
        result: { ok: false, action: action.action, path: pathValue, error: message },
      };
    } finally {
      agent.activeToolIds.delete(toolId);
      agent.activeToolStatuses.delete(toolId);
      agent.activeToolNames.delete(toolId);
      this.store.broadcast({ type: 'agentToolDone', id: agentId, toolId });
    }
  }

  private updateContext(agent: AgentState, agentId: number, response: AiGenerateResponse): void {
    const totalTokens = response.usage?.totalTokens;
    if (totalTokens === undefined) return;

    agent.contextTokens = totalTokens;
    this.store.broadcast({
      type: 'agentContextUsage',
      id: agentId,
      contextTokens: agent.contextTokens,
      maxContextTokens: agent.maxContextTokens,
    });
  }
}
