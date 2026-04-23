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

  if (res.status === 409) {
    // SHA conflict — re-fetch current SHA and retry once
    const freshSha = await getFileSha(repoPath);
    const retryBody = { message: `migrate: ${repoPath}`, content };
    if (freshSha) retryBody.sha = freshSha;
    const retry = await fetch(`${GITHUB_API}/repos/${REPO}/contents/${repoPath}`, {
      method: 'PUT',
      headers: headers(),
      body: JSON.stringify(retryBody),
    });
    if (!retry.ok) {
      const text = await retry.text();
      throw new Error(`GitHub PUT ${repoPath}: ${retry.status} ${text}`);
    }
    return;
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub PUT ${repoPath}: ${res.status} ${text}`);
  }
}

export async function pushToGitHub(slug, localDir, onLog) {
  const allFiles = walkDir(localDir);
  let uploaded = 0;

  // Sequential uploads — avoids SHA race conditions (concurrent batches can collide)
  for (const filePath of allFiles) {
    const relPath = relative(localDir, filePath);
    const repoPath = `${slug}/${relPath}`;
    const content = readFileSync(filePath).toString('base64');

    const sha = await getFileSha(repoPath);
    await uploadFile(repoPath, content, sha);
    uploaded++;
    if (onLog) onLog(`  Uploaded ${repoPath} (${uploaded}/${allFiles.length})`);
  }

  return { filesUploaded: uploaded };
}
