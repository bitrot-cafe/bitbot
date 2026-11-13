import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { pluginsDir } from './config.js';

const exec = promisify(execFile);

/**
 * The environment for git and npm: enough to run, without the bot's own variables (the token,
 * DATABASE_URL, settings pinned in env), so they aren't handed to a dependency's install script directly.
 * This is not isolation: install scripts run as the bot's user, so they can still read the secret files
 * (/run/secrets/*), the SQLite database, and the bot process's environment through /proc. Only enable
 * plugins whose dependencies you trust.
 */
const PASSED_ENV = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'TZ', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR'];
function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    GIT_TERMINAL_PROMPT: '0', // never wait for a password prompt
    // Git looks for a repository in parent folders too. A folder in repos/ without its own .git would
    // otherwise resolve to whatever checkout PLUGINS_DIR sits in (the dev checkout), and repair would
    // reset that. Stop the search at repos/.
    GIT_CEILING_DIRECTORIES: join(pluginsDir, 'repos'),
  };
  for (const name of PASSED_ENV) if (process.env[name] !== undefined) env[name] = process.env[name];
  return env;
}

/** Run a command (never through a shell) with the reduced environment. Throws its last error lines. */
export async function runCommand(cmd: string, args: string[], cwd: string, timeoutMs = 120_000) {
  try {
    const { stdout } = await exec(cmd, args, { cwd, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024, env: childEnv() });
    return stdout.trim();
  } catch (error) {
    const e = error as { stderr?: string; message: string };
    throw new Error(`${cmd} ${args[0]} failed: ${(e.stderr || e.message).trim().split('\n').slice(-3).join(' ')}`);
  }
}

