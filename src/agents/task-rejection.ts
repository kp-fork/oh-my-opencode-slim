export const TASK_REJECTION_INSTRUCTION = `If an assignment is outside your role, permissions, or available context, reject it rather than partially attempting it. Respond exactly:
<task_rejection>
<reason>brief explanation for the orchestrator</reason>
</task_rejection>`;

export function appendTaskRejectionInstruction(prompt: string): string {
  return `${prompt}\n\n${TASK_REJECTION_INSTRUCTION}`;
}
