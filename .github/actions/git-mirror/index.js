const crypto = require('crypto')
const fs     = require('fs')
const os     = require('os')
const path   = require('path')
const { execFileSync } = require('child_process')


const inputNames = {
  sourceRepo: 'source-repo',
  targetRepo: 'target-repo',
  sourceSshKey: 'source-ssh-key',
  targetSshKey: 'target-ssh-key',
  targetToken: 'target-token',
}

const outputNames = {
  headCommitHash: 'head-commit-hash',
}

// ANSI color codes
const colors = {
  reset: '\x1b[0m',

  // Styles
  bold: '\x1b[1m',
  italic: '\x1b[3m',
  underline: '\x1b[4m',
  blink: '\x1b[5m',
  inverse: '\x1b[7m',
  hidden: '\x1b[8m',
  strikethrough: '\x1b[9m',

  // 8-bit Colors
  black: '\x1b[30m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',

  // Bright 8-bit Colors
  brightBlack: '\x1b[90m',
  brightRed: '\x1b[91m',
  brightGreen: '\x1b[92m',
  brightYellow: '\x1b[93m',
  brightBlue: '\x1b[94m',
  brightMagenta: '\x1b[95m',
  brightCyan: '\x1b[96m',
  brightWhite: '\x1b[97m',

  // 24-bit Colors (Foreground)
  rgb: (r, g = r, b = r) => `\x1b[38;2;${r};${g};${b}m`,

  // 24-bit Colors (Background)
  rgbBg: (r, g = r, b = r) => `\x1b[48;2;${r};${g};${b}m`,
}

// Function to get the elapsed time since the start of the script
const START_TIME = Date.now();

///////////////////////////

function colorize(str, color) {
  return `${color}${str}${colors.reset}`
}

// Class to handle inputs using Proxy
class Inputs {
  #toEnvVarName(prop) {
    return `INPUT_${prop.toUpperCase()}`
  }
  constructor() {
    return new Proxy(this, {
      get: (target, prop) => process.env[this.#toEnvVarName(prop)],
      deleteProperty: (target, prop) => {
        const envVarName = this.#toEnvVarName(prop)
        if (envVarName in process.env) {
          delete process.env[envVarName]
          return true
        }
        return false
      }
    })
  }
}

// Logging function with colors and emojis
function log(message) {
  function formatNum(prefix, num, suffix, len) {
    const str = num ? num.toString() : ''
    return colorize("0", colors.rgb(60, 60, 60)).repeat(len - str.length) + prefix + str + suffix
  }
  const elapsed = Date.now() - START_TIME
  const seconds = formatNum(colors.rgb(130, 100, 220), Math.floor(elapsed / 1000), colors.reset, 3)
  const milliseconds = formatNum(colors.rgb(100, 130, 255), elapsed % 1000, colors.reset, 3)
  
  const elapsedStr = [
    colorize("[", colors.rgb(170, 170, 170)),
    colorize("+", colors.blue),
    `${seconds}`,
    colorize(".", colors.blue),
    `${milliseconds}`,
    colorize("ms", colors.rgb(130, 130, 130)),
    colorize("]", colors.rgb(170, 170, 170)),
  ].join('')

  console.log(`${elapsedStr} ${colorize(message, colors.reset)}`)
}

function prettyPrintEnv(filterCallback) {
  console.log(colorize("Environment Variables:", `${colors.bold}${colors.underline}${colors.blue}`))

  for (const [name, value] of Object.entries(process.env)) {
    if (filterCallback && ! filterCallback(name, value)) {
      continue
    }

    let displayValue = value
    if (value.length > 255 || value.includes('\n')) {
      displayValue = value.slice(0, 252) + '...'
    }

    console.log(
      `  ${colorize(name, colors.green)}: ` +
      colorize(displayValue, colors.yellow)
    )
  }
}

// Function to execute shell commands
function exec(command, args, options = {}) {
  const backtick = colorize('`', colors.rgb(100, 100, 100))
  const cmd_str = [command, ...args].map(arg =>
    backtick + colorize(arg, colors.rgb(200, 200, 200)) + backtick
  ).join(' ')
  log(colorize(`🚀 Executing command: `, colors.magenta) + cmd_str)
  const output = execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'inherit'],
    ...options
  })
  return output
}

// Function to set output for GitHub Actions
function setOutput(name, value) {
  const uuid = crypto.randomUUID()
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}<<${uuid}\n${value}\n${uuid}\n`)
}

async function withCwd(directory, callback) {
    const __originalCwd = process.cwd()
    try {
        process.chdir(directory)
        await callback()
    } finally {
        process.chdir(__originalCwd)
    }
}

// New function to start SSH agent and add keys
function setupSSHAgent(sourceSshKey, targetSshKey) {
  log(colorize('🔐 Setting up SSH agent...', colors.blue))
  const sshAgentOutput = exec('ssh-agent', [
    '-s', // Generate Bourne shell commands on stdout.
  ])
  const match = sshAgentOutput.match(
    /SSH_AUTH_SOCK=(?<SSH_AUTH_SOCK>[^;]+).*SSH_AGENT_PID=(?<SSH_AGENT_PID>\d+)/s
  )
  if ( ! match ) {
    throw new Error('Failed to start SSH agent')
  }
  Object.assign(process.env, match.groups)

  if ( sourceSshKey ) {
    log(colorize('🔑 Adding source SSH key...', colors.yellow))
    execFileSync('ssh-add', ['-vvv', '-'], { input: sourceSshKey })
  }
  if ( targetSshKey ) {
    log(colorize('🔑 Adding target SSH key...', colors.yellow))
    execFileSync('ssh-add', ['-vvv', '-'], { input: targetSshKey })
  }
}

// New function to stop SSH agent
function stopSSHAgent() {
  log(colorize('🔒 Stopping SSH agent...', colors.blue))
  exec('ssh-agent', [
    '-k', // Kill the current agent.
  ])
}


// Main function
async function main() {
  process.stdout._handle.setBlocking(true)
  process.stderr._handle.setBlocking(true)
  
  const inputs = new Inputs()
  
  const sshDir = path.join(os.homedir(), '.ssh')
  const sshConfigPath = path.join(sshDir, 'config')
  const sshKnownHostsPath = path.join(sshDir, 'known_hosts')

  const clonedRepoPath = fs.mkdtempSync(path.join(os.homedir(), 'cloned-repo-'))
  fs.chmodSync(clonedRepoPath, 0o700)

  let usingSsh = false

  try {
    // Input validation
    const requiredInputs = [inputNames.sourceRepo, inputNames.targetRepo]
    for (const input of requiredInputs) {
      if ( ! inputs[input] ) {
        prettyPrintEnv((name, value) => name.startsWith('INPUT_'))
        throw new Error(`Missing required input: \`${input}\``)
      }
    }

    if ( ! inputs[inputNames.targetSshKey] && ! inputs[inputNames.targetToken] ) {
      throw new Error(`Either \`${inputNames.targetSshKey}\` or \`${inputNames.targetToken}\` inputs must be provided`)
    }

    // Set up SSH agent if SSH keys are provided
    if ( inputs[inputNames.sourceSshKey] || inputs[inputNames.targetSshKey] ) {
      usingSsh = true
      setupSSHAgent(inputs[inputNames.sourceSshKey], inputs[inputNames.targetSshKey])
      delete inputs[inputNames.sourceSshKey]
      delete inputs[inputNames.targetSshKey]
      fs.mkdirSync(sshDir, { recursive: true })
      fs.appendFileSync(sshConfigPath, 'StrictHostKeyChecking=no\n')
    }

    // Clone source repository
    log(colorize('📥 Cloning source repository...', colors.cyan))
    exec('git', ['clone', '--verbose', '--mirror', inputs[inputNames.sourceRepo], clonedRepoPath])

    // Set up target repository URL
    let targetRepoUrl = inputs[inputNames.targetRepo]
    if ( inputs[inputNames.targetToken] ) {
      const repoPath = inputs[inputNames.targetRepo].replace('https://github.com/', '')
      targetRepoUrl = `https://x-access-token:${inputs[inputNames.targetToken]}@github.com/${repoPath}`
    }

    // Mirror repository
    log(colorize('🔄 Mirroring repository...', colors.rgb(20, 230, 255)))
    await withCwd(clonedRepoPath, async () => {
      exec('git', ['push', '--verbose', '--mirror', targetRepoUrl])

      // Get last commit hash
      const lastCommitHash = exec('git', ['rev-parse', 'HEAD']).trim()
      setOutput(outputNames.headCommitHash, lastCommitHash)
    })
    log(colorize('✅ Repository mirrored successfully!', colors.green))
  } catch ( error ) {
    log(colorize(error.message, colors.red))
    process.exitCode = 1
    throw error
  } finally {
    // Clean up
    log(colorize('🧹 Cleaning up...', colors.yellow));
    if ( usingSsh ) {
      stopSSHAgent()
    }
    fs.rmSync(clonedRepoPath, { recursive: true, force: true })
  }
}

main()
