import { log } from './logger';

// Cache: model ID → supports image input
const visionCache = new Map<string, boolean>();

/**
 * Check if a model supports image/vision input by querying OpenCode's
 * provider API. Results are cached for the session lifetime.
 *
 * Falls back to `true` (assume vision-capable) if the API is unavailable,
 * to avoid unnecessarily stripping images from capable models.
 */
export async function modelSupportsImage(
  client: import('@opencode-ai/plugin').PluginInput['client'],
  modelId: string,
): Promise<boolean> {
  const cached = visionCache.get(modelId);
  if (cached !== undefined) {
    return cached;
  }

  try {
    // Parse "provider/model" format
    const slashIndex = modelId.indexOf('/');
    if (slashIndex === -1) {
      log('[vision] cannot parse model ID, assuming vision-capable', {
        modelId,
      });
      visionCache.set(modelId, true);
      return true;
    }

    const providerID = modelId.substring(0, slashIndex);
    const modelID = modelId.substring(slashIndex + 1);

    // Query provider list from OpenCode
    const result = await client.provider.list({});

    if (result.error) {
      log('[vision] provider list query failed, assuming vision-capable', {
        modelId,
        error: String(result.error),
      });
      visionCache.set(modelId, true);
      return true;
    }

    const providers = result.data?.all ?? [];
    const provider = providers.find(
      (p: { id?: string }) => p.id === providerID,
    );

    if (!provider?.models) {
      log('[vision] provider not found, assuming vision-capable', {
        modelId,
        providerID,
      });
      visionCache.set(modelId, true);
      return true;
    }

    const model = provider.models[modelID];
    if (!model) {
      log('[vision] model not found in provider, assuming vision-capable', {
        modelId,
        providerID,
        modelID,
      });
      visionCache.set(modelId, true);
      return true;
    }

    // Check capabilities.input.image or modalities.input includes "image"
    let supportsImage = false;

    // SDK v2 shape: capabilities.input.image: boolean
    const capabilities = (model as Record<string, unknown>).capabilities;
    if (capabilities && typeof capabilities === 'object') {
      const input = (capabilities as Record<string, unknown>).input;
      if (input && typeof input === 'object') {
        const imageFlag = (input as Record<string, unknown>).image;
        if (typeof imageFlag === 'boolean') {
          supportsImage = imageFlag;
        }
      }
    }

    // Fallback: modalities.input includes "image"
    if (!supportsImage) {
      const modalities = (model as Record<string, unknown>).modalities;
      if (modalities && typeof modalities === 'object') {
        const input = (modalities as Record<string, unknown>).input;
        if (Array.isArray(input)) {
          supportsImage = input.some(
            (m: unknown) =>
              typeof m === 'string' && m.toLowerCase() === 'image',
          );
        }
      }
    }

    log('[vision] resolved model vision capability', {
      modelId,
      supportsImage,
    });
    visionCache.set(modelId, supportsImage);
    return supportsImage;
  } catch (error) {
    log('[vision] error checking vision capability, assuming vision-capable', {
      modelId,
      error: error instanceof Error ? error.message : String(error),
    });
    visionCache.set(modelId, true);
    return true;
  }
}

/** Clear the vision capability cache (for testing). */
export function clearVisionCache(): void {
  visionCache.clear();
}
