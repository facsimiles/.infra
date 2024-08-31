const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const crypto = require('crypto');

// ANSI color codes
const colors = {
  reset: '\x1b[0m',

  bold: "\x1b[1m",
  underline: "\x1b[4m",
  
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
}

// Class to handle inputs using Proxy
class Inputs {
  constructor() {
    return new Proxy(this, {
      get: (target, prop) => process.env[`INPUT_${prop.toUpperCase()}`]
    });
  }
}

// Instantiate Inputs class
const inputs = new Inputs();

// Function to get the elapsed time since the start of the script
const START_TIME = Date.now();

// Logging function with colors and emojis
function log(message, color = 'reset', emoji = '') {
  const elapsed = Date.now() - START_TIME
  const seconds = Math.floor(elapsed / 1000).toString().padStart(3, '0')
  const milliseconds = (elapsed % 1000).toString().padStart(3, '0')
  const elapsedStr = `[+${seconds}.${milliseconds}ms]`
  
  console.log(`${colors.cyan}${elapsedStr}${colors.reset} ${colors[color]}${emoji} ${message}${colors.reset}`)
}

function prettyPrintEnv(filterCallback) {
  console.log(
    `${colors.bold}${colors.underline}${colors.blue}` +
    `Environment Variables:` +
    `${colors.reset}`
  )

  for (const [name, value] of Object.entries(process.env)) {
    if (filterCallback && ! filterCallback(name, value)) {
      continue
    }

    let displayValue = value
    if (value.length > 255 || value.includes('\n')) {
      displayValue = value.slice(0, 252) + '...'
    }

    console.log(
      `  ${colors.green}${name}${colors.reset}: ` +
      `${colors.yellow}${displayValue}${colors.reset}`
    )
  }
}


// Function to execute shell commands
function exec(command, args, options = {}) {
  const cmd_str = [command, ...args].map(arg => `\`${arg}\``).join(' ')
  try {
    console.log(`::debug::Executing command: ${cmd_str}`)
    return execFileSync(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
      ...options
    })
  } catch (error) {
    log(`Error executing command: ${cmd_str}`, 'red', '❌')
    log(error.message, 'red')
    throw error
  }
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


// Main function
async function main() {
  const sshDir = path.join(os.homedir(), '.ssh')
  const sshSourceKeyPath  = path.join(sshDir, 'source_key')
  const sshTargetKeyPath  = path.join(sshDir, 'target_key')
  const sshConfigPath     = path.join(sshDir, 'config')
  const sshKnownHostsPath = path.join(sshDir, 'known_hosts')

  const clonedRepoPath = fs.mkdtempSync(path.join(os.homedir(), 'cloned-repo.'))

  try {
    // Input validation
    const requiredInputs = ['source-repo', 'target-repo']
    for (const input of requiredInputs) {
      if (!inputs[input]) {
        prettyPrintEnv((name, value) => name.startsWith('INPUT_'))
        throw new Error(`Missing required input: ${input}`)
      }
    }

    if (!inputs['target-ssh-key'] && !inputs['target-token']) {
      throw new Error('Either target-ssh-key or target-token must be provided')
    }

    // Set up SSH keys if provided
    if (inputs['source-ssh-key'] || inputs['target-ssh-key']) {
      log('Setting up SSH keys...', 'blue', '🔑')
      fs.mkdirSync(sshDir, { recursive: true })

      if (inputs['source-ssh-key']) {
        fs.writeFileSync(sshSourceKeyPath, inputs['source-ssh-key'], { mode: 0o600 })
        fs.appendFileSync(sshConfigPath, `IdentityFile ${sshSourceKeyPath}\n`)
      }

      if (inputs['target-ssh-key']) {
        fs.writeFileSync(sshTargetKeyPath, inputs['target-ssh-key'], { mode: 0o600 })
        fs.appendFileSync(sshConfigPath, `IdentityFile ${sshTargetKeyPath}\n`)
      }

      const output = exec('ssh-keyscan', ['-H', 'github.com'])
      fs.appendFileSync(sshKnownHostsPath, output)
    }

    // Clone source repository
    log('Cloning source repository...', 'cyan', '📥')
    exec('git', ['clone', '--mirror', inputs['source-repo'], clonedRepoPath])

    // Set up target repository URL
    let targetRepoUrl;
    if (inputs['target-ssh-key']) {
      targetRepoUrl = inputs['target-repo']
    } else {
      const repoPath = inputs['target-repo'].replace('https://github.com/', '')
      targetRepoUrl = `https://x-access-token:${inputs['target-token']}@github.com/${repoPath}`
    }

    // Mirror repository
    log('Mirroring repository...', 'green', '🔄')
    withCwd(clonedRepoPath, async () => {
      exec('git', ['push', '--verbose', '--mirror', targetRepoUrl])
  
      // Get mirrored branches
      const branches = exec('git', ['branch', '-r']).split('\n')
        .map(branch => branch.trim().replace('origin/', ''))
        .filter(Boolean)
      setOutput('mirrored-branches', JSON.stringify(branches))
  
      // Get last commit hash
      const lastCommitHash = exec('git', ['rev-parse', 'HEAD']).trim()
      setOutput('last-commit-hash', lastCommitHash)
    })
    log('Repository mirrored successfully!', 'green', '✅')
  } catch (error) {
    log(error.message, 'red', '❌')
    process.exit(1)
  } finally {
    // Clean up
    log('Cleaning up...', 'yellow', '🧹');
    fs.rmSync(sshSourceKeyPath, { force: true })
    fs.rmSync(sshTargetKeyPath, { force: true })
    fs.rmSync(clonedRepoPath, { recursive: true, force: true })
  }
}

main()
