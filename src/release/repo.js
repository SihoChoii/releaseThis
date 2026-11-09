import { spawnSync } from 'node:child_process';

/** Normalize a GitHub remote URL to `owner/repo`, or null if not GitHub. */
export function parseGithubRepo(url) {
  if (!url || typeof url !== 'string') return null;
  const trimmed = url.trim().replace(/\.git$/i, '');
  const https = trimmed.match(/^https?:\/\/(?:[^@/\s]+@)?(?:www\.)?github\.com\/([^/]+)\/([^/]+?)\/?$/i);
  if (https) return `${https[1]}/${https[2]}`;
  const ssh = trimmed.match(/^git@github\.com:([^/]+)\/([^/]+?)\/?$/i);
  if (ssh) return `${ssh[1]}/${ssh[2]}`;
  const sshUrl = trimmed.match(/^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+?)\/?$/i);
  if (sshUrl) return `${sshUrl[1]}/${sshUrl[2]}`;
  return null;
}

/**
 * Resolve the host project's GitHub repo.
 * Prefers RELEASETHIS_REPO, then falls back to `git remote get-url origin`.
 * @returns {{ repo: string | null, source: 'env' | 'origin' | null }}
 */
export function detectGithubRepo(root, env = process.env) {
  const fromEnv = env.RELEASETHIS_REPO?.trim();
  if (fromEnv) {
    const parsed = parseGithubRepo(fromEnv.includes('://') || fromEnv.includes('@') ? fromEnv : `https://github.com/${fromEnv}`);
    return { repo: parsed || fromEnv.replace(/\.git$/i, ''), source: 'env' };
  }

  try {
    const result = spawnSync('git', ['remote', 'get-url', 'origin'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 5000,
    });
    if (result.status !== 0) return { repo: null, source: null };
    const repo = parseGithubRepo(result.stdout?.trim() || '');
    return { repo, source: repo ? 'origin' : null };
  } catch {
    return { repo: null, source: null };
  }
}
