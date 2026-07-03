import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CUSTOM_SKILLS, type CustomSkill } from './custom-skills-registry';
import { getConfigDir } from './paths';

export { CUSTOM_SKILLS, type CustomSkill };

/**
 * Get the target directory for custom skills installation.
 */
export function getCustomSkillsDir(): string {
  return join(getConfigDir(), 'skills');
}

/**
 * Install a custom skill by copying from src/skills/ to the OpenCode skills directory
 * @param skill - The custom skill to install
 * @returns True if installation succeeded, false otherwise
 * @deprecated Use syncBundledSkillsFromPackage instead.
 */
export async function installCustomSkill(skill: CustomSkill): Promise<boolean> {
  console.warn(
    `[DEPRECATED] installCustomSkill is deprecated and will be removed. Use syncBundledSkillsFromPackage instead.`,
  );
  try {
    const { syncBundledSkillsFromPackage } = await import(
      '../hooks/auto-update-checker/skill-sync'
    );
    const packageRoot = fileURLToPath(new URL('../..', import.meta.url));
    const result = syncBundledSkillsFromPackage(packageRoot, {
      skills: [skill],
    });
    return (
      result.installed.includes(skill.name) ||
      result.skippedExisting.includes(skill.name)
    );
  } catch (error) {
    console.error(
      `Failed to install custom skill safely: ${skill.name}`,
      error,
    );
    return false;
  }
}
