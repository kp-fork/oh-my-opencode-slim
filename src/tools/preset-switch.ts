import * as fs from 'node:fs';
import { stripJsonComments } from '../cli/config-io';
import type {
  AgentOverrideConfig,
  ModelEntry,
  PluginConfig,
  Preset,
} from '../config';
import { AGENT_ALIASES } from '../config/constants';
import { findPluginConfigPaths } from '../config/loader';
import { readTuiSnapshot, recordTuiAgentModels } from '../tui-state';

/**
 * Result of a preset switch attempt. `message` is user-facing and intended for
 * a TUI toast/dialog (it is never injected into the LLM context).
 */
export interface PresetSwitchResult {
  ok: boolean;
  presetName: string;
  message: string;
  /** Per-agent summary lines, e.g. "orchestrator → model: x, variant: y". */
  summary: string[];
}

/** A flattened, SDK-shaped agent override derived from a preset entry. */
export interface AgentUpdate {
  model?: string;
  temperature?: number;
  variant?: string;
  options?: Record<string, unknown>;
}

/**
 * Switch the active preset purely through on-disk state: persist the preset
 * name to the user config file and update the TUI snapshot that the sidebar
 * polls.
 *
 * This is the shared core used by the TUI `/preset` slash command. It
 * deliberately does NOT touch OpenCode's in-memory agent registry: per the
 * existing user contract, the new preset applies on the next reload/restart
 * (when `loadPluginConfig` re-reads the config file and merges the preset into
 * `config.agents`). It also does not set the server-side runtime-preset
 * singleton, because the TUI runs in a separate process from the server and
 * cannot reach that state.
 */
export function switchPresetOnDisk(
  directory: string,
  presetName: string,
  config: PluginConfig,
): PresetSwitchResult {
  const presets = config.presets ?? {};
  const preset = presets[presetName];

  if (!preset) {
    const available = Object.keys(presets);
    const hint =
      available.length > 0
        ? `Available presets: ${available.join(', ')}`
        : 'No presets configured. Define presets in oh-my-opencode-slim.jsonc.';
    return {
      ok: false,
      presetName,
      message: `Preset "${presetName}" not found. ${hint}`,
      summary: [],
    };
  }

  const agentUpdates = buildAgentUpdates(preset);
  if (Object.keys(agentUpdates).length === 0) {
    return {
      ok: false,
      presetName,
      message: `Preset "${presetName}" is empty (no agent overrides defined).`,
      summary: [],
    };
  }

  persistPresetName(directory, presetName);
  applyPresetToTuiSnapshot(directory, agentUpdates);

  return {
    ok: true,
    presetName,
    message: `Saved preset "${presetName}". Reload OpenCode to apply it to agent configuration. The current session was not reloaded to avoid interrupting the active conversation and destabilizing running subagents.`,
    summary: buildPresetSummary(agentUpdates),
  };
}

/**
 * Build the SDK-shaped agent overrides from a preset, resolving legacy alias
 * keys (e.g. "explore" → "explorer").
 */
export function buildAgentUpdates(preset: Preset): Record<string, AgentUpdate> {
  const agentUpdates: Record<string, AgentUpdate> = {};
  for (const [agentName, override] of Object.entries(preset)) {
    const resolvedName = AGENT_ALIASES[agentName] ?? agentName;
    const agentConfig = mapOverrideToAgentConfig(override);
    if (Object.keys(agentConfig).length > 0) {
      agentUpdates[resolvedName] = agentConfig;
    }
  }
  return agentUpdates;
}

/**
 * Map an AgentOverrideConfig (from plugin config) to the subset of agent
 * config fields shown in the saved preset summary.
 */
export function mapOverrideToAgentConfig(
  override: AgentOverrideConfig,
): AgentUpdate {
  const agentConfig: AgentUpdate = {};

  if (typeof override.model === 'string') {
    agentConfig.model = override.model;
  } else if (Array.isArray(override.model) && override.model.length > 0) {
    // Array-form model (fallback chain): pick the first entry. Full chain
    // resolution happens at init time via the config() hook, so at runtime we
    // use the primary model from the array.
    const first = override.model[0];
    agentConfig.model = typeof first === 'string' ? first : first.id;
    if (typeof first !== 'string' && first.variant) {
      agentConfig.variant = first.variant;
    }
  }

  if (typeof override.temperature === 'number') {
    agentConfig.temperature = override.temperature;
  }

  if (typeof override.variant === 'string') {
    agentConfig.variant = override.variant;
  }

  if (
    override.options &&
    typeof override.options === 'object' &&
    !Array.isArray(override.options)
  ) {
    agentConfig.options = override.options;
  }

  return agentConfig;
}

/** Build the per-agent summary lines for a switch result / picker tooltip. */
export function buildPresetSummary(
  agentUpdates: Record<string, AgentUpdate>,
): string[] {
  const summaryParts: string[] = [];
  for (const [name, cfg] of Object.entries(agentUpdates)) {
    const parts: string[] = [name];
    if (cfg.model) parts.push(`model: ${cfg.model}`);
    if (cfg.variant) parts.push(`variant: ${cfg.variant}`);
    if (cfg.temperature !== undefined) parts.push(`temp: ${cfg.temperature}`);
    if (cfg.options) parts.push('options: yes');
    summaryParts.push(parts.join(' → '));
  }
  return summaryParts;
}

/**
 * A single-line description of a preset for the TUI picker, e.g.
 * "orchestrator → glm-5.2, oracle → glm-5.2".
 */
export function formatPresetOneLine(preset: Preset): string {
  const lines: string[] = [];
  for (const [agentName, override] of Object.entries(preset)) {
    const modelStr =
      typeof override.model === 'string'
        ? override.model
        : Array.isArray(override.model) && override.model.length > 0
          ? resolveFirstModel(override.model)
          : undefined;
    lines.push(modelStr ? `${agentName} → ${modelStr}` : agentName);
  }
  return lines.join(', ');
}

/**
 * Format the full preset list with the active one highlighted. Used by
 * non-TUI surfaces (e.g. a future headless listing); the TUI uses the picker.
 */
export function formatPresetList(
  presets: Record<string, Preset>,
  activePreset: string | null,
): string {
  const names = Object.keys(presets);
  if (names.length === 0) {
    return 'No presets configured. Define presets in oh-my-opencode-slim.jsonc under the "presets" field.';
  }

  const lines = ['Available presets:'];
  for (const name of names) {
    const marker = name === activePreset ? ' ← active' : '';
    const preset = presets[name];
    const agentNames = Object.keys(preset);
    const models = agentNames
      .map((a) => {
        const cfg = preset[a];
        const modelStr =
          typeof cfg.model === 'string'
            ? cfg.model
            : Array.isArray(cfg.model) && cfg.model.length > 0
              ? resolveFirstModel(cfg.model)
              : undefined;
        return modelStr ? `    ${a} → ${modelStr}` : `    ${a}`;
      })
      .join('\n');
    lines.push(`  ${name}${marker}`);
    lines.push(models);
  }
  lines.push('\nUsage: /preset <name> to switch.');

  return lines.join('\n');
}

function resolveFirstModel(
  models: Array<string | ModelEntry>,
): string | undefined {
  if (models.length === 0) return undefined;
  const first = models[0];
  return typeof first === 'string' ? first : first.id;
}

/**
 * Persist the preset name to the user-level config file so it survives
 * restarts. Best-effort: a failure must not abort the switch, because the TUI
 * snapshot update is the immediate user-visible effect.
 *
 * Note: this rewrites the file as plain JSON (JSONC comments are not
 * preserved), matching the prior server-side behavior.
 */
function persistPresetName(directory: string, presetName: string): void {
  try {
    const { userConfigPath } = findPluginConfigPaths(directory);
    if (!userConfigPath) return;
    const raw = fs.readFileSync(userConfigPath, 'utf-8');
    const persisted = JSON.parse(stripJsonComments(raw)) as Record<
      string,
      unknown
    >;
    persisted.preset = presetName;
    fs.writeFileSync(userConfigPath, `${JSON.stringify(persisted, null, 2)}\n`);
  } catch {
    // Non-critical: the TUI snapshot is updated regardless.
  }
}

/**
 * Merge the preset's model/variant overrides into the on-disk TUI snapshot so
 * the sidebar reflects the new models on its next poll.
 */
function applyPresetToTuiSnapshot(
  directory: string,
  agentUpdates: Record<string, AgentUpdate>,
): void {
  const snapshot = readTuiSnapshot(directory);
  const agentModels = { ...snapshot.agentModels };
  const agentVariants = { ...snapshot.agentVariants };
  for (const [agentName, agentConfig] of Object.entries(agentUpdates)) {
    if (typeof agentConfig.model === 'string') {
      agentModels[agentName] = agentConfig.model;
    }
    if (typeof agentConfig.variant === 'string') {
      agentVariants[agentName] = agentConfig.variant;
    } else {
      delete agentVariants[agentName];
    }
  }
  recordTuiAgentModels({ agentModels, agentVariants }, directory);
}

/**
 * Read the user-level config file as a parsed object. Returns null if the
 * file is absent or unreadable.
 */
function readUserConfig(directory: string): Record<string, unknown> | null {
  try {
    const { userConfigPath } = findPluginConfigPaths(directory);
    if (!userConfigPath) return null;
    const raw = fs.readFileSync(userConfigPath, 'utf-8');
    return JSON.parse(stripJsonComments(raw)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Write the user-level config file (plain JSON; JSONC comments are not
 * preserved, matching the existing switchPreset behavior). Best-effort.
 */
function writeUserConfig(
  directory: string,
  config: Record<string, unknown>,
): boolean {
  try {
    const { userConfigPath } = findPluginConfigPaths(directory);
    if (!userConfigPath) return false;
    fs.writeFileSync(userConfigPath, `${JSON.stringify(config, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Persist a preset (create or overwrite) into the user config's `presets`
 * object. Returns true on success.
 */
export function writePreset(
  directory: string,
  name: string,
  preset: Preset,
): boolean {
  const config = readUserConfig(directory) ?? {};
  const presets = (config.presets as Record<string, Preset> | undefined) ?? {};
  presets[name] = preset;
  config.presets = presets;
  return writeUserConfig(directory, config);
}

/**
 * Delete a preset from the user config. Returns true if removed, false if the
 * preset did not exist or the write failed.
 */
export function deletePreset(directory: string, name: string): boolean {
  const config = readUserConfig(directory);
  if (!config) return false;
  const presets = config.presets as Record<string, Preset> | undefined;
  if (!presets || !(name in presets)) return false;
  delete presets[name];
  // If the active preset was deleted, clear the `preset` field too.
  if (config.preset === name) {
    delete config.preset;
  }
  return writeUserConfig(directory, config);
}

/**
 * Set (or replace) an agent override within an in-memory preset. Returns a
 * new preset object; does not mutate the input.
 */
export function setAgentOverride(
  preset: Preset,
  agentName: string,
  override: AgentOverrideConfig,
): Preset {
  return { ...preset, [agentName]: override };
}

/**
 * Remove an agent from an in-memory preset. Returns a new preset object; does
 * not mutate the input. If the agent was not present, the preset is unchanged.
 */
export function removeAgentFromPreset(
  preset: Preset,
  agentName: string,
): Preset {
  if (!(agentName in preset)) return preset;
  const next = { ...preset };
  delete next[agentName];
  return next;
}
