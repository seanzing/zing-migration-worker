import 'dotenv/config';
import express from 'express';
import { createJob, enqueue, getJob, getAllJobs, deleteJob, getJobCount } from './jobs.js';

const app = express();
app.use(express.json());

// CORS
const DASHBOARD_ORIGIN = process.env.PIXEL_DASHBOARD_URL || '';
app.use((req, res, next) => {
  if (DASHBOARD_ORIGIN) {
    res.header('Access-Control-Allow-Origin', DASHBOARD_ORIGIN);
    res.header('Access-Control-Allow-Headers', 'Content-Type, X-Migration-Secret');
    res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Auth middleware (skip for /health)
function auth(req, res, next) {
  const secret = req.headers['x-migration-secret'];
  if (secret !== process.env.MIGRATION_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// Health
app.get('/health', (req, res) => {
  res.json({ status: 'ok', jobs: getJobCount() });
});

// Emergency shutdown — kills this instance so Railway replaces it
app.post('/admin/shutdown', auth, (req, res) => {
  res.json({ bye: true });
  // Exit code 1 so Railway treats this as a crash and restarts the container
  setTimeout(() => process.exit(1), 200);
});

// Create job(s)
app.post('/jobs', auth, (req, res) => {
  const { url, slug, name, sites } = req.body;

  if (sites && Array.isArray(sites)) {
    const jobIds = [];
    for (const site of sites) {
      if (!site.url) continue;
      const job = createJob(site.url, site.slug || null, site.name || '');
      enqueue(job);
      jobIds.push(job.id);
    }
    return res.json({ jobIds });
  }

  if (!url) {
    return res.status(400).json({ error: 'url is required' });
  }

  const job = createJob(url, slug || null, name || '');
  enqueue(job);
  res.json({ jobId: job.id, siteId: job.slug });
});

// List all jobs
app.get('/jobs', auth, (req, res) => {
  res.json(getAllJobs());
});

// Single job status
app.get('/jobs/:id', auth, (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  res.json({
    id: job.id,
    url: job.url,
    slug: job.slug,
    name: job.name,
    status: job.status,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    error: job.error,
    result: job.result,
    logs: job.logs.slice(-50),
  });
});

// SSE stream
app.get('/jobs/:id/stream', auth, (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    ...(DASHBOARD_ORIGIN ? { 'Access-Control-Allow-Origin': DASHBOARD_ORIGIN } : {}),
  });

  // Send existing logs
  for (const line of job.logs) {
    res.write(`data: ${line}\n\n`);
  }

  // If already done/error, close immediately
  if (job.status === 'done' || job.status === 'error') {
    res.end();
    return;
  }

  // Subscribe for live updates
  job.subscribers.add(res);
  req.on('close', () => {
    job.subscribers.delete(res);
  });
});

// Delete job
app.delete('/jobs/:id', auth, (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  if (!deleteJob(req.params.id)) {
    return res.status(400).json({ error: 'Cannot delete a running job' });
  }
  res.json({ deleted: true });
});

// Return scraped site files as a ZIP archive — no GitHub/CF Pages needed.
// Works as long as the files still exist in /tmp/migrations/{slug}/.
app.get('/jobs/:id/zip', auth, async (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.status === 'running') return res.status(409).json({ error: 'Job still running — wait for completion' });

  const { join } = await import('path');
  const { createReadStream, existsSync } = await import('fs');
  const { exec } = await import('child_process');
  const { promisify } = await import('util');
  const execAsync = promisify(exec);

  const siteDir = join('/tmp/migrations', job.slug);
  if (!existsSync(siteDir)) {
    return res.status(404).json({ error: 'Site files not found — they may have been cleaned up. Re-run the job.' });
  }

  const zipPath = join('/tmp', `${job.slug}.zip`);
  try {
    await execAsync(`cd '${siteDir}' && zip -r '${zipPath}' .`);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${job.slug}.zip"`);
    createReadStream(zipPath).pipe(res);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


const PORT = process.env.PORT || 3010;
app.listen(PORT, () => {
  console.log(`Migration worker listening on port ${PORT}`);
});
