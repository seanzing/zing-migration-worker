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

async function getFileSha(path) {
  const res = await fetch(`${GITHUB_API}/repos/${REPO}/contents/${path}`, {
    headers: headers(),
  });
  if (res.status === 404) return null;
  if (!res.ok) return null;
  const data = await res.json();
  return data.sha;
}

async function uploadFile(repoPath, content, sha) {
  const body = {
    message: `migrate: ${repoPath}`,
    content: content,
  };
  if (sha) body.sha = sha;

  const res = await fetch(`${GITHUB_API}/repos/${REPO}/contents/${repoPath}`, {
    method: 'PUT',
    headers: headers(),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub PUT ${repoPath}: ${res.status} ${text}`);
  }
}

export async function pushToGitHub(slug, localDir, onLog) {
  const allFiles = walkDir(localDir);
  let uploaded = 0;

  // Process in batches of 5 to avoid rate limits
  for (let i = 0; i < allFiles.length; i += 5) {
    const batch = allFiles.slice(i, i + 5);
    await Promise.all(batch.map(async (filePath) => {
      const relPath = relative(localDir, filePath);
      const repoPath = `${slug}/${relPath}`;
      const content = readFileSync(filePath).toString('base64');

      // Check if file exists to get SHA for update
      const sha = await getFileSha(repoPath);
      await uploadFile(repoPath, content, sha);
      uploaded++;
      if (onLog) onLog(`  Uploaded ${repoPath} (${uploaded}/${allFiles.length})`);
    }));
  }

  return { filesUploaded: uploaded };
}
