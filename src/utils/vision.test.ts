import { describe, expect, test } from 'bun:test';
import { clearVisionCache, modelSupportsImage } from './vision';

describe('modelSupportsImage', () => {
  test('returns true for unparseable model ID (safe default)', async () => {
    clearVisionCache();
    const mockClient = {
      provider: { list: async () => ({ error: true }) },
    } as never;
    const result = await modelSupportsImage(mockClient, 'unknown-model');
    expect(result).toBe(true);
  });

  test('returns true when provider list fails (safe default)', async () => {
    clearVisionCache();
    const mockClient = {
      provider: {
        list: async () => ({ error: { message: 'fail' } }),
      },
    } as never;
    const result = await modelSupportsImage(mockClient, 'openai/gpt-5.4-mini');
    expect(result).toBe(true);
  });

  test('returns true when provider not found (safe default)', async () => {
    clearVisionCache();
    const mockClient = {
      provider: {
        list: async () => ({
          error: undefined,
          data: { all: [{ id: 'anthropic', models: {} }] },
        }),
      },
    } as never;
    const result = await modelSupportsImage(mockClient, 'openai/gpt-5.4-mini');
    expect(result).toBe(true);
  });

  test('detects vision from capabilities.input.image', async () => {
    clearVisionCache();
    const mockClient = {
      provider: {
        list: async () => ({
          error: undefined,
          data: {
            all: [
              {
                id: 'openai',
                models: {
                  'gpt-5.4-mini': {
                    capabilities: {
                      input: { text: true, image: true },
                      output: { text: true },
                    },
                  },
                },
              },
            ],
          },
        }),
      },
    } as never;
    const result = await modelSupportsImage(mockClient, 'openai/gpt-5.4-mini');
    expect(result).toBe(true);
  });

  test('detects no vision from capabilities.input.image = false', async () => {
    clearVisionCache();
    const mockClient = {
      provider: {
        list: async () => ({
          error: undefined,
          data: {
            all: [
              {
                id: 'openai',
                models: {
                  'text-embedding-3-large': {
                    capabilities: {
                      input: { text: true, image: false },
                      output: { text: true },
                    },
                  },
                },
              },
            ],
          },
        }),
      },
    } as never;
    const result = await modelSupportsImage(
      mockClient,
      'openai/text-embedding-3-large',
    );
    expect(result).toBe(false);
  });

  test('detects vision from modalities.input array', async () => {
    clearVisionCache();
    const mockClient = {
      provider: {
        list: async () => ({
          error: undefined,
          data: {
            all: [
              {
                id: 'google',
                models: {
                  'gemini-2.5-pro': {
                    modalities: {
                      input: ['text', 'image', 'video'],
                      output: ['text'],
                    },
                  },
                },
              },
            ],
          },
        }),
      },
    } as never;
    const result = await modelSupportsImage(
      mockClient,
      'google/gemini-2.5-pro',
    );
    expect(result).toBe(true);
  });

  test('caches results', async () => {
    clearVisionCache();
    let callCount = 0;
    const mockClient = {
      provider: {
        list: async () => {
          callCount++;
          return {
            error: undefined,
            data: {
              all: [
                {
                  id: 'openai',
                  models: {
                    'gpt-5.4-mini': {
                      capabilities: { input: { image: true } },
                    },
                  },
                },
              ],
            },
          };
        },
      },
    } as never;
    await modelSupportsImage(mockClient, 'openai/gpt-5.4-mini');
    await modelSupportsImage(mockClient, 'openai/gpt-5.4-mini');
    expect(callCount).toBe(1);
  });
});
