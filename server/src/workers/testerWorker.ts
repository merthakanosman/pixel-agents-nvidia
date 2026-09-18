import type {
  AiGenerateResponse,
  AiMessage,
  AiProvider,
} from '../../../core/src/provider.js';
import type { AgentStateStore } from '../agentStateStore.js';
import { DEFAULT_MAX_CONTEXT_TOKENS } from '../constants.js';
import { SafeTestRunner } from '../tools/safeTestRunner.js';
import { WorkspaceFileTools } from '../tools/workspaceFileTools.js';
import type { AgentState } from '../types.js';

const TESTER_AGENT_ID = 100_003;
const MAX_TOOL_STEPS = 10;
const MAX_MODEL_OUTPUT_CHARS = 24_000;

type TesterAction =
  | { action: 'list'; path?: string }
  | { action: 'read'; path: string }
  | {
      action: 'run';
      command: 'npm';
      args: string[];
      cwd?: string;
      timeoutMs?: number;
    }
  | { action: 'final'; summary: string };

const TESTER_SYSTEM_PROMPT = `You are the Tester in an autonomous AI software company.
Your job is to validate assigned work using real workspace inspection and real test commands.

For EVERY turn, respond with exactly one JSON object and no markdown.

Allowed actions:
{"action":"list","path":"."}
{"action":"read","path":"package.json"}
{"action":"run","command":"npm","args":["test","--","safeTestRunner.test.ts"],"cwd":"."}
{"action":"run","command":"npm","args":["test","--","specific.test.ts"],"cwd":"server"}
{"action":"run","command":"npm","args":["run","check-types"],"cwd":"."}
{"action":"final","summary":"Turkish evidence-based test report"}

Rules:
- Inspect package.json or relevant files when needed before choosing a command.
- Prefer the smallest relevant test command. Do not run broad build/test suites without a reason.
- The terminal runtime only permits npm test and approved npm run test/lint/typecheck/build quality scripts.
- cwd must always be relative to the workspace root.
- Use "." for the workspace root.
- Never copy the absolute "Workspace root" path into cwd.
- When the user specifies an exact command, run that exact command unless the runtime rejects it.
- Never use install, publish, git, curl, shell operators, redirection, or destructive commands.
- Never claim a test passed unless a RUN tool result has exitCode 0.
- If a RUN action returns ok:false, that command did not successfully execute.
- Never infer test counts, exit codes, signals, stdout, or stderr that are not present in TOOL_RESULT.
- A failing or timed-out command must be reported as failure/incomplete, not success.
- Do not modify files. Tester has read/list/run tools only.
- Finish with a concise Turkish report containing tested scope, actual command evidence, findings, risks, and next action.`;

function extractJsonObject(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed;

  const fenced = trimmed.match(/\`\`\`(?:json)?\s*([\s\S]*?)\s*\`\`\`/i);
  if (fenced?.[1]) return fenced[1].trim();

  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('Tester did not return a JSON action.');
  }
  return trimmed.slice(start, end + 1);
}

function parseAction(text: string): TesterAction {
  const value = JSON.parse(extractJsonObject(text)) as Record<string, unknown>;
  const action = value['action'];

  if (action === 'list') {
    const rawPath = value['path'];
    if (rawPath !== undefined && typeof rawPath !== 'string') {
      throw new Error('Tester list action path must be a string.');
    }
    return { action, path: rawPath ?? '.' };
  }

  if (action === 'read') {
    if (typeof value['path'] !== 'string' || !value['path']) {
      throw new Error('Tester read action requires a path.');
    }
    return { action, path: value['path'] };
  }

  if (action === 'run') {
    if (value['command'] !== 'npm') {
      throw new Error('Tester run action supports only npm.');
    }
    if (!Array.isArray(value['args']) || !value['args'].every((arg) => typeof arg === 'string')) {
      throw new Error('Tester run action requires a string args array.');
    }

    const cwd = value['cwd'];
    if (cwd !== undefined && typeof cwd !== 'string') {
      throw new Error('Tester run cwd must be a string.');
    }

    const timeoutMs = value['timeoutMs'];
    if (timeoutMs !== undefined && typeof timeoutMs !== 'number') {
      throw new Error('Tester run timeoutMs must be a number.');
    }

    return {
      action,
      command: 'npm',
      args: value['args'] as string[],
      ...(cwd !== undefined ? { cwd } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    };
  }

  if (action === 'final') {
    if (typeof value['summary'] !== 'string' || !value['summary'].trim()) {
      throw new Error('Tester final action requires a summary.');
    }
    return { action, summary: value['summary'].trim() };
  }

  throw new Error('Tester returned an unsupported action.');
}

function compactOutput(value: string): string {
  if (value.length <= MAX_MODEL_OUTPUT_CHARS) return value;
  return `[output truncated for model context]\n${value.slice(-MAX_MODEL_OUTPUT_CHARS)}`;
}

export class TesterWorker {
  private agentId: number | null = null;
  private readonly fileTools: WorkspaceFileTools;
  private readonly testRunner: SafeTestRunner;

  constructor(
    private readonly store: AgentStateStore,
    private readonly provider: AiProvider,
    private readonly model: string,
    private readonly projectDir: string,
  ) {
    this.fileTools = new WorkspaceFileTools(projectDir);
    this.testRunner = new SafeTestRunner(projectDir);
  }

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

    const turnToolId = `tester-turn-${Date.now()}`;
    agent.activeToolIds.add(turnToolId);
    agent.activeToolStatuses.set(turnToolId, 'Testing work');
    agent.activeToolNames.set(turnToolId, 'Testing');
    agent.isWaiting = false;
    agent.lastDataAt = Date.now();

    this.store.broadcast({
      type: 'agentToolStart',
      id,
      toolId: turnToolId,
      status: 'Testing work',
      toolName: 'Testing',
    });
    this.store.broadcast({ type: 'agentStatus', id, status: 'active' });

    try {
      const messages: AiMessage[] = [
        { role: 'system', content: TESTER_SYSTEM_PROMPT },
        {
          role: 'user',
          content: `Workspace root: ${this.fileTools.getRoot()}\n\nAssigned validation task:\n${task}`,
        },
      ];
      const evidence: string[] = [];

      for (let step = 0; step < MAX_TOOL_STEPS; step++) {
        const response = await this.provider.generate({
          model: this.model,
          messages,
          temperature: 0.1,
          maxTokens: 2600,
        });
        this.updateContext(agent, id, response);

        let action: TesterAction;
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
              : '- Gerçek test komutu çalıştırılmadı.';

          return {
            ...response,
            content: `${action.summary}\n\nTerminal/test kanıtı:\n${evidenceText}`,
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
        `Tester reached the ${MAX_TOOL_STEPS}-step tool limit without finishing.`,
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
    action: Exclude<TesterAction, { action: 'final' }>,
  ): Promise<{ evidence: string; result: unknown }> {
    const toolId = `tester-tool-${Date.now()}-${step}`;
    const status =
      action.action === 'list'
        ? `Listing ${action.path ?? '.'}`
        : action.action === 'read'
          ? `Reading ${action.path}`
          : `Running ${action.command} ${action.args.join(' ')}`;
    const toolName =
      action.action === 'run' ? 'Bash' : action.action === 'read' ? 'Read' : 'List';

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
          result: { ok: true, action: 'read', ...read },
        };
      }

      const run = await this.testRunner.run(
        action.command,
        action.args,
        action.cwd ?? '.',
        action.timeoutMs,
      );
      const passed = run.exitCode === 0 && !run.timedOut && !run.outputTruncated;
      return {
        evidence: `RUN ${run.command} cwd=${run.cwd} exit=${String(run.exitCode)} duration=${run.durationMs}ms timedOut=${String(run.timedOut)} truncated=${String(run.outputTruncated)}`,
        result: {
          ok: passed,
          action: 'run',
          ...run,
          stdout: compactOutput(run.stdout),
          stderr: compactOutput(run.stderr),
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const target =
        action.action === 'run'
          ? `${action.command} ${action.args.join(' ')}`
          : action.path ?? '.';
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
