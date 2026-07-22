import { type ToolDefinition, tool } from '@opencode-ai/plugin';
import type { BackgroundJobStore } from '../utils/background-job-store';
import { log } from '../utils/logger';

const z = tool.schema;

interface ReconcileTaskToolOptions {
  backgroundJobBoard: BackgroundJobStore;
  shouldManageSession: (sessionID: string) => boolean;
}

export function createReconcileTaskTool(
  options: ReconcileTaskToolOptions,
): Record<string, ToolDefinition> {
  const reconcile_task = tool({
    description: `Reconcile a completed background specialist task in the Background Job Board.

Marks a terminal (completed, error, or cancelled) task as reconciled so it no longer appears as unreconciled.
This is a state-only operation — it does not invoke or resume any specialist session.
Use when a terminal task result has been received and consumed, before issuing a final response.

Accepts either the native task_id/session ID or the parent-scoped alias shown in the Background Job Board.`,
    args: {
      task_id: z
        .string()
        .describe(
          'Background task ID or Background Job Board alias to reconcile',
        ),
      reason: z
        .string()
        .optional()
        .describe('Optional short reason for reconciliation'),
    },
    async execute(args, toolContext) {
      const parentSessionID = toolContext?.sessionID;
      if (!parentSessionID)
        throw new Error('reconcile_task requires sessionID');
      if (toolContext.agent && toolContext.agent !== 'orchestrator') {
        throw new Error('reconcile_task can only be used by orchestrator');
      }
      if (!options.shouldManageSession(parentSessionID)) {
        throw new Error(
          'reconcile_task can only be used in orchestrator sessions',
        );
      }

      const requested = args.task_id.trim();
      if (!requested) throw new Error('reconcile_task requires task_id');

      const job = options.backgroundJobBoard.resolve(
        parentSessionID,
        requested,
      );
      log('[reconcile-task] request received', {
        parentSessionID,
        requested,
        resolvedTaskID: job?.taskID,
        alias: job
          ? options.backgroundJobBoard.field(job.taskID, 'alias')
          : undefined,
        state: job
          ? options.backgroundJobBoard.field(job.taskID, 'state')
          : undefined,
        terminalUnreconciled: job
          ? options.backgroundJobBoard.field(job.taskID, 'terminalUnreconciled')
          : undefined,
      });

      if (!job) {
        log('[reconcile-task] unknown or unowned task', {
          parentSessionID,
          requested,
        });
        return [
          `task_id: ${requested}`,
          'state: unknown',
          '',
          '<task_error>',
          'unknown or unowned background task',
          '</task_error>',
        ].join('\n');
      }

      if (!job.terminalUnreconciled) {
        const state = options.backgroundJobBoard.getState(job.taskID);
        log('[reconcile-task] task already reconciled or not terminal', {
          taskID: job.taskID,
          state,
        });
        return [
          `task_id: ${job.taskID}`,
          `state: ${state ?? 'unknown'}`,
          '',
          'Task is already reconciled or not in a terminal state.',
        ].join('\n');
      }

      const updated = options.backgroundJobBoard.markReconciled(job.taskID);
      log('[reconcile-task] marked reconciled', {
        taskID: job.taskID,
        alias: options.backgroundJobBoard.field(job.taskID, 'alias'),
        previousTerminalState: job.terminalState,
        reason: args.reason,
      });

      const finalState = updated?.state ?? 'reconciled';
      return [
        `task_id: ${job.taskID}`,
        `state: ${finalState}`,
        '',
        `Task reconciled.${args.reason ? ` Reason: ${args.reason}` : ''}`,
      ].join('\n');
    },
  });

  return { reconcile_task };
}
