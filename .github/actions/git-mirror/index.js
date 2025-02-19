const crypto = require('crypto')
const fs     = require('fs')
const os     = require('os')
const path   = require('path')
const { execFileSync, spawnSync } = require('child_process')


const inputNames = {
  sourceRepo:   'source-repo-url',
  targetRepo:   'target-github-repo',
  targetSshKey: 'target-ssh-key',
  targetToken:  'target-token',
}

const outputNames = {
  sourceRepo:       inputNames.sourceRepo,
  targetRepo:       inputNames.targetRepo,
  headCommitHash:   'head-commit-hash',
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

const START_TIME = Date.now()

///////////////////////////

function colorize(str, color) {
  return `${color}${str}${colors.reset}`
}

function sleep(seconds) {
    return new Promise(resolve => setTimeout(resolve, seconds * 1000))
}

function sleepSync(seconds) {
    const start = Date.now()
    while (Date.now() - start < seconds * 1000) {
        // Busy-wait loop
    }
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

function log(message) {
  function formatNum(prefix, num, suffix, len) {
    const str = num ? num.toString() : ''
    return colorize("0", colors.rgb(60)).repeat(len - str.length) + prefix + str + suffix
  }
  const elapsed = Date.now() - START_TIME
  const seconds = formatNum(colors.rgb(130, 100, 220), Math.floor(elapsed / 1000), colors.reset, 3)
  const milliseconds = formatNum(colors.rgb(100, 130, 255), elapsed % 1000, colors.reset, 3)
  
  const elapsedStr = [
    colorize("[", colors.rgb(170)),
    colorize("+", colors.rgb(130)),
    `${seconds}`,
    colorize(".", colors.blue),
    `${milliseconds}`,
    colorize("ms", colors.rgb(130)),
    colorize("]", colors.rgb(170)),
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

function exec(command, args, options = {}) {
  const backtick = colorize('`', colors.rgb(100))
  const cmd_str = [command, ...args].map(arg =>
    backtick + colorize(arg, colors.rgb(200)) + backtick
  ).join(' ')
  log(colorize(`🚀 Executing command: `, colors.magenta) + cmd_str)
  const output = execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'inherit'],
    ...options
  })

  sleepSync(0.1) // wait for 'inherit' stdout/stderr to finish printing
  
  return output
}

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

class CredentialManager {
  repo
  _secret
  get remoteUrl() { throw new Error('Method not implemented') }
  
  constructor(repo, secret) {
    this.repo = CredentialManager.parseAndValidateRepo(repo)
    if ( ! this.repo ) {
      throw new Error(`Invalid \`${inputNames.targetRepo}\` input. Received: \`${repo}\``)
    }

    this._secret = secret
    if ( ! this.constructor._validateSecret(secret) ) {
      throw new Error('Invalid secret format')
    }
  }

  static parseAndValidateRepo(inputRepo) {
    const repoRegex = /^(?:(?<owner>[a-zA-Z0-9_.-]+)\/)?(?<repo>[a-zA-Z0-9_.-]+)$/
    const match = inputRepo.match(repoRegex)
    if ( ! match ) {
      return ''
    }
  
    const owner = match.groups.owner || process.env.GITHUB_REPOSITORY_OWNER
    const repo = match.groups.repo
  
    return `${owner}/${repo}`
  }
  
  _validateSecret(secret) { throw new Error('Method not implemented') }
  _addSecret() { throw new Error('Method not implemented') }
  
  setupGlobal() {
    this._addSecret()
    this._secret = ''
  }

  teardownGlobal() { /* Default implementation does nothing */ }

  setupLocal() { /* Default implementation does nothing */ }

  teardownLocal() { /* Default implementation does nothing */ }
}

class SSHCredentialManager extends CredentialManager {
  static _sshKeyPattern = /^-----BEGIN (RSA|DSA|EC|OPENSSH) PRIVATE KEY-----/
  static _sshDir = path.join(os.homedir(), '.ssh')
  static _sshConfigPath = path.join(this._sshDir, 'config')

  static _validateSecret(secret) {
    return SSHCredentialManager._sshKeyPattern.test(secret)
  }

  get remoteUrl() {
    return `git@github.com:${this.repo}.git`
  }

  _addSecret() {
    log(colorize('🔐 Setting up SSH agent...', colors.blue))
    const sshAgentOutput = exec('ssh-agent', ['-s'])
    const match = sshAgentOutput.match(
      /SSH_AUTH_SOCK=(?<SSH_AUTH_SOCK>[^;]+).*SSH_AGENT_PID=(?<SSH_AGENT_PID>\d+)/s
    )
    if ( ! match ) {
      throw new Error('Failed to start SSH agent')
    }
    Object.assign(process.env, match.groups)
    
    log(colorize('🔑 Adding SSH key...', colors.yellow))
    exec('ssh-add', ['-vvv', '-'], { input: this._secret })
  
    fs.mkdirSync(SSHCredentialManager._sshDir, { recursive: true })
    this._appendToSSHConfig('StrictHostKeyChecking', 'no')
  }

  _appendToSSHConfig(key, value) {
    const configLine = `${key}=${value}\n`
    fs.appendFileSync(SSHCredentialManager._sshConfigPath, configLine)
  }

  teardownGlobal() {
    super.teardownGlobal()
    log(colorize('🔒 Stopping SSH agent...', colors.blue))
    if ( process.env.SSH_AGENT_PID ) {
      exec('ssh-agent', ['-k'])
    }
  }
}

class GitTokenCredentialManager extends CredentialManager {
  static _tokenPattern = /^[a-zA-Z0-9_-]{40}$/

  static _validateSecret(secret) {
    return GitTokenCredentialManager._tokenPattern.test(secret)
  }

  get _remoteUrlPath() {
    return `/${this.repo}.git`
  }

  get remoteUrl() {
    return `https://github.com${this._remoteUrlPath}`
  }

  _addSecret() {
    log(colorize('🔐 Setting up Git credential cache...', colors.blue))

    const gitCredentialInputObject = {
      protocol: 'https',
      host:     'github.com',
      path:     this._remoteUrlPath,
      username: 'x-access-token',
      password: this._secret,
    }
    const gitCredentialInput = Object.entries(gitCredentialInputObject)
      .map(([key, val]) => `${key}=${val}\n`)
      .join('')

    log(colorize('🔑 Adding GitHub token...', colors.yellow))
    exec('git', ['credential-cache', 'store'], { input: gitCredentialInput })
  }

  setupLocal() {
    super.setupLocal()
    exec('git', ['config', '--local', 'credential.helper', 'cache'])
  }

  teardownGlobal() {
    super.teardownGlobal()
    log(colorize('🔒 Clearing Git credential cache...', colors.blue))
    exec('git', ['credential-cache', 'exit'])
  }
}


async function main() {
  const inputs = new Inputs()
  let credentialManager = null

  // Input validation
  const requiredInputs = [inputNames.sourceRepo, inputNames.targetRepo]
  for (const input of requiredInputs) {
    if ( ! inputs[input] ) {
      prettyPrintEnv((name, value) => name.startsWith('INPUT_'))
      throw new Error(`Missing required input: \`${input}\``)
    }
  }
  setOutput(outputNames.sourceRepo, inputs[inputNames.sourceRepo])

  if ( ! inputs[inputNames.targetSshKey] === ! inputs[inputNames.targetToken] ) {
    throw new Error(`Provide either \`${inputNames.targetSshKey}\` or \`${inputNames.targetToken}\` input, not both though.`)
  }

  // Set up credential manager based on provided input
  if ( inputs[inputNames.targetSshKey] ) {
    credentialManager = new SSHCredentialManager(inputs[inputNames.targetRepo], inputs[inputNames.targetSshKey])
    delete inputs[inputNames.targetSshKey]
  } else if ( inputs[inputNames.targetToken] ) {
    credentialManager = new GitTokenCredentialManager(inputs[inputNames.targetRepo], inputs[inputNames.targetToken])
    delete inputs[inputNames.targetToken]
  } else {
    assert(false, 'No authentication method provided')
  }

  const targetRepo = credentialManager.repo
  setOutput(outputNames.targetRepo, targetRepo)

  const clonedRepoPath = fs.mkdtempSync(path.join(os.homedir(), `${targetRepo.split('/').join('--')}--`))
  fs.chmodSync(clonedRepoPath, 0o700)
  
  try {
    credentialManager.setupGlobal()

    // Clone source repository
    log(colorize('📥 Cloning source repository...', colors.cyan))
    // NOTE: never use `--progress` for `git clone -mirror`, it will make it several orders of magnitude slower
    exec('git', ['clone', '--verbose', '--mirror', '--', inputs[inputNames.sourceRepo], clonedRepoPath])

    // Mirror repository
    log(colorize('🔄 Mirroring repository...', colors.rgb(20, 230, 255)))
    await withCwd(clonedRepoPath, async () => {
      credentialManager.setupLocal()
      
      exec('git', ['push', '--verbose', '--progress', '--mirror', '--force', '--', credentialManager.remoteUrl])

      // Get last commit hash
      const lastCommitHash = exec('git', ['rev-parse', 'HEAD']).trim()
      setOutput(outputNames.headCommitHash, lastCommitHash)

      credentialManager.teardownLocal()
    })
    log(colorize('✅ Repository mirrored successfully!', colors.green))
  } catch (error) {
    log(colorize('❌ ' + error.message, colors.red))
    process.exitCode = 1
    throw error
  } finally {
    log(colorize('🧹 Cleaning up...', colors.yellow))
    if ( credentialManager ) {
      credentialManager.teardownGlobal()
    }
    fs.rmSync(clonedRepoPath, { recursive: true, force: true })
  }
}

main()
