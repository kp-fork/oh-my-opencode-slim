import { describe, expect, test } from 'bun:test';
import { TASK_REJECTION_INSTRUCTION } from './task-rejection';

describe('task rejection instruction', () => {
  test('requires only a reason in the rejection response', () => {
    expect(
      TASK_REJECTION_INSTRUCTION,
    ).toBe(`If an assignment is outside your role, permissions, or available context, reject it rather than partially attempting it. Respond exactly:
<task_rejection>
<reason>brief explanation for the orchestrator</reason>
</task_rejection>`);
    expect(TASK_REJECTION_INSTRUCTION).not.toContain('recommended_agent');
  });
});
