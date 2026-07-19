import { describe, expect, test } from 'bun:test';
import { buildOrchestratorPrompt } from './orchestrator';

describe('orchestrator prompt', () => {
  test('requires the question tool for blocking user input', () => {
    const prompt = buildOrchestratorPrompt();

    expect(prompt).toContain('use the `question` tool');
    expect(prompt).toContain('Enable custom input');
    expect(prompt).toContain('concise pasted response or command output');
    expect(prompt).toContain('small bounded set of options');
    expect(prompt).toContain('ordinary dialogue that does not block work');
  });

  test('treats task rejections as routing signals', () => {
    const prompt = buildOrchestratorPrompt();

    expect(prompt).toContain('Treat `<task_rejection>` as a routing signal');
    expect(prompt).toContain('inspect only its `<reason>`');
    expect(prompt).not.toContain('recommended_agent');
    expect(prompt).toContain(
      'Never reissue an unchanged task to the same agent',
    );
  });
});
