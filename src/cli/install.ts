import type { InstallArgs, InstallConfig, BooleanArg, DetectedConfig } from "./types"
import {
  addPluginToOpenCodeConfig,
  writeLiteConfig,
  isOpenCodeInstalled,
  getOpenCodeVersion,
  addAuthPlugins,
  addProviderConfig,
  detectCurrentConfig,
} from "./config-manager"

const GREEN = "\x1b[32m"
const BLUE = "\x1b[34m"
const YELLOW = "\x1b[33m"
const RED = "\x1b[31m"
const BOLD = "\x1b[1m"
const DIM = "\x1b[2m"
const RESET = "\x1b[0m"

const SYMBOLS = {
  check: `${GREEN}✓${RESET}`,
  cross: `${RED}✗${RESET}`,
  arrow: `${BLUE}→${RESET}`,
  bullet: `${DIM}•${RESET}`,
  info: `${BLUE}ℹ${RESET}`,
  warn: `${YELLOW}⚠${RESET}`,
  star: `${YELLOW}★${RESET}`,
}

function printHeader(isUpdate: boolean): void {
  const mode = isUpdate ? "Update" : "Install"
  console.log()
  console.log(`${BOLD}oh-my-opencode-slim ${mode}${RESET}`)
  console.log("=".repeat(30))
  console.log()
}

function printStep(step: number, total: number, message: string): void {
  console.log(`${DIM}[${step}/${total}]${RESET} ${message}`)
}

function printSuccess(message: string): void {
  console.log(`${SYMBOLS.check} ${message}`)
}

function printError(message: string): void {
  console.log(`${SYMBOLS.cross} ${RED}${message}${RESET}`)
}

function printInfo(message: string): void {
  console.log(`${SYMBOLS.info} ${message}`)
}

function printWarning(message: string): void {
  console.log(`${SYMBOLS.warn} ${YELLOW}${message}${RESET}`)
}

function formatConfigSummary(config: InstallConfig): string {
  const lines: string[] = []
  lines.push(`${BOLD}Configuration Summary${RESET}`)
  lines.push("")
  lines.push(`  ${config.hasAntigravity ? SYMBOLS.check : DIM + "○" + RESET} Antigravity`)
  lines.push(`  ${config.hasOpenAI ? SYMBOLS.check : DIM + "○" + RESET} OpenAI`)
  lines.push(`  ${config.hasCerebras ? SYMBOLS.check : DIM + "○" + RESET} Cerebras`)
  return lines.join("\n")
}

function validateNonTuiArgs(args: InstallArgs): { valid: boolean; errors: string[] } {
  const errors: string[] = []

  if (args.antigravity === undefined) {
    errors.push("--antigravity is required (values: yes, no)")
  } else if (!["yes", "no"].includes(args.antigravity)) {
    errors.push(`Invalid --antigravity value: ${args.antigravity} (expected: yes, no)`)
  }

  if (args.openai === undefined) {
    errors.push("--openai is required (values: yes, no)")
  } else if (!["yes", "no"].includes(args.openai)) {
    errors.push(`Invalid --openai value: ${args.openai} (expected: yes, no)`)
  }

  if (args.cerebras === undefined) {
    errors.push("--cerebras is required (values: yes, no)")
  } else if (!["yes", "no"].includes(args.cerebras)) {
    errors.push(`Invalid --cerebras value: ${args.cerebras} (expected: yes, no)`)
  }

  return { valid: errors.length === 0, errors }
}

function argsToConfig(args: InstallArgs): InstallConfig {
  return {
    hasAntigravity: args.antigravity === "yes",
    hasOpenAI: args.openai === "yes",
    hasCerebras: args.cerebras === "yes",
  }
}

function detectedToInitialValues(detected: DetectedConfig): {
  antigravity: BooleanArg
  openai: BooleanArg
  cerebras: BooleanArg
} {
  return {
    antigravity: detected.hasAntigravity ? "yes" : "no",
    openai: detected.hasOpenAI ? "yes" : "no",
    cerebras: detected.hasCerebras ? "yes" : "no",
  }
}

async function askYesNo(prompt: string, defaultValue: BooleanArg = "no"): Promise<BooleanArg> {
  const defaultHint = defaultValue === "yes" ? "[Y/n]" : "[y/N]"
  process.stdout.write(`${BLUE}${prompt}${RESET} ${defaultHint}: `)

  const reader = Bun.stdin.stream().getReader()
  const { value } = await reader.read()
  reader.releaseLock()

  const answer = value ? new TextDecoder().decode(value).trim().toLowerCase() : ""

  if (answer === "" || answer === "\n") return defaultValue
  if (answer === "y" || answer === "yes") return "yes"
  if (answer === "n" || answer === "no") return "no"
  return defaultValue
}

async function runTuiMode(detected: DetectedConfig): Promise<InstallConfig | null> {
  const initial = detectedToInitialValues(detected)

  console.log(`${BOLD}Question 1/3:${RESET}`)
  const antigravity = await askYesNo(
    "Do you have an Antigravity subscription?",
    initial.antigravity
  )
  console.log()

  console.log(`${BOLD}Question 2/3:${RESET}`)
  const openai = await askYesNo("Do you have access to OpenAI API?", initial.openai)
  console.log()

  console.log(`${BOLD}Question 3/3:${RESET}`)
  const cerebras = await askYesNo("Do you have access to Cerebras API?", initial.cerebras)
  console.log()

  return {
    hasAntigravity: antigravity === "yes",
    hasOpenAI: openai === "yes",
    hasCerebras: cerebras === "yes",
  }
}

async function runInstall(args: InstallArgs, config: InstallConfig): Promise<number> {
  const detected = detectCurrentConfig()
  const isUpdate = detected.isInstalled

  printHeader(isUpdate)

  const totalSteps = config.hasAntigravity ? 5 : 3
  let step = 1

  // Step 1: Check OpenCode
  printStep(step++, totalSteps, "Checking OpenCode installation...")
  const installed = await isOpenCodeInstalled()
  if (!installed) {
    printError("OpenCode is not installed on this system.")
    printInfo("Visit https://opencode.ai/docs for installation instructions")
    return 1
  }

  const version = await getOpenCodeVersion()
  printSuccess(`OpenCode ${version ?? ""} detected`)

  // Step 2: Add plugin
  printStep(step++, totalSteps, "Adding oh-my-opencode-slim plugin...")
  const pluginResult = await addPluginToOpenCodeConfig()
  if (!pluginResult.success) {
    printError(`Failed: ${pluginResult.error}`)
    return 1
  }
  printSuccess(`Plugin added ${SYMBOLS.arrow} ${DIM}${pluginResult.configPath}${RESET}`)

  // Step 3-4: Auth plugins and provider config (if Antigravity)
  if (config.hasAntigravity) {
    printStep(step++, totalSteps, "Adding auth plugins...")
    const authResult = await addAuthPlugins(config)
    if (!authResult.success) {
      printError(`Failed: ${authResult.error}`)
      return 1
    }
    printSuccess(`Auth plugins configured ${SYMBOLS.arrow} ${DIM}${authResult.configPath}${RESET}`)

    printStep(step++, totalSteps, "Adding provider configurations...")
    const providerResult = addProviderConfig(config)
    if (!providerResult.success) {
      printError(`Failed: ${providerResult.error}`)
      return 1
    }
    printSuccess(`Providers configured ${SYMBOLS.arrow} ${DIM}${providerResult.configPath}${RESET}`)
  }

  // Step 5: Write lite config
  printStep(step++, totalSteps, "Writing oh-my-opencode-slim configuration...")
  const liteResult = writeLiteConfig(config)
  if (!liteResult.success) {
    printError(`Failed: ${liteResult.error}`)
    return 1
  }
  printSuccess(`Config written ${SYMBOLS.arrow} ${DIM}${liteResult.configPath}${RESET}`)

  // Summary
  console.log()
  console.log(formatConfigSummary(config))
  console.log()

  if (!config.hasAntigravity && !config.hasOpenAI && !config.hasCerebras) {
    printWarning("No providers configured. At least one provider is required.")
    return 1
  }

  console.log(`${SYMBOLS.star} ${BOLD}${GREEN}${isUpdate ? "Configuration updated!" : "Installation complete!"}${RESET}`)
  console.log()
  console.log(`${BOLD}Next steps:${RESET}`)
  console.log()
  console.log(`  1. Authenticate with your providers:`)
  console.log(`     ${BLUE}$ opencode auth login${RESET}`)
  console.log()
  console.log(`  2. Start OpenCode:`)
  console.log(`     ${BLUE}$ opencode${RESET}`)
  console.log()

  return 0
}

export async function install(args: InstallArgs): Promise<number> {
  if (!args.tui) {
    // Non-TUI mode: validate args
    const validation = validateNonTuiArgs(args)
    if (!validation.valid) {
      printHeader(false)
      printError("Validation failed:")
      for (const err of validation.errors) {
        console.log(`  ${SYMBOLS.bullet} ${err}`)
      }
      console.log()
      printInfo(
        "Usage: bunx oh-my-opencode-slim install --no-tui --antigravity=<yes|no> --openai=<yes|no> --cerebras=<yes|no>"
      )
      console.log()
      return 1
    }

    const config = argsToConfig(args)
    return runInstall(args, config)
  }

  // TUI mode
  const detected = detectCurrentConfig()

  printHeader(detected.isInstalled)

  printStep(1, 1, "Checking OpenCode installation...")
  const installed = await isOpenCodeInstalled()
  if (!installed) {
    printError("OpenCode is not installed on this system.")
    printInfo("Visit https://opencode.ai/docs for installation instructions")
    return 1
  }

  const version = await getOpenCodeVersion()
  printSuccess(`OpenCode ${version ?? ""} detected`)
  console.log()

  const config = await runTuiMode(detected)
  if (!config) return 1

  return runInstall(args, config)
}
