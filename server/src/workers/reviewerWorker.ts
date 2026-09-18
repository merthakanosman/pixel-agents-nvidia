import type {
  AiGenerateResponse,
  AiMessage,
  AiProvider,
} from '../../../core/src/provider.js';
import type { AgentStateStore } from '../agentStateStore.js';
import { DEFAULT_MAX_CONTEXT_TOKENS } from '../constants.js';
import { SafeGitInspector } from '../tools/safeGitInspector.js';
import { WorkspaceFileTools } from '../tools/workspaceFileTools.js';
import type { AgentState } from '../types.js';

const REVIEWER_AGENT_ID = 100_004;
const MAX_TOOL_STEPS = 10;
const MAX_MODEL_OUTPUT_CHARS = 24_000;

type ReviewerAction =
  | { action: 'list'; path?: string }
  | { action: 'read'; path: string }
  | { action: 'final'; summary: string };

type ReviewerGitAction = 'status' | 'diff';

const REVIEWER_SYSTEM_PROMPT = `You are the Reviewer in an autonomous AI software company.
Your job is to independently review implementation and test evidence before work is reported as complete.

For EVERY turn, respond with exactly one JSON object and no markdown.

Allowed actions:
{"action":"list","path":"."}
{"action":"read","path":"relative/file.ts"}
{"action":"final","summary":"Turkish evidence-based review report"}

Rules:
- STATUS and DIFF are executed automatically before your first model turn and their real TOOL_RESULT evidence is already provided to you.
- Do not request status or diff actions yourself.
- Use real workspace evidence for implementation or code review.
- Use list/read only when you need surrounding code or an untracked file that is not present in the automatic diff output.
- Paths must be relative to the workspace.
- Never request or expose secrets.
- You are read-only. Never modify files and never run arbitrary shell or git mutation commands.
- Look for correctness, maintainability, security, data integrity, missing requirements, and unsupported claims.
- Do not approve work merely because another worker says it is complete.
- Do not claim code was inspected unless STATUS, DIFF, READ, or LIST tool evidence confirms it.
- Do not invent files, changes, test results, or findings not present in tool results or supplied evidence.
- If git inspection fails, report the review as incomplete rather than guessing.
- Finish with a concise Turkish report containing: verdict, inspected evidence, blocking issues, non-blocking issues, and required next action.`;

function extractJsonObject(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed;

  const fenced = trimmed.match(/\`\`\`(?:json)?\s*([\s\S]*?)\s*\`\`\`/i);
  if (fenced?.[1]) return fenced[1].trim();

  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('Reviewer did not return a JSON action.');
  }
  return trimmed.slice(start, end + 1);
}

function parseAction(text: string): ReviewerAction {
  const value = JSON.parse(extractJsonObject(text)) as Record<string, unknown>;
  const action = value['action'];

  if (action === 'list') {
    const rawPath = value['path'];
    if (rawPath !== undefined && typeof rawPath !== 'string') {
      throw new Error('Reviewer list action path must be a string.');
    }
    return { action, path: rawPath ?? '.' };
  }

  if (action === 'read') {
    if (typeof value['path'] !== 'string' || !value['path']) {
      throw new Error('Reviewer read action requires a path.');
    }
    return { action, path: value['path'] };
  }

  if (action === 'final') {
    if (typeof value['summary'] !== 'string' || !value['summary'].trim()) {
      throw new Error('Reviewer final action requires a summary.');
    }
    return { action, summary: value['summary'].trim() };
  }

  throw new Error('Reviewer returned an unsupported action.');
}

function compactOutput(value: string): string {
  if (value.length <= MAX_MODEL_OUTPUT_CHARS) return value;
  return `[output truncated for model context]\n${value.slice(-MAX_MODEL_OUTPUT_CHARS)}`;
}

export class ReviewerWorker {
  private agentId: number | null = null;
  private readonly fileTools: WorkspaceFileTools;
  private readonly gitInspector: SafeGitInspector;

  constructor(
    private readonly store: AgentStateStore,
    private readonly provider: AiProvider,
    private readonly model: string,
    private readonly projectDir: string,
  ) {
    this.fileTools = new WorkspaceFileTools(projectDir);
    this.gitInspector = new SafeGitInspector(projectDir);
  }

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

    const turnToolId = `reviewer-turn-${Date.now()}`;
    agent.activeToolIds.add(turnToolId);
    agent.activeToolStatuses.set(turnToolId, 'Reviewing work');
    agent.activeToolNames.set(turnToolId, 'Reviewing');
    agent.isWaiting = false;
    agent.lastDataAt = Date.now();

    this.store.broadcast({
      type: 'agentToolStart',
      id,
      toolId: turnToolId,
      status: 'Reviewing work',
      toolName: 'Reviewing',
    });
    this.store.broadcast({ type: 'agentStatus', id, status: 'active' });

    try {
      const messages: AiMessage[] = [
        { role: 'system', content: REVIEWER_SYSTEM_PROMPT },
        {
          role: 'user',
          content: `Workspace root: ${this.fileTools.getRoot()}\n\nAssigned review task:\n${task}`,
        },
      ];
      const evidence: string[] = [];

      for (const gitAction of ['status', 'diff'] as const) {
        const toolResult = await this.executeGitInspection(id, agent, gitAction);
        evidence.push(toolResult.evidence);
        messages.push({
          role: 'user',
          content: `TOOL_RESULT\n${JSON.stringify(toolResult.result)}`,
        });
      }

      for (let step = 0; step < MAX_TOOL_STEPS; step++) {
        const response = await this.provider.generate({
          model: this.model,
          messages,
          temperature: 0.1,
          maxTokens: 2600,
        });
        this.updateContext(agent, id, response);

        let action: ReviewerAction;
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
          const evidenceText =
            evidence.length > 0
              ? evidence.map((entry) => `- ${entry}`).join('\n')
              : '- Gerçek workspace inceleme aracı kullanılmadı.';

          return {
            ...response,
            content: `${action.summary}\n\nİnceleme kanıtı:\n${evidenceText}`,
          };
        }

        const toolResult = await this.executeAction(id, agent, step, action);
        evidence.push(toolResult.evidence);
        messages.push({
          role: 'user',
          content: `TOOL_RESULT\n${JSON.stringify(toolResult.result)}`,
        });
      }

      throw new Error(
        `Reviewer reached the ${MAX_TOOL_STEPS}-step inspection tool limit without finishing.`,
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

  private async executeAction(
    agentId: number,
    agent: AgentState,
    step: number,
    action: Exclude<ReviewerAction, { action: 'final' }>,
  ): Promise<{ evidence: string; result: unknown }> {
    const toolId = `reviewer-tool-${Date.now()}-${step}`;
    const status =
      action.action === 'list'
        ? `Listing ${action.path ?? '.'}`
        : `Reading ${action.path}`;
    const toolName = action.action === 'read' ? 'Read' : 'List';

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
          evidence: `LIST ${action.path ?? '.'} (${entries.length} entries)`,
          result: { ok: true, action: 'list', path: action.path ?? '.', entries },
        };
      }

      if (action.action === 'read') {
        const read = this.fileTools.read(action.path);
        return {
          evidence: `READ ${read.path} (${read.bytes} bytes)`,
          result: {
            ok: true,
            action: 'read',
            path: read.path,
            bytes: read.bytes,
            content: compactOutput(read.content),
          },
        };
      }

      throw new Error('Unsupported Reviewer workspace action.');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const target = action.path ?? '.';
      return {
        evidence: `${action.action.toUpperCase()} ${target} FAILED: ${message}`,
        result: { ok: false, action: action.action, error: message },
      };
    } finally {
      agent.activeToolIds.delete(toolId);
      agent.activeToolStatuses.delete(toolId);
      agent.activeToolNames.delete(toolId);
      this.store.broadcast({ type: 'agentToolDone', id: agentId, toolId });
    }
  }

  private async executeGitInspection(
    agentId: number,
    agent: AgentState,
    action: ReviewerGitAction,
  ): Promise<{ evidence: string; result: unknown }> {
    const toolId = `reviewer-git-${Date.now()}-${action}`;
    const status = action === 'status' ? 'Inspecting git status' : 'Inspecting git diff';
    const toolName = action === 'status' ? 'Git Status' : 'Git Diff';

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
      const inspection =
        action === 'status'
          ? await this.gitInspector.status()
          : await this.gitInspector.diff();
      const ok = inspection.exitCode === 0 && !inspection.timedOut;

      return {
        evidence: `${action.toUpperCase()} exit=${String(inspection.exitCode)} duration=${inspection.durationMs}ms timedOut=${String(inspection.timedOut)} truncated=${String(inspection.outputTruncated)}`,
        result: {
          ok,
          action,
          ...inspection,
          stdout: compactOutput(inspection.stdout),
          stderr: compactOutput(inspection.stderr),
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        evidence: `${action.toUpperCase()} FAILED: ${message}`,
        result: { ok: false, action, error: message },
      };
    } finally {
      agent.activeToolIds.delete(toolId);
      agent.activeToolStatuses.delete(toolId);
      agent.activeToolNames.delete(toolId);
      this.store.broadcast({ type: 'agentToolDone', id: agentId, toolId });
    }
  }

  private updateContext(
    agent: AgentState,
    agentId: number,
    response: AiGenerateResponse,
  ): void {
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
