import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const originalOpenAIKey = process.env.OPENAI_API_KEY;

beforeEach(() => {
    delete process.env.OPENAI_API_KEY;
    vi.resetModules();
});

afterEach(() => {
    if (originalOpenAIKey === undefined) {
        delete process.env.OPENAI_API_KEY;
    } else {
        process.env.OPENAI_API_KEY = originalOpenAIKey;
    }
});

describe('optional OpenAI transcription client', () => {
    it('does not require OpenAI credentials when the module loads', async () => {
        await expect(import('../index')).resolves.toBeDefined();
    });

    it('reports the missing credential when OpenAI transcription is invoked', async () => {
        const { transcribeAudio } = await import('../index');

        await expect(
            transcribeAudio('/tmp/pagelm-missing-audio', 'openai'),
        ).rejects.toThrow('OpenAI API key not configured');
    });
});
