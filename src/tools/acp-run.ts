import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { type ToolDefinition, tool } from '@opencode-ai/plugin';
import type { AcpAgentConfig, AcpAgentsConfig } from '../config';

const z = tool.schema;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

interface RpcResponse {
  id: number;
  result?: Json;
  error?: { message?: string };
}

interface RpcRequest {
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface RpcNotification {
  method: string;
  params?: Record<string, unknown>;
}

type Pending = {
  resolve: (value: Json | undefined) => void;
  reject: (error: Error) => void;
};

class AcpClient {
  private child: ChildProcessWithoutNullStreams;
  private next = 1;
  private pending = new Map<number, Pending>();
  private chunks: string[] = [];
  private errors: string[] = [];

  constructor(
    private name: string,
    private config: AcpAgentConfig,
    private cwd: string,
    private ask: (
      title: string,
      metadata: Record<string, unknown>,
    ) => Promise<void>,
  ) {
    this.child = spawn(config.command, config.args, {
      cwd,
      env: { ...process.env, ...config.env },
      stdio: 'pipe',
    });
    this.child.stderr.on('data', (chunk) => {
      this.errors.push(String(chunk));
    });
    this.child.on('error', (error) => {
      for (const item of this.pending.values()) item.reject(error);
      this.pending.clear();
    });
    this.child.on('exit', (code, signal) => {
      if (this.pending.size === 0) return;
      const error = new Error(
        `ACP agent '${name}' exited before replying (code ${code ?? 'null'}, signal ${signal ?? 'null'})`,
      );
      for (const item of this.pending.values()) item.reject(error);
      this.pending.clear();
    });

    createInterface({ input: this.child.stdout }).on('line', (line) => {
      this.receive(line).catch((error) => {
        this.errors.push(String(error));
      });
    });
  }

  async run(prompt: string): Promise<string> {
    await this.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: {
        name: 'oh-my-opencode-slim',
        title: 'oh-my-opencode-slim ACP bridge',
      },
    });
    const created = await this.request('session/new', {
      cwd: this.cwd,
      mcpServers: [],
    });
    const sessionId = readSessionId(created);
    await this.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: prompt }],
    });
    return this.output();
  }

  close(): void {
    if (!this.child.killed) this.child.kill('SIGTERM');
  }

  private request(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Json | undefined> {
    const id = this.next++;
    const payload = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify(payload)}\n`, (error) => {
        if (!error) return;
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  private async receive(line: string): Promise<void> {
    if (!line.trim()) return;
    const message = JSON.parse(line) as
      | RpcResponse
      | RpcRequest
      | RpcNotification;
    if ('id' in message && ('result' in message || 'error' in message)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(
          new Error(message.error.message ?? 'ACP request failed'),
        );
        return;
      }
      pending.resolve(message.result);
      return;
    }
    if ('id' in message && 'method' in message) {
      await this.handleRequest(message);
      return;
    }
    if ('method' in message) this.handleNotification(message);
  }

  private async handleRequest(message: RpcRequest): Promise<void> {
    if (message.method === 'session/request_permission') {
      const title = readPermissionTitle(message.params);
      if (this.config.permissionMode === 'ask') {
        await this.ask(title, message.params ?? {});
      }
      const optionId = selectPermissionOption(
        message.params,
        this.config.permissionMode,
      );
      this.reply(message.id, { outcome: { outcome: 'selected', optionId } });
      return;
    }
    this.replyError(
      message.id,
      `Unsupported ACP client method: ${message.method}`,
    );
  }

  private handleNotification(message: RpcNotification): void {
    if (message.method !== 'session/update') return;
    const update = message.params?.update;
    if (!isRecord(update)) return;
    collectText(update, this.chunks);
  }

  private reply(id: number, result: Json): void {
    this.child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`,
    );
  }

  private replyError(id: number, message: string): void {
    this.child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message } })}\n`,
    );
  }

  private output(): string {
    const text = this.chunks.join('').trim();
    if (text) return text;
    const err = this.errors.join('').trim();
    return err
      ? `ACP agent '${this.name}' completed without text output. stderr:\n${err}`
      : `ACP agent '${this.name}' completed without text output.`;
  }
}

export function createAcpRunTool(agents: AcpAgentsConfig = {}): ToolDefinition {
  return tool({
    description:
      'Run a configured external ACP-compatible coding agent and return its streamed result. Use for configured ACP agents such as Claude Code ACP, Gemini ACP, or custom ACP servers.',
    args: {
      agent: z.string().describe('Configured ACP agent name'),
      prompt: z.string().describe('Task or question to send to the ACP agent'),
      cwd: z
        .string()
        .optional()
        .describe('Optional absolute working directory override'),
      timeout_ms: z
        .number()
        .int()
        .min(1000)
        .max(900000)
        .optional()
        .describe('Optional timeout override in milliseconds'),
    },
    async execute(args, ctx) {
      const config = agents[args.agent];
      if (!config) {
        throw new Error(
          `Unknown ACP agent '${args.agent}'. Configured agents: ${Object.keys(agents).join(', ') || '(none)'}`,
        );
      }
      const cwd = args.cwd ?? config.cwd ?? ctx.directory;
      if (!cwd) throw new Error('acp_run requires a working directory');

      await ctx.ask({
        permission: 'bash',
        patterns: [`${config.command} ${config.args.join(' ')}`.trim()],
        always: [],
        metadata: {
          agent: args.agent,
          cwd,
          command: config.command,
          args: config.args,
        },
      });

      const client = new AcpClient(
        args.agent,
        config,
        cwd,
        async (title, metadata) => {
          if (config.permissionMode === 'reject') return;
          await ctx.ask({
            permission: 'bash',
            patterns: [`acp:${args.agent}:${title}`],
            always: [],
            metadata,
          });
        },
      );
      const timeoutMs = args.timeout_ms ?? config.timeoutMs;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<string>(
        (_, reject) =>
          (timer = setTimeout(
            () =>
              reject(
                new Error(
                  `ACP agent '${args.agent}' timed out after ${timeoutMs}ms`,
                ),
              ),
            timeoutMs,
          )),
      );
      const abort = () => client.close();
      ctx.abort.addEventListener('abort', abort, { once: true });
      try {
        return await Promise.race([client.run(args.prompt), timeout]);
      } finally {
        if (timer) clearTimeout(timer);
        ctx.abort.removeEventListener('abort', abort);
        client.close();
      }
    },
  });
}

function readSessionId(value: Json | undefined): string {
  if (!isRecord(value) || typeof value.sessionId !== 'string') {
    throw new Error('ACP agent did not return a sessionId');
  }
  return value.sessionId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readPermissionTitle(
  params: Record<string, unknown> | undefined,
): string {
  const tool = isRecord(params?.toolCall) ? params.toolCall : undefined;
  if (typeof tool?.title === 'string') return tool.title;
  if (typeof params?.permission === 'string') return params.permission;
  return 'ACP permission request';
}

function selectPermissionOption(
  params: Record<string, unknown> | undefined,
  mode: AcpAgentConfig['permissionMode'],
): string {
  const options = Array.isArray(params?.options) ? params.options : [];
  const ids = options
    .filter(isRecord)
    .map((item) => item.optionId)
    .filter((item): item is string => typeof item === 'string');
  if (mode === 'reject')
    return ids.find((id) => id.includes('reject')) ?? 'reject';
  return (
    ids.find((id) => id.includes('allow') || id === 'once') ??
    ids.find((id) => !id.includes('reject')) ??
    'allow'
  );
}

function collectText(update: Record<string, unknown>, chunks: string[]): void {
  for (const key of ['content', 'delta']) {
    const value = update[key];
    if (typeof value === 'string') chunks.push(value);
    if (isRecord(value) && typeof value.text === 'string')
      chunks.push(value.text);
  }
}
