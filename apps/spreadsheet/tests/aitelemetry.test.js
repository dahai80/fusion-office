import { describe, expect, it, beforeEach } from 'vitest';
import { recordPrompt, readPromptLog, clearPromptLog } from '../src/core/aitelemetry.js';

beforeEach(() => {
  localStorage.removeItem('fusion-office.ai-prompt-log');
});

describe('aitelemetry', () => {
  it('records prompts with time, length and attachment count, oldest first', () => {
    recordPrompt({ text: 'Build a loan calculator', attachments: 0 });
    recordPrompt({ text: 'Summarize this', attachments: 2 });
    const log = readPromptLog();
    expect(log.length).toBe(2);
    expect(log[0].text).toBe('Build a loan calculator');
    expect(log[0].chars).toBe(23);
    expect(log[1].files).toBe(2);
    expect(log[0].ts).toBeLessThanOrEqual(log[1].ts);
  });

  it('keeps only the newest 200 prompts', () => {
    for (let i = 0; i < 205; i++) recordPrompt({ text: `prompt ${i}` });
    const log = readPromptLog();
    expect(log.length).toBe(200);
    expect(log[0].text).toBe('prompt 5');
    expect(log.at(-1).text).toBe('prompt 204');
  });

  it('records nothing for an empty prompt and clears fully', () => {
    recordPrompt({ text: '   ' });
    expect(readPromptLog().length).toBe(0);
    recordPrompt({ text: 'keep' });
    clearPromptLog();
    expect(readPromptLog().length).toBe(0);
  });

  it('survives a corrupt log without losing the session', () => {
    localStorage.setItem('fusion-office.ai-prompt-log', '{not json');
    recordPrompt({ text: 'after corrupt' });
    const log = readPromptLog();
    expect(log.length).toBe(1);
    expect(log[0].text).toBe('after corrupt');
  });
});
