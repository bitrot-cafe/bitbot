import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/*
 * Which build is running. Images get BITBOT_VERSION / BITBOT_COMMIT baked in by CI (see the
 * Containerfile). A dev checkout reads .git directly, which needs no git binary.
 */

const root = fileURLToPath(new URL('../', import.meta.url));
const read = (path: string) => {
  try {
    return readFileSync(root + path, 'utf8').trim();
  } catch {
    return null;
  }
};

/** HEAD's commit from .git: a detached hash, a loose ref, or an entry in packed-refs. */
function gitCommit(): string | null {
  const head = read('.git/HEAD');
  if (!head) return null;
  if (!head.startsWith('ref: ')) return head;
  const ref = head.slice(5);
  return read(`.git/${ref}`) ?? read('.git/packed-refs')?.split('\n').find((l) => l.endsWith(` ${ref}`))?.split(' ')[0] ?? null;
}

const packageVersion = () => {
  try {
    return JSON.parse(read('package.json') ?? '{}').version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
};

const commit = process.env.BITBOT_COMMIT || gitCommit() || 'unknown';

export const build = {
  /** Release version from the image tag, or package.json's (+dev) in a checkout. */
  version: process.env.BITBOT_VERSION || `${packageVersion()}+dev`,
  /** Short commit hash, or "unknown". */
  commit: commit === 'unknown' ? commit : commit.slice(0, 7),
};
