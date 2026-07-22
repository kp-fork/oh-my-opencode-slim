import { describe, expect, test } from 'bun:test';
import { BackgroundJobBoard } from '../utils/background-job-board';
import { createReconcileTaskTool } from './reconcile-task';

function createTool(overrides?: {
  shouldManageSession?: (sessionID: string) => boolean;
}) {
  const board = new BackgroundJobBoard();
  const tools = createReconcileTaskTool({
    backgroundJobBoard: board,
    shouldManageSession: overrides?.shouldManageSession ?? (() => true),
  });

  return { board, reconcileTask: tools.reconcile_task };
}

const context = { sessionID: 'parent-1', agent: 'orchestrator' } as any;

describe('reconcile_task tool', () => {
  test('reconciles a terminal-unreconciled task by task ID', async () => {
    const { board, reconcileTask } = createTool();
    board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
    });
    board.updateStatus({ taskID: 'ses_1', state: 'completed' });

    const output = await reconcileTask.execute({ task_id: 'ses_1' }, context);

    expect(String(output)).toContain('state: reconciled');
    expect(String(output)).toContain('Task reconciled');
    expect(board.get('ses_1')?.state).toBe('reconciled');
    expect(board.get('ses_1')?.terminalUnreconciled).toBe(false);
  });

  test('reconciles a terminal-unreconciled task by alias', async () => {
    const { board, reconcileTask } = createTool();
    board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'oracle',
    });
    board.updateStatus({ taskID: 'ses_1', state: 'completed' });

    const output = await reconcileTask.execute({ task_id: 'ora-1' }, context);

    expect(String(output)).toContain('state: reconciled');
    expect(board.get('ses_1')?.state).toBe('reconciled');
  });

  test('reconciles an errored task', async () => {
    const { board, reconcileTask } = createTool();
    board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'fixer',
    });
    board.updateStatus({ taskID: 'ses_1', state: 'error' });

    const output = await reconcileTask.execute({ task_id: 'ses_1' }, context);

    expect(String(output)).toContain('state: reconciled');
    expect(board.get('ses_1')?.state).toBe('reconciled');
  });

  test('reconciles a cancelled task', async () => {
    const { board, reconcileTask } = createTool();
    board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'fixer',
    });
    board.markCancelled('ses_1', 'obsolete');

    const output = await reconcileTask.execute({ task_id: 'ses_1' }, context);

    expect(String(output)).toContain('state: reconciled');
    expect(board.get('ses_1')?.state).toBe('reconciled');
  });

  test('includes reason in output when provided', async () => {
    const { board, reconcileTask } = createTool();
    board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
    });
    board.updateStatus({ taskID: 'ses_1', state: 'completed' });

    const output = await reconcileTask.execute(
      { task_id: 'ses_1', reason: 'result consumed' },
      context,
    );

    expect(String(output)).toContain('Reason: result consumed');
  });

  test('returns already-reconciled message for non-terminal tasks', async () => {
    const { board, reconcileTask } = createTool();
    board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
    });

    const output = await reconcileTask.execute({ task_id: 'ses_1' }, context);

    expect(String(output)).toContain('already reconciled');
    expect(String(output)).toContain('state: running');
  });

  test('returns error for unknown task ID', async () => {
    const { reconcileTask } = createTool();

    const output = await reconcileTask.execute(
      { task_id: 'ses_unknown' },
      context,
    );

    expect(String(output)).toContain('state: unknown');
    expect(String(output)).toContain('unknown or unowned');
  });

  test('does not reconcile tasks owned by a different parent', async () => {
    const { board, reconcileTask } = createTool();
    board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-2',
      agent: 'explorer',
    });
    board.updateStatus({ taskID: 'ses_1', state: 'completed' });

    const output = await reconcileTask.execute({ task_id: 'ses_1' }, context);

    expect(String(output)).toContain('state: unknown');
    expect(board.get('ses_1')?.state).toBe('completed');
    expect(board.get('ses_1')?.terminalUnreconciled).toBe(true);
  });

  test('denies non-orchestrator agents', async () => {
    const { reconcileTask } = createTool();

    await expect(
      reconcileTask.execute({ task_id: 'ses_1' }, {
        sessionID: 'parent-1',
        agent: 'fixer',
      } as any),
    ).rejects.toThrow('orchestrator');
  });

  test('denies unmanaged sessions', async () => {
    const { reconcileTask } = createTool({
      shouldManageSession: () => false,
    });

    await expect(
      reconcileTask.execute({ task_id: 'ses_1' }, context),
    ).rejects.toThrow('orchestrator sessions');
  });

  test('requires task_id', async () => {
    const { reconcileTask } = createTool();

    await expect(
      reconcileTask.execute({ task_id: '  ' }, context),
    ).rejects.toThrow('requires task_id');
  });
});
