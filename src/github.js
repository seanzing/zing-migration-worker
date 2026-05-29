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

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function gh(path, opts = {}, attempt = 0) {
  const res = await fetch(`${GITHUB_API}/repos/${REPO}${path}`, {
    ...opts,
    headers: { ...headers(), ...opts.headers },
  });
  const text = await res.text();
  // Retry on secondary rate limit (403 with rate limit message) or 429
  if ((res.status === 403 && text.includes('secondary rate limit')) || res.status === 429) {
    if (attempt < 5) {
      const backoff = Math.min(30000, 5000 * Math.pow(2, attempt)); // 5s, 10s, 20s, 30s, 30s
      console.log(`GitHub rate limit hit, retrying in ${backoff / 1000}s (attempt ${attempt + 1}/5)...`);
      await sleep(backoff);
      return gh(path, opts, attempt + 1);
    }
  }
  if (!res.ok) throw new Error(`GitHub ${opts.method || 'GET'} ${path}: ${res.status} ${text}`);
  return JSON.parse(text);
}

export async function pushToGitHub(slug, localDir, onLog) {
  const allFiles = walkDir(localDir);
  if (onLog) onLog(`  Creating ${allFiles.length} blobs...`);

  // 1. Create blobs for all files — 10 concurrent.
  //    GitHub secondary rate limits trigger on high concurrent mutation bursts;
  //    10 is safe even when multiple jobs are queued back-to-back.
  const BLOB_CONCURRENCY = 10;
  const blobShas = new Array(allFiles.length);
  let blobsDone = 0;

  for (let i = 0; i < allFiles.length; i += BLOB_CONCURRENCY) {
    const batch = allFiles.slice(i, i + BLOB_CONCURRENCY);
    await Promise.all(batch.map(async (filePath, j) => {
      const content = readFileSync(filePath).toString('base64');
      const blob = await gh('/git/blobs', {
        method: 'POST',
        body: JSON.stringify({ content, encoding: 'base64' }),
      });
      blobShas[i + j] = { filePath, sha: blob.sha };
      blobsDone++;
    }));
    if (onLog) onLog(`  Blobs: ${Math.min(i + BLOB_CONCURRENCY, allFiles.length)}/${allFiles.length}`);
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
