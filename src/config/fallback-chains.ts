export function normalizeFallbackChainsForPreset(
  chains: Record<string, string[] | undefined>,
  presetName: string | null | undefined,
): Record<string, string[]> {
  const normalized: Record<string, string[]> = {};

  for (const [rawKey, chainModels] of Object.entries(chains)) {
    if (!chainModels?.length) continue;

    const separatorIndex = rawKey.indexOf(':');
    const hasPresetScope = separatorIndex !== -1;
    const scopedPreset = hasPresetScope ? rawKey.slice(0, separatorIndex) : '';
    const agentName = hasPresetScope
      ? rawKey.slice(separatorIndex + 1)
      : rawKey;

    if (!agentName) continue;
    if (hasPresetScope && scopedPreset !== presetName) continue;

    const existing = normalized[agentName] ?? [];
    const seen = new Set(existing);
    for (const chainModel of chainModels) {
      if (seen.has(chainModel)) continue;
      seen.add(chainModel);
      existing.push(chainModel);
    }

    if (existing.length > 0) {
      normalized[agentName] = existing;
    }
  }

  return normalized;
}
