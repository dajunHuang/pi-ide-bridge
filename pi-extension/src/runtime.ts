import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { connectIdeBridge, connectContextStream, disconnectIdeBridge, getIdeConnectionDebugInfo, getIdeConnectionStatus, sendGetDiagnostics } from './ideBridgeClient.js';
import { installVsCodeCompanion, installVsCodeCompanionFromLocalDebugVsix } from './installer.js';
import { applyConnectionStatus, applyIdeContextStatus, clearConnectionStatusTimer, disposeStatusBar, getStatusRenderMode, setStatusRenderMode, type StatusRenderMode } from './status.js';
import type { EditorContext } from './types.js';

const IDE_USAGE = 'Usage: /ide | /ide status | /ide disconnect | /ide context | /ide install | /ide debug | /ide diagnostics [active|all|file <absolutePath>] | /ide status-mode [widget|status]';
const IDE_CONNECTION_STATUS_DURATION_MS = 3_000;
const IDE_CONTEXT_SELECTED_PREVIEW_MAX_CHARS = 200;
const PI_IDE_BRIDGE_SETTINGS_KEY = 'piIdeBridge';

export default function createPiIdeBridgeExtension(pi: ExtensionAPI) {
  let liveContext: EditorContext | undefined;
  let contextStreamHandle: { disconnect: () => void } | undefined;

  function clearIdeContext(ctx: any): void {
    liveContext = undefined;
    applyIdeContextStatus(ctx, undefined);
  }

  function stopContextStream(ctx: any): void {
    contextStreamHandle?.disconnect();
    contextStreamHandle = undefined;
    clearIdeContext(ctx);
  }

  function startContextStream(ctx: any): void {
    stopContextStream(ctx);
    contextStreamHandle = connectContextStream(
      (context) => {
        liveContext = context;
        applyIdeContextStatus(ctx, context);
      },
      () => {
        contextStreamHandle = undefined;
        clearIdeContext(ctx);
        applyConnectionStatus(ctx, false, IDE_CONNECTION_STATUS_DURATION_MS);
      },
    );
  }

  pi.on('session_start', async (_event, ctx) => {
    stopContextStream(ctx);
    disconnectIdeBridge();
    clearConnectionStatusTimer();
    disposeStatusBar(ctx);

    const configuredRenderMode = await loadStatusRenderMode(ctx.cwd);
    setStatusRenderMode(ctx, configuredRenderMode);
  });

  pi.on('session_shutdown', async (_event, ctx) => {
    stopContextStream(ctx);
    disconnectIdeBridge();
    clearConnectionStatusTimer();
    disposeStatusBar(ctx);
  });

  pi.on('before_agent_start', async (_event, _ctx) => {
    if (!liveContext || !Array.isArray(liveContext.openFiles) || liveContext.openFiles.length === 0) return;

    const active = liveContext.openFiles.find((file) => file.isActive) || liveContext.openFiles[0];
    if (!active) return;

    const cursor = active.cursor ? `line ${active.cursor.line}, col ${active.cursor.character}` : 'cursor unknown';
    const selectedText = active.selectedText || '';
    const selectedLines = selectedText ? selectedText.split(/\r?\n/).length : 0;
    const selectedPreview = selectedText.length > IDE_CONTEXT_SELECTED_PREVIEW_MAX_CHARS
      ? `${selectedText.slice(0, IDE_CONTEXT_SELECTED_PREVIEW_MAX_CHARS)}…`
      : selectedText;
    const selectedInfo = selectedText
      ? `"${selectedPreview}" (${selectedLines} line${selectedLines === 1 ? '' : 's'})`
      : '(none)';
    const openFileNames = liveContext.openFiles.map((file) => file.path.split('/').pop() || file.path);
    const preview = openFileNames.slice(0, 2).join(', ');
    const remaining = openFileNames.length - 2;

    return {
      message: {
        customType: 'pi-ide-bridge-editor-context',
        display: false,
        content: [
          '[IDE Context]',
          `Active file: ${active.path} — ${cursor}`,
          `Selected: ${selectedInfo}`,
          `Open files: ${preview}${remaining > 0 ? `, +${remaining} more` : ''}`,
        ].join('\n'),
        details: liveContext,
      },
    };
  });

  pi.registerCommand('ide', {
    description: 'Connect to or manage the VS Code IDE bridge',
    handler: async (args, ctx) => {
      const rawArgs = String(args || '').trim();
      const parts = rawArgs ? rawArgs.split(/\s+/) : [];
      const action = (parts[0] || '').toLowerCase();

      if (!action) {
        const connection = await connectIdeBridge();
        if (!connection.connected) {
          stopContextStream(ctx);
          applyConnectionStatus(ctx, false, IDE_CONNECTION_STATUS_DURATION_MS);
          ctx.ui.notify(`Pi IDE Bridge connection failed: ${String(connection.reason || 'unknown error')}`, 'error');
          return;
        }

        startContextStream(ctx);
        applyConnectionStatus(ctx, true, IDE_CONNECTION_STATUS_DURATION_MS);
        ctx.ui.notify(`Pi IDE Bridge connected: source=${connection.source} port=${String(connection.port ?? 'n/a')}`, 'info');
        return;
      }

      if (action === 'status') {
        const debug = await getIdeConnectionDebugInfo();
        if (!debug.connected) stopContextStream(ctx);
        const status = await getIdeConnectionStatus(ctx.ui?.theme);
        ctx.ui.notify(status.text, status.type);
        return;
      }

      if (action === 'disconnect') {
        stopContextStream(ctx);
        disconnectIdeBridge('Disconnected manually');
        applyConnectionStatus(ctx, false, IDE_CONNECTION_STATUS_DURATION_MS);
        ctx.ui.notify('Pi IDE Bridge disconnected.', 'info');
        return;
      }

      if (action === 'status-mode') {
        const requested = (parts[1] || '').toLowerCase();
        if (!requested) {
          ctx.ui.notify(`Pi IDE Bridge status mode: ${getStatusRenderMode()}`, 'info');
          return;
        }

        if (requested !== 'widget' && requested !== 'status') {
          ctx.ui.notify('Usage: /ide status-mode [widget|status]', 'error');
          return;
        }

        const renderMode = requested as StatusRenderMode;
        setStatusRenderMode(ctx, renderMode);
        await saveStatusRenderMode(ctx.cwd, renderMode);
        ctx.ui.notify(`Pi IDE Bridge status mode set to ${renderMode}.`, 'info');
        return;
      }

      if (action === 'debug') {
        const debug = await getIdeConnectionDebugInfo();
        if (debug.connected) {
          ctx.ui.notify(`Pi IDE Bridge debug: connected=yes source=${debug.source} port=${String(debug.port ?? 'n/a')}`, 'info');
          return;
        }
        stopContextStream(ctx);
        ctx.ui.notify(`Pi IDE Bridge debug: connected=no source=${debug.source} reason=${String(debug.reason || 'unknown')}`, 'info');
        return;
      }

      if (action === 'context') {
        if (!liveContext) {
          ctx.ui.notify('Pi IDE Bridge context: unavailable (no SSE context received yet).', 'info');
          return;
        }

        const payload = JSON.stringify(liveContext, null, 2);
        pi.sendMessage({
          customType: 'pi-ide-bridge-context-debug',
          display: true,
          content: ['[IDE Context Debug]', payload].join('\n'),
          details: liveContext,
        });
        ctx.ui.notify('Pi IDE Bridge context dumped to chat.', 'info');
        return;
      }

      if (action === 'diagnostics') {
        const rest = parts.slice(1);
        const requestedScope = (rest[0] || 'active').toLowerCase();
        const scope = requestedScope === 'all' || requestedScope === 'file' ? requestedScope : 'active';
        const filePath = scope === 'file' ? rest.slice(1).join(' ').trim() : undefined;

        if (scope === 'file' && !filePath) {
          ctx.ui.notify("Usage: /ide diagnostics file <absolutePath>", 'error');
          return;
        }

        const diagnostics = await sendGetDiagnostics({ scope, filePath });
        if (!diagnostics) {
          ctx.ui.notify('Pi IDE Bridge diagnostics: unavailable (bridge disconnected).', 'error');
          return;
        }

        const payload = JSON.stringify(diagnostics, null, 2);
        pi.sendMessage({
          customType: 'pi-ide-bridge-diagnostics-debug',
          display: true,
          content: ['[IDE Diagnostics]', payload].join('\n'),
          details: diagnostics,
        });
        ctx.ui.notify(`Pi IDE Bridge diagnostics dumped to chat (files=${diagnostics.files.length}, errors=${diagnostics.totalErrors}, warnings=${diagnostics.totalWarnings}).`, 'info');
        return;
      }

      if (action === 'install') {
        const vsixPath = parts[1] || '';
        const installed = vsixPath
          ? await installVsCodeCompanionFromLocalDebugVsix(vsixPath)
          : await installVsCodeCompanion();
        if (installed) {
          ctx.ui.notify('✓ VS Code companion extension installed. Run /ide to connect.', 'info');
          return;
        }

        const message = vsixPath
          ? `✕ Failed to install VSIX from path: ${vsixPath}`
          : "✕ No installer is available for IDE. Please install the 'Pi IDE Bridge' extension manually from the marketplace.";
        ctx.ui.notify(message, 'error');
        return;
      }

      if (action === 'help') {
        ctx.ui.notify(IDE_USAGE, 'info');
        return;
      }

      ctx.ui.notify(IDE_USAGE, 'info');
    },
  });

  pi.registerTool({
    name: 'get_ide_diagnostics',
    label: 'Get IDE Diagnostics',
    description: 'Retrieve current VS Code diagnostics (errors and warnings only) for active, open-files, or specific file scope.',
    promptSnippet: 'Query VS Code diagnostics; prefer active scope when the request is vague.',
    promptGuidelines: [
      'Use get_ide_diagnostics when current IDE errors/warnings can help resolve the user task.',
      "When the user asks vaguely (e.g., 'check diagnostics' without scope), prefer scope='active' first.",
      "Use scope='active' for current editor (preferred default), scope='all' for open files (up to 10), or scope='file' with absolute filePath.",
      "scope='active' and scope='file' can return up to 500 diagnostics for deeper detail; scope='all' returns up to 50 per file.",
      'Only errors and warnings are returned; hints and info are intentionally excluded.',
    ],
    parameters: Type.Object({
      scope: Type.Optional(Type.Union([
        Type.Literal('active'),
        Type.Literal('all'),
        Type.Literal('file'),
      ], { description: "Diagnostics scope. Defaults to 'active'." })),
      filePath: Type.Optional(Type.String({ description: "Absolute file path. Required when scope is 'file'." })),
    }),
    async execute(_toolCallId, params) {
      const scope = params.scope ?? 'active';
      const filePath = typeof params.filePath === 'string' ? params.filePath : undefined;

      if (scope === 'file' && !filePath) {
        return {
          content: [{ type: 'text', text: "get_ide_diagnostics error: filePath is required when scope is 'file'." }],
          details: {},
        };
      }

      const diagnostics = await sendGetDiagnostics({ scope, filePath });
      if (!diagnostics) {
        return {
          content: [{ type: 'text', text: 'get_ide_diagnostics error: IDE bridge not connected.' }],
          details: {},
        };
      }

      return {
        content: [{ type: 'text', text: JSON.stringify(diagnostics, null, 2) }],
        details: {},
      };
    },
  });

}

async function loadStatusRenderMode(cwd: string): Promise<StatusRenderMode> {
  const projectPath = resolve(cwd, '.pi/settings.json');
  const projectMode = await readStatusRenderModeFromSettingsFile(projectPath);
  if (projectMode) return projectMode;

  const globalPath = resolve(homedir(), '.pi/agent/settings.json');
  const globalMode = await readStatusRenderModeFromSettingsFile(globalPath);
  if (globalMode) return globalMode;

  return 'widget';
}

async function saveStatusRenderMode(cwd: string, mode: StatusRenderMode): Promise<void> {
  const projectPath = resolve(cwd, '.pi/settings.json');
  const projectMode = await readStatusRenderModeFromSettingsFile(projectPath);
  if (projectMode !== null) {
    await writeStatusRenderModeToSettingsFile(projectPath, mode);
    return;
  }

  const globalPath = resolve(homedir(), '.pi/agent/settings.json');
  await writeStatusRenderModeToSettingsFile(globalPath, mode);
}

async function readStatusRenderModeFromSettingsFile(path: string): Promise<StatusRenderMode | null> {
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as any;
    const mode = parsed?.[PI_IDE_BRIDGE_SETTINGS_KEY]?.statusMode;
    if (mode === 'widget' || mode === 'status') return mode;
    return null;
  } catch {
    return null;
  }
}

async function writeStatusRenderModeToSettingsFile(path: string, mode: StatusRenderMode): Promise<void> {
  let parsed: any = {};
  try {
    const raw = await readFile(path, 'utf8');
    parsed = JSON.parse(raw) as any;
  } catch {
    parsed = {};
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    parsed = {};
  }

  const existingSection = parsed[PI_IDE_BRIDGE_SETTINGS_KEY];
  parsed[PI_IDE_BRIDGE_SETTINGS_KEY] = {
    ...(existingSection && typeof existingSection === 'object' ? existingSection : {}),
    statusMode: mode,
  };

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
}
