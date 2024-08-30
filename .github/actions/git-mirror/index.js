const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
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


function prettyPrintEnv() {
  console.log(
    `${colors.bold}${colors.underline}${colors.blue}` +
    `Environment Variables:` +
    `${colors.reset}`
  );
  for (const [key, value] of Object.entries(process.env)) {
    let displayValue = value;
    if (value.length > 255 || value.includes('\n')) {
      displayValue = value.slice(0, 252) + '...';
    }
    console.log(
      `${colors.green}${key}${colors.reset}: ` +
      `${colors.yellow}${displayValue}${colors.reset}`
    );
  }
}

// Logging function with colors and emojis
function log(message, color = 'reset', emoji = '') {
  console.log(`${colors[color]}${emoji} ${message}${colors.reset}`);
}

// Function to execute shell commands
function exec(command) {
  try {
    return execSync(command, { encoding: 'utf8', stdio: 'pipe' });
  } catch (error) {
    log(`Error executing command: ${command}`, 'red', '❌');
    log(error.message, 'red');
    process.exit(1);
  }
}

// Function to set output for GitHub Actions
function setOutput(name, value) {
  const uuid = crypto.randomUUID();
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}<<${uuid}\n${value}\n${uuid}\n`);
}

// Helper function to get input from environment variables
function getInput(name) {
  return process.env[`INPUT_${name.toUpperCase()}`];
}

// Main function
async function main() {
  // prettyPrintEnv()
  
  try {
    // Input validation
    const requiredInputs = ['source-repo', 'target-repo'];
    for (const input of requiredInputs) {
      if (!getInput(input)) {
        throw new Error(`Missing required input: ${input}`);
      }
    }

    if (!getInput('target-ssh-key') && !getInput('target-token')) {
      throw new Error('Either target-ssh-key or target-token must be provided');
    }

    // Set up SSH keys if provided
    if (getInput('source-ssh-key') || getInput('target-ssh-key')) {
      log('Setting up SSH keys...', 'blue', '🔑');
      const sshDir = path.join(process.env.HOME, '.ssh');
      fs.mkdirSync(sshDir, { recursive: true });

      if (getInput('source-ssh-key')) {
        fs.writeFileSync(path.join(sshDir, 'source_key'), getInput('source-ssh-key'), { mode: 0o600 });
        fs.appendFileSync(path.join(sshDir, 'config'), 'IdentityFile ~/.ssh/source_key\n');
      }

      if (getInput('target-ssh-key')) {
        fs.writeFileSync(path.join(sshDir, 'target_key'), getInput('target-ssh-key'), { mode: 0o600 });
        fs.appendFileSync(path.join(sshDir, 'config'), 'IdentityFile ~/.ssh/target_key\n');
      }

      exec('ssh-keyscan -H github.com >> ~/.ssh/known_hosts');
    }

    // Clone source repository
    log('Cloning source repository...', 'cyan', '📥');
    exec(`git clone --mirror ${getInput('source-repo')} source_repo`);
    const sourceRepoPath = path.join(process.cwd(), 'source_repo');
    setOutput('source-repo-path', sourceRepoPath);

    // Set up target repository URL
    let targetRepoUrl;
    if (getInput('target-ssh-key')) {
      targetRepoUrl = getInput('target-repo');
    } else {
      const repoPath = getInput('target-repo').replace('https://github.com/', '');
      targetRepoUrl = `https://x-access-token:${getInput('target-token')}@github.com/${repoPath}`;
    }
    setOutput('target-repo-path', targetRepoUrl);

    // Mirror repository
    log('Mirroring repository...', 'green', '🔄');
    process.chdir(sourceRepoPath);
    exec(`git push --mirror ${targetRepoUrl}`);

    // Get mirrored branches
    const branches = exec('git branch -r').split('\n')
      .map(branch => branch.trim().replace('origin/', ''))
      .filter(Boolean);
    setOutput('mirrored-branches', branches.join(','));

    // Get last commit hash
    const lastCommitHash = exec('git rev-parse HEAD').trim();
    setOutput('last-commit-hash', lastCommitHash);

    log('Repository mirrored successfully!', 'green', '✅');
  } catch (error) {
    log(error.message, 'red', '❌');
    process.exit(1);
  } finally {
    // Clean up
    log('Cleaning up...', 'yellow', '🧹');
    fs.rmSync(path.join(process.env.HOME, '.ssh', 'source_key'), { force: true });
    fs.rmSync(path.join(process.env.HOME, '.ssh', 'target_key'), { force: true });
    fs.rmSync(path.join(process.cwd(), 'source_repo'), { recursive: true, force: true });
  }
}

main();
