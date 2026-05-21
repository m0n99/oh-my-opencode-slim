import { existsSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  type PluginInput,
  type ToolDefinition,
  tool,
} from '@opencode-ai/plugin';
import { TMUX_SPAWN_DELAY_MS } from '../config/constants';
import { log } from '../utils/logger';
import {
  extractSessionResult,
  parseModelReference,
  promptWithTimeout,
} from '../utils/session';
import type { SubagentDepthTracker } from '../utils/subagent-depth';

const z = tool.schema;

const MAX_FILE_COUNT = 8;

/**
 * Infer MIME type from file extension.
 * Defaults to 'application/octet-stream' for unknown types.
 */
function inferMimeType(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  const mimeTypes: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.svg': 'image/svg+xml',
    '.tiff': 'image/tiff',
    '.tif': 'image/tiff',
    '.heic': 'image/heic',
    '.pdf': 'application/pdf',
  };
  return mimeTypes[ext] ?? 'application/octet-stream';
}

/**
 * Build the observer prompt text for a given goal and file count.
 */
function buildObservePrompt(goal: string, fileCount: number): string {
  const subjectNoun = fileCount > 1 ? 'files' : 'file';
  return `Analyze the attached ${subjectNoun} and extract the requested information.

The ${subjectNoun} ${fileCount > 1 ? 'are' : 'is'} already attached to this message. Analyze directly from the attachment. Do NOT attempt to use the Read tool — it is disabled for this invocation.

Goal: ${goal}

Provide ONLY the extracted information that matches the goal.
Be thorough on what was requested, concise on everything else.
If the requested information is not found, clearly state what is missing.`;
}

/**
 * Creates the observe tool for image/PDF analysis via a child observer session.
 * Works around OpenCode's built-in task tool stripping file parts.
 *
 * Creates a child session directly with FilePart attachments, sends the prompt
 * to the observer agent, extracts the result, and cleans up.
 */
export function createObserveTool(
  _ctx: PluginInput,
  deps: {
    depthTracker?: SubagentDepthTracker;
    tmuxEnabled: boolean;
    directory: string;
    observerModel: string;
  },
): Record<string, ToolDefinition> {
  const observe = tool({
    description:
      "Analyze image/PDF files using the @observer subagent with direct file attachment. Use when the user attached images and you need their content described, OCR'd, or compared. Returns concise structured text — the image bytes never enter the orchestrator's context.",
    args: {
      file_paths: z
        .array(z.string())
        .describe(
          'Absolute paths to image/PDF files to analyze (required, max 8)',
        ),
      goal: z
        .string()
        .describe(
          'What to extract or analyze from the files (required, be specific)',
        ),
    },
    async execute(args, toolContext) {
      if (
        !toolContext ||
        typeof toolContext !== 'object' ||
        !('sessionID' in toolContext)
      ) {
        throw new Error('Invalid toolContext: missing sessionID');
      }

      const parentSessionId = (toolContext as { sessionID: string }).sessionID;
      const filePaths = args.file_paths as unknown as string[];
      const goal = args.goal as string;

      // Validate file_paths is non-empty
      if (!Array.isArray(filePaths) || filePaths.length === 0) {
        return 'Error: file_paths must be a non-empty array of absolute file paths.';
      }

      // Cap at 8 files
      if (filePaths.length > MAX_FILE_COUNT) {
        return `Error: Maximum ${MAX_FILE_COUNT} files allowed, got ${filePaths.length}.`;
      }

      // Validate no URLs (must be local file paths)
      for (const fp of filePaths) {
        if (fp.startsWith('http://') || fp.startsWith('https://')) {
          return `Error: URLs are not supported — use local file paths only. Got: ${fp}`;
        }
      }

      // Validate each file exists
      for (const fp of filePaths) {
        if (!existsSync(fp)) {
          return `Error: File not found: ${fp}`;
        }
      }

      // Build FileParts for each path
      const fileParts = filePaths.map((fp) => ({
        type: 'file' as const,
        mime: inferMimeType(fp),
        url: pathToFileURL(fp).href,
        filename: basename(fp),
      }));

      log('[observe] creating child session', {
        parentSessionId,
        fileCount: fileParts.length,
        goal: goal.substring(0, 60),
      });

      let sessionId: string | undefined;

      try {
        // Create child session
        const session = await _ctx.client.session.create({
          body: {
            parentID: parentSessionId,
            title: `observe: ${goal.substring(0, 50)}`,
          },
          query: { directory: deps.directory },
        });

        if (!session.data?.id) {
          return 'Error: Failed to create observe session.';
        }

        sessionId = session.data.id;

        // Register depth tracker
        if (deps.depthTracker) {
          const registered = deps.depthTracker.registerChild(
            parentSessionId,
            sessionId,
          );
          if (!registered) {
            return 'Error: Subagent depth exceeded.';
          }
        }

        // Tmux spawn delay
        if (deps.tmuxEnabled) {
          await new Promise((r) => setTimeout(r, TMUX_SPAWN_DELAY_MS));
        }

        // Send prompt with file parts
        const modelRef = parseModelReference(deps.observerModel);
        if (!modelRef) {
          return `Error: Invalid observer model format: ${deps.observerModel}. Expected "provider/model".`;
        }

        await promptWithTimeout(
          _ctx.client,
          {
            path: { id: sessionId },
            body: {
              agent: 'observer',
              model: modelRef,
              tools: { task: false, observe: false, read: false },
              parts: [
                {
                  type: 'text',
                  text: buildObservePrompt(goal, fileParts.length),
                },
                ...fileParts,
              ],
            },
            query: { directory: deps.directory },
          },
          180_000, // 3 minute timeout for image analysis
        );

        // Extract result
        const extraction = await extractSessionResult(_ctx.client, sessionId);

        if (extraction.empty) {
          return 'No response from observer agent.';
        }

        return extraction.text;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return `Error: Observer session failed — ${message}`;
      } finally {
        if (sessionId) {
          _ctx.client.session
            .abort({ path: { id: sessionId } })
            .catch(() => {});
          if (deps.depthTracker) {
            deps.depthTracker.cleanup(sessionId);
          }
        }
      }
    },
  });

  return { observe };
}
