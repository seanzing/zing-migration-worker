import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

const GITHUB_API = 'https://api.github.com';
const REPO = process.env.GITHUB_SITES_REPO;
const TOKEN = process.env.GITHUB_TOKEN;

function headers() {
  return {
    Authorization: `Bearer ${TOKEN}`,
    Accept: 'application/vnd.github.v3+json',
    'Content-Type': 'application/json',
  };
}

function walkDir(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkDir(fullPath));
    } else {
      files.push(fullPath);
    }
  }
  return files;
}

async function gh(path, opts = {}) {
  const res = await fetch(`${GITHUB_API}/repos/${REPO}${path}`, {
    ...opts,
    headers: { ...headers(), ...opts.headers },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`GitHub ${opts.method || 'GET'} ${path}: ${res.status} ${text}`);
  return JSON.parse(text);
}

export async function pushToGitHub(slug, localDir, onLog) {
  const allFiles = walkDir(localDir);
  if (onLog) onLog(`  Creating ${allFiles.length} blobs...`);

  // 1. Create blobs for all files (parallel batches of 10)
  const blobShas = [];
  for (let i = 0; i < allFiles.length; i += 10) {
    const batch = allFiles.slice(i, i + 10);
    const results = await Promise.all(batch.map(async (filePath) => {
      const content = readFileSync(filePath).toString('base64');
      const blob = await gh('/git/blobs', {
        method: 'POST',
        body: JSON.stringify({ content, encoding: 'base64' }),
      });
      return { filePath, sha: blob.sha };
    }));
    blobShas.push(...results);
    if (onLog) onLog(`  Blobs: ${Math.min(i + 10, allFiles.length)}/${allFiles.length}`);
  }

  // 2. Get current HEAD commit and tree SHA
  const ref = await gh('/git/ref/heads/main');
  const headSha = ref.object.sha;
  const headCommit = await gh(`/git/commits/${headSha}`);
  const baseTreeSha = headCommit.tree.sha;

  // 3. Create new tree with all files
  if (onLog) onLog('  Building tree...');
  const treeItems = blobShas.map(({ filePath, sha }) => {
    const relPath = relative(localDir, filePath);
    return {
      path: `${slug}/${relPath}`,
      mode: '100644',
      type: 'blob',
      sha,
    };
  });
  const tree = await gh('/git/trees', {
    method: 'POST',
    body: JSON.stringify({ base_tree: baseTreeSha, tree: treeItems }),
  });

  // 4. Create commit
  if (onLog) onLog('  Committing...');
  const commit = await gh('/git/commits', {
    method: 'POST',
    body: JSON.stringify({
      message: `migrate: add ${slug} (${allFiles.length} files)`,
      tree: tree.sha,
      parents: [headSha],
    }),
  });

  // 5. Update ref
  await gh('/git/refs/heads/main', {
    method: 'PATCH',
    body: JSON.stringify({ sha: commit.sha }),
  });

  if (onLog) onLog(`  ✅ Pushed ${allFiles.length} files in 1 commit (${commit.sha.slice(0, 7)})`);
  return { filesUploaded: allFiles.length };
}
