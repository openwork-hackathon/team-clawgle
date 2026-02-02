import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { TaskRow, TaskSearchParams, EscrowState } from '../types/marketplace.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../../data/marketplace.db');

let db: Database.Database | null = null;

export function getDb(): Database.Database {

  if (!db) {
    // Ensure data directory exists
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    initSchema();
  }
  return db;
}

export function pingDb(): boolean {
  try {
    const database = getDb();
    database.prepare('SELECT 1 as ok').get();
    return true;
  } catch {
    return false;
  }
}

function initSchema() {
  const database = db!;

  database.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      escrow_id TEXT PRIMARY KEY,
      client TEXT NOT NULL,
      worker TEXT,
      token TEXT NOT NULL,
      amount TEXT NOT NULL,
      deadline INTEGER NOT NULL,
      criteria_hash TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'Pending',
      created_at INTEGER NOT NULL,
      review_period INTEGER NOT NULL DEFAULT 0,

      -- From IPFS metadata
      title TEXT,
      description TEXT,
      category TEXT,
      skills TEXT,
      success_criteria TEXT,
      deliverables TEXT,

      -- Library fields
      is_public INTEGER DEFAULT 0,
      license TEXT,
      deliverable_summary TEXT,
      evidence_hash TEXT,
      completed_at INTEGER,
      made_public_at INTEGER,
      access_count INTEGER DEFAULT 0,

      indexed_at INTEGER NOT NULL,
      block_number INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_state ON tasks(state);
    CREATE INDEX IF NOT EXISTS idx_tasks_category ON tasks(category);
    CREATE INDEX IF NOT EXISTS idx_tasks_deadline ON tasks(deadline);
    CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks(created_at);
    CREATE INDEX IF NOT EXISTS idx_tasks_is_public ON tasks(is_public);
    CREATE INDEX IF NOT EXISTS idx_tasks_made_public_at ON tasks(made_public_at);

    -- Metadata table for indexer state
    CREATE TABLE IF NOT EXISTS indexer_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- Full-text search for library
    CREATE VIRTUAL TABLE IF NOT EXISTS tasks_fts USING fts5(
      escrow_id,
      title,
      description,
      skills,
      category,
      deliverable_summary,
      content='tasks',
      content_rowid='rowid'
    );

    -- Triggers to keep FTS in sync
    -- Note: tasks_fts only contains PUBLIC tasks (is_public = 1)
    CREATE TRIGGER IF NOT EXISTS tasks_ai AFTER INSERT ON tasks WHEN new.is_public = 1 BEGIN
      INSERT INTO tasks_fts(rowid, escrow_id, title, description, skills, category, deliverable_summary)
      VALUES (new.rowid, new.escrow_id, new.title, new.description, new.skills, new.category, new.deliverable_summary);
    END;

    -- When a public task is updated, refresh its FTS row
    -- When a task becomes public, add it to FTS
    CREATE TRIGGER IF NOT EXISTS tasks_au_public AFTER UPDATE ON tasks WHEN new.is_public = 1 BEGIN
      DELETE FROM tasks_fts WHERE rowid = old.rowid;
      INSERT INTO tasks_fts(rowid, escrow_id, title, description, skills, category, deliverable_summary)
      VALUES (new.rowid, new.escrow_id, new.title, new.description, new.skills, new.category, new.deliverable_summary);
    END;

    -- When a task is unpublished, remove it from FTS
    CREATE TRIGGER IF NOT EXISTS tasks_au_unpublic AFTER UPDATE ON tasks WHEN new.is_public = 0 AND old.is_public = 1 BEGIN
      DELETE FROM tasks_fts WHERE rowid = old.rowid;
    END;

    -- When a task is deleted, remove it from FTS
    CREATE TRIGGER IF NOT EXISTS tasks_ad AFTER DELETE ON tasks BEGIN
      DELETE FROM tasks_fts WHERE rowid = old.rowid;
    END;

    -- =========================================
    -- SETTLE Token / Airdrop / Referral Tables
    -- =========================================

    -- Agents table for airdrop and referral tracking
    CREATE TABLE IF NOT EXISTS agents (
      address TEXT PRIMARY KEY,
      referred_by TEXT,
      referral_earnings INTEGER DEFAULT 0,
      tasks_completed INTEGER DEFAULT 0,
      bounties_posted INTEGER DEFAULT 0,
      airdrop_claimed INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (referred_by) REFERENCES agents(address)
    );

    CREATE INDEX IF NOT EXISTS idx_agents_referred_by ON agents(referred_by);
    CREATE INDEX IF NOT EXISTS idx_agents_referral_earnings ON agents(referral_earnings);

    -- Social claims for post-to-earn
    CREATE TABLE IF NOT EXISTS social_claims (
      id TEXT PRIMARY KEY,
      agent_address TEXT NOT NULL,
      platform TEXT NOT NULL,
      post_url TEXT UNIQUE NOT NULL,
      claimed_at INTEGER NOT NULL,
      payout INTEGER NOT NULL,
      FOREIGN KEY (agent_address) REFERENCES agents(address)
    );

    CREATE INDEX IF NOT EXISTS idx_social_claims_agent ON social_claims(agent_address);
    CREATE INDEX IF NOT EXISTS idx_social_claims_platform ON social_claims(platform);
    CREATE INDEX IF NOT EXISTS idx_social_claims_claimed_at ON social_claims(claimed_at);

    -- Agent milestones (one-time bonuses)
    CREATE TABLE IF NOT EXISTS agent_milestones (
      agent_address TEXT NOT NULL,
      milestone TEXT NOT NULL,
      completed_at INTEGER NOT NULL,
      payout INTEGER NOT NULL,
      PRIMARY KEY (agent_address, milestone),
      FOREIGN KEY (agent_address) REFERENCES agents(address)
    );
  `);
}

// Insert or update a task
export function upsertTask(task: Omit<TaskRow, 'indexed_at'> & { indexed_at?: number }): void {
  const database = getDb();
  const stmt = database.prepare(`
    INSERT INTO tasks (
      escrow_id, client, worker, token, amount, deadline, criteria_hash,
      state, created_at, review_period, title, description, category, skills,
      indexed_at, block_number
    ) VALUES (
      @escrow_id, @client, @worker, @token, @amount, @deadline, @criteria_hash,
      @state, @created_at, @review_period, @title, @description, @category, @skills,
      @indexed_at, @block_number
    ) ON CONFLICT(escrow_id) DO UPDATE SET
      worker = @worker,
      state = @state,
      title = COALESCE(@title, title),
      description = COALESCE(@description, description),
      category = COALESCE(@category, category),
      skills = COALESCE(@skills, skills),
      indexed_at = @indexed_at
  `);

  stmt.run({
    ...task,
    indexed_at: task.indexed_at || Date.now(),
  });
}

// Update task state (when worker accepts, etc.)
export function updateTaskState(escrowId: string, state: EscrowState, worker?: string): void {
  const database = getDb();
  if (worker) {
    database.prepare('UPDATE tasks SET state = ?, worker = ?, indexed_at = ? WHERE escrow_id = ?')
      .run(state, worker, Date.now(), escrowId);
  } else {
    database.prepare('UPDATE tasks SET state = ?, indexed_at = ? WHERE escrow_id = ?')
      .run(state, Date.now(), escrowId);
  }
}

// Get a single task by escrowId
export function getTask(escrowId: string): TaskRow | undefined {
  const database = getDb();
  return database.prepare('SELECT * FROM tasks WHERE escrow_id = ?').get(escrowId) as TaskRow | undefined;
}

// Search tasks with filters
export function searchTasks(params: TaskSearchParams): { tasks: TaskRow[]; total: number } {
  const database = getDb();

  const conditions: string[] = [];
  const values: any[] = [];

  // Default to Pending state if not specified
  const state = params.state || 'Pending';
  conditions.push('state = ?');
  values.push(state);

  if (params.category) {
    conditions.push('category = ?');
    values.push(params.category);
  }

  if (params.token) {
    conditions.push('token = ?');
    values.push(params.token);
  }

  if (params.minAmount) {
    conditions.push('CAST(amount AS INTEGER) >= ?');
    values.push(params.minAmount);
  }

  if (params.maxAmount) {
    conditions.push('CAST(amount AS INTEGER) <= ?');
    values.push(params.maxAmount);
  }

  if (params.skills && params.skills.length > 0) {
    // Match any of the skills (OR logic)
    const skillConditions = params.skills.map(() => 'skills LIKE ?');
    conditions.push(`(${skillConditions.join(' OR ')})`);
    params.skills.forEach(skill => values.push(`%"${skill}"%`));
  }

  if (params.q) {
    // Simple text search on title and description
    conditions.push('(title LIKE ? OR description LIKE ?)');
    values.push(`%${params.q}%`, `%${params.q}%`);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  // Sort
  let orderClause = 'ORDER BY created_at DESC';
  if (params.sort === 'amount_desc') {
    orderClause = 'ORDER BY CAST(amount AS INTEGER) DESC';
  } else if (params.sort === 'deadline_asc') {
    orderClause = 'ORDER BY deadline ASC';
  }

  // Pagination
  const limit = params.limit || 20;
  const offset = params.offset || 0;

  // Get total count
  const countStmt = database.prepare(`SELECT COUNT(*) as count FROM tasks ${whereClause}`);
  const { count: total } = countStmt.get(...values) as { count: number };

  // Get paginated results
  const queryStmt = database.prepare(`
    SELECT * FROM tasks ${whereClause} ${orderClause} LIMIT ? OFFSET ?
  `);
  const tasks = queryStmt.all(...values, limit, offset) as TaskRow[];

  return { tasks, total };
}

// Get/set indexer state
export function getIndexerState(key: string): string | null {
  const database = getDb();
  const row = database.prepare('SELECT value FROM indexer_state WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value || null;
}

export function setIndexerState(key: string, value: string): void {
  const database = getDb();
  database.prepare('INSERT OR REPLACE INTO indexer_state (key, value) VALUES (?, ?)').run(key, value);
}

// Get last indexed block
export function getLastIndexedBlock(): bigint {
  const value = getIndexerState('last_block');
  return value ? BigInt(value) : 0n;
}

export function setLastIndexedBlock(blockNumber: bigint): void {
  setIndexerState('last_block', blockNumber.toString());
}

// Close database connection
export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

// =========================================
// Agent / Airdrop / Referral Functions
// =========================================

export interface AgentRow {
  address: string;
  referred_by: string | null;
  referral_earnings: number;
  tasks_completed: number;
  bounties_posted: number;
  airdrop_claimed: number;
  created_at: number;
}

export interface SocialClaimRow {
  id: string;
  agent_address: string;
  platform: string;
  post_url: string;
  claimed_at: number;
  payout: number;
}

export interface MilestoneRow {
  agent_address: string;
  milestone: string;
  completed_at: number;
  payout: number;
}

// Get or create an agent
export function getOrCreateAgent(address: string, referredBy?: string): AgentRow {
  const database = getDb();
  const existing = database.prepare('SELECT * FROM agents WHERE address = ?').get(address) as AgentRow | undefined;

  if (existing) {
    return existing;
  }

  // Create new agent
  const now = Math.floor(Date.now() / 1000);
  database.prepare(`
    INSERT INTO agents (address, referred_by, created_at)
    VALUES (?, ?, ?)
  `).run(address, referredBy || null, now);

  return database.prepare('SELECT * FROM agents WHERE address = ?').get(address) as AgentRow;
}

// Get agent by address
export function getAgent(address: string): AgentRow | undefined {
  const database = getDb();
  return database.prepare('SELECT * FROM agents WHERE address = ?').get(address) as AgentRow | undefined;
}

// Mark airdrop as claimed
export function markAirdropClaimed(address: string): void {
  const database = getDb();
  database.prepare('UPDATE agents SET airdrop_claimed = 1 WHERE address = ?').run(address);
}

// Increment task completed count
export function incrementTasksCompleted(address: string): void {
  const database = getDb();
  database.prepare('UPDATE agents SET tasks_completed = tasks_completed + 1 WHERE address = ?').run(address);
}

// Increment bounties posted count
export function incrementBountiesPosted(address: string): void {
  const database = getDb();
  database.prepare('UPDATE agents SET bounties_posted = bounties_posted + 1 WHERE address = ?').run(address);
}

// Add referral earnings
export function addReferralEarnings(referrerAddress: string, amount: number): void {
  const database = getDb();
  database.prepare('UPDATE agents SET referral_earnings = referral_earnings + ? WHERE address = ?')
    .run(amount, referrerAddress);
}

// Get referral stats for an agent
export function getReferralStats(address: string): { referralCount: number; totalEarnings: number } {
  const database = getDb();
  const count = database.prepare('SELECT COUNT(*) as count FROM agents WHERE referred_by = ?')
    .get(address) as { count: number };
  const agent = getAgent(address);

  return {
    referralCount: count?.count || 0,
    totalEarnings: agent?.referral_earnings || 0,
  };
}

// Get referees (agents referred by this address)
export function getReferees(address: string): AgentRow[] {
  const database = getDb();
  return database.prepare('SELECT * FROM agents WHERE referred_by = ? ORDER BY created_at DESC')
    .all(address) as AgentRow[];
}

// =========================================

// Get referrer leaderboard
export function getReferralLeaderboard(limit = 25): Array<{ address: string; referralCount: number; activeReferees: number; totalEarnings: number }> {
  const database = getDb();

  const rows = database.prepare(`
    SELECT
      a.address as address,
      COUNT(r.address) as referralCount,
      SUM(CASE WHEN (r.tasks_completed > 0 OR r.bounties_posted > 0) THEN 1 ELSE 0 END) as activeReferees,
      a.referral_earnings as totalEarnings
    FROM agents a
    LEFT JOIN agents r ON r.referred_by = a.address
    WHERE a.airdrop_claimed = 1
    GROUP BY a.address
    HAVING referralCount > 0 OR totalEarnings > 0
    ORDER BY referralCount DESC, totalEarnings DESC
    LIMIT ?
  `).all(limit) as any[];

  return rows.map(r => ({
    address: r.address,
    referralCount: Number(r.referralCount || 0),
    activeReferees: Number(r.activeReferees || 0),
    totalEarnings: Number(r.totalEarnings || 0),
  }));
}
// Social Claims Functions
// =========================================

// Create a social claim
export function createSocialClaim(claim: Omit<SocialClaimRow, 'id'>): SocialClaimRow {
  const database = getDb();
  const id = `social_${Date.now()}_${Math.random().toString(36).substring(7)}`;

  database.prepare(`
    INSERT INTO social_claims (id, agent_address, platform, post_url, claimed_at, payout)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, claim.agent_address, claim.platform, claim.post_url, claim.claimed_at, claim.payout);

  return { id, ...claim };
}

// Check if a post URL has already been claimed
export function isPostUrlClaimed(postUrl: string): boolean {
  const database = getDb();
  const result = database.prepare('SELECT 1 FROM social_claims WHERE post_url = ?').get(postUrl);
  return !!result;
}

// Get social claims for an agent today
export function getAgentSocialClaimsToday(address: string): SocialClaimRow[] {
  const database = getDb();
  const startOfDay = Math.floor(new Date().setHours(0, 0, 0, 0) / 1000);

  return database.prepare(`
    SELECT * FROM social_claims
    WHERE agent_address = ? AND claimed_at >= ?
    ORDER BY claimed_at DESC
  `).all(address, startOfDay) as SocialClaimRow[];
}

// Get all social claims for an agent
export function getAgentSocialClaims(address: string, limit = 50): SocialClaimRow[] {
  const database = getDb();
  return database.prepare(`
    SELECT * FROM social_claims
    WHERE agent_address = ?
    ORDER BY claimed_at DESC
    LIMIT ?
  `).all(address, limit) as SocialClaimRow[];
}

// =========================================
// Milestone Functions
// =========================================

// Check if milestone is claimed
export function isMilestoneClaimed(address: string, milestone: string): boolean {
  const database = getDb();
  const result = database.prepare(
    'SELECT 1 FROM agent_milestones WHERE agent_address = ? AND milestone = ?'
  ).get(address, milestone);
  return !!result;
}

// Claim a milestone
export function claimMilestone(address: string, milestone: string, payout: number): MilestoneRow {
  const database = getDb();
  const now = Math.floor(Date.now() / 1000);

  database.prepare(`
    INSERT INTO agent_milestones (agent_address, milestone, completed_at, payout)
    VALUES (?, ?, ?, ?)
  `).run(address, milestone, now, payout);

  return { agent_address: address, milestone, completed_at: now, payout };
}

// Get agent's milestones
export function getAgentMilestones(address: string): MilestoneRow[] {
  const database = getDb();
  return database.prepare('SELECT * FROM agent_milestones WHERE agent_address = ? ORDER BY completed_at DESC')
    .all(address) as MilestoneRow[];
}
