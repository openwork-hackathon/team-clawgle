/**
 * Public Deliverables Library
 * 
 * FREE to browse and search.
 * Completed work becomes discoverable by all agents.
 */

import { Hono } from 'hono';
import { getDb } from '../services/db.js';
import { uploadToIPFS, fetchFromIPFS, hashContent } from '../services/ipfs.js';

export const libraryRoutes = new Hono();

// ============================================================
// SEARCH (FREE - no auth required)
// ============================================================

/**
 * Full-text search across all public deliverables
 */
libraryRoutes.get('/search', async (c) => {
  const query = c.req.query('q');
  const limit = Math.min(parseInt(c.req.query('limit') || '20'), 100);
  const offset = parseInt(c.req.query('offset') || '0');
  const category = c.req.query('category');
  const skills = c.req.query('skills');

  if (!query) {
    return c.json({ error: 'Missing q parameter' }, 400);
  }

  const db = getDb();

  try {
    // Build query with filters
    let sql = `
      SELECT 
        t.escrow_id as escrowId,
        t.title,
        t.description,
        t.category,
        t.skills,
        t.amount,
        t.token,
        t.license,
        t.deliverable_summary as deliverableSummary,
        t.evidence_hash as evidenceHash,
        t.client,
        t.worker,
        t.completed_at as completedAt,
        t.made_public_at as madePublicAt,
        t.access_count as accessCount
      FROM tasks t
      JOIN tasks_fts fts ON t.rowid = fts.rowid
      WHERE t.is_public = 1
      AND tasks_fts MATCH ?
    `;
    const params: any[] = [query];

    if (category) {
      sql += ' AND t.category = ?';
      params.push(category);
    }
    if (skills) {
      sql += ' AND t.skills LIKE ?';
      params.push(`%${skills}%`);
    }

    sql += ' ORDER BY rank LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const results = db.prepare(sql).all(...params);

    // Get total count
    let countSql = `
      SELECT COUNT(*) as total
      FROM tasks t
      JOIN tasks_fts fts ON t.rowid = fts.rowid
      WHERE t.is_public = 1
      AND tasks_fts MATCH ?
    `;
    const countParams: any[] = [query];
    if (category) {
      countSql += ' AND t.category = ?';
      countParams.push(category);
    }
    const countResult = db.prepare(countSql).get(...countParams) as { total: number };

    return c.json({
      items: results.map(formatLibraryItem),
      total: countResult.total,
      query,
      limit,
      offset
    });
  } catch (err: any) {
    // FTS might not exist yet
    if (err.message.includes('no such table')) {
      return c.json({ items: [], total: 0, query, limit, offset });
    }
    throw err;
  }
});

/**
 * Browse public deliverables with filters
 */
libraryRoutes.get('/', async (c) => {
  const limit = Math.min(parseInt(c.req.query('limit') || '20'), 100);
  const offset = parseInt(c.req.query('offset') || '0');
  const category = c.req.query('category');
  const skills = c.req.query('skills');
  const license = c.req.query('license');
  const sort = c.req.query('sort') || 'recent';

  const db = getDb();

  const conditions: string[] = ['is_public = 1'];
  const params: any[] = [];

  if (category) {
    conditions.push('category = ?');
    params.push(category);
  }
  if (skills) {
    conditions.push('skills LIKE ?');
    params.push(`%${skills}%`);
  }
  if (license) {
    conditions.push('license = ?');
    params.push(license);
  }

  const where = `WHERE ${conditions.join(' AND ')}`;

  let orderBy: string;
  switch (sort) {
    case 'popular':
      orderBy = 'access_count DESC';
      break;
    case 'amount':
      orderBy = 'amount DESC';
      break;
    case 'recent':
    default:
      orderBy = 'made_public_at DESC';
  }

  const items = db.prepare(`
    SELECT 
      escrow_id as escrowId, title, description, category, skills,
      amount, token, license, deliverable_summary as deliverableSummary,
      evidence_hash as evidenceHash, client, worker, completed_at as completedAt,
      made_public_at as madePublicAt, access_count as accessCount
    FROM tasks
    ${where}
    ORDER BY ${orderBy}
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  const countResult = db.prepare(`
    SELECT COUNT(*) as total FROM tasks ${where}
  `).get(...params) as { total: number };

  return c.json({
    items: items.map(formatLibraryItem),
    total: countResult.total,
    limit,
    offset
  });
});

/**
 * Library statistics (must come before /:escrowId route)
 */
libraryRoutes.get('/stats', async (c) => {
  const db = getDb();

  const stats = db.prepare(`
    SELECT
      COUNT(*) as totalItems,
      SUM(access_count) as totalAccesses,
      COUNT(DISTINCT worker) as uniqueContributors
    FROM tasks
    WHERE is_public = 1
  `).get() as any;

  const topCategories = db.prepare(`
    SELECT category, COUNT(*) as count
    FROM tasks
    WHERE is_public = 1 AND category != ''
    GROUP BY category
    ORDER BY count DESC
    LIMIT 10
  `).all();

  const topSkills = db.prepare(`
    SELECT skills, COUNT(*) as count
    FROM tasks
    WHERE is_public = 1 AND skills != ''
    GROUP BY skills
    ORDER BY count DESC
    LIMIT 10
  `).all();

  const recentlyAdded = db.prepare(`
    SELECT COUNT(*) as count
    FROM tasks
    WHERE is_public = 1 AND made_public_at > ?
  `).get(Date.now() - 7 * 24 * 60 * 60 * 1000) as { count: number };

  const topContributors = db.prepare(`
    SELECT worker as address, COUNT(*) as contributions, SUM(access_count) as totalAccesses
    FROM tasks
    WHERE is_public = 1 AND worker IS NOT NULL
    GROUP BY worker
    ORDER BY contributions DESC
    LIMIT 10
  `).all();

  return c.json({
    ...stats,
    topCategories,
    topSkills,
    recentlyAdded: recentlyAdded?.count || 0,
    topContributors
  });
});

/**
 * Get single deliverable details (increments access count)
 */
libraryRoutes.get('/:escrowId', async (c) => {
  const escrowId = c.req.param('escrowId');
  const db = getDb();

  const item = db.prepare(`
    SELECT 
      escrow_id as escrowId, title, description, category, skills,
      amount, token, license, deliverable_summary as deliverableSummary,
      evidence_hash as evidenceHash, client, worker, completed_at as completedAt,
      made_public_at as madePublicAt, access_count as accessCount,
      success_criteria as successCriteria, deliverables
    FROM tasks
    WHERE escrow_id = ? AND is_public = 1
  `).get(escrowId) as any;

  if (!item) {
    return c.json({ error: 'Not found or not public' }, 404);
  }

  // Increment access count
  db.prepare(`
    UPDATE tasks SET access_count = access_count + 1
    WHERE escrow_id = ?
  `).run(escrowId);

  // Fetch full deliverable content if small enough
  let deliverableContent = null;
  if (item.evidenceHash) {
    try {
      const content = await fetchFromIPFS(item.evidenceHash);
      if (content && content.length < 50000) {
        deliverableContent = content;
      }
    } catch (err) {
      // Ignore fetch errors
    }
  }

  return c.json({
    ...formatLibraryItem(item),
    successCriteria: item.successCriteria,
    deliverables: item.deliverables ? JSON.parse(item.deliverables) : [],
    deliverableContent,
    rawEvidenceHash: item.evidenceHash
  });
});

// ============================================================
// PUBLISH (requires completed escrow)
// ============================================================

/**
 * Publish completed work to the library
 */
libraryRoutes.post('/:escrowId/publish', async (c) => {
  const escrowId = c.req.param('escrowId');
  const body = await c.req.json();
  const { from, license, summary } = body;

  if (!from) {
    return c.json({ error: 'Missing from address' }, 400);
  }
  if (!license || !['public-domain', 'attribution', 'non-commercial'].includes(license)) {
    return c.json({ error: 'Invalid license. Use: public-domain, attribution, non-commercial' }, 400);
  }

  const db = getDb();

  // Get the task
  const task = db.prepare(`
    SELECT escrow_id, client, worker, state, is_public, description
    FROM tasks WHERE escrow_id = ?
  `).get(escrowId) as any;

  if (!task) {
    return c.json({ error: 'Task not found' }, 404);
  }

  // Must be completed (Resolved state)
  if (task.state !== 'Resolved') {
    return c.json({ error: 'Task must be completed before publishing' }, 400);
  }

  // Must be client or worker
  const fromLower = from.toLowerCase();
  if (task.client?.toLowerCase() !== fromLower && task.worker?.toLowerCase() !== fromLower) {
    return c.json({ error: 'Only client or worker can publish' }, 403);
  }

  // Already public?
  if (task.is_public) {
    return c.json({ error: 'Already published' }, 400);
  }

  // Update task
  db.prepare(`
    UPDATE tasks SET
      is_public = 1,
      license = ?,
      deliverable_summary = ?,
      made_public_at = ?
    WHERE escrow_id = ?
  `).run(license, summary || task.description, Date.now(), escrowId);

  return c.json({
    success: true,
    escrowId,
    license,
    libraryUrl: `/v2/library/${escrowId}`
  });
});

// ============================================================
// HELPERS
// ============================================================

function formatLibraryItem(item: any) {
  // Handle skills - could be JSON array string or comma-separated
  let skills: string[] = [];
  if (item.skills) {
    if (item.skills.startsWith('[')) {
      try {
        skills = JSON.parse(item.skills);
      } catch {
        skills = item.skills.split(',').filter(Boolean);
      }
    } else {
      skills = item.skills.split(',').filter(Boolean);
    }
  }

  return {
    escrowId: item.escrowId,
    title: item.title,
    description: item.description,
    category: item.category,
    skills,
    amount: item.amount,
    token: item.token,
    license: item.license,
    summary: item.deliverableSummary,
    evidenceUri: item.evidenceHash ?
      (item.evidenceHash.startsWith('ipfs://') ?
        `https://gateway.pinata.cloud/ipfs/${item.evidenceHash.replace('ipfs://', '')}` :
        item.evidenceHash) :
      null,
    contributor: item.worker,
    client: item.client,
    completedAt: item.completedAt,
    publishedAt: item.madePublicAt,
    accessCount: item.accessCount || 0
  };
}
