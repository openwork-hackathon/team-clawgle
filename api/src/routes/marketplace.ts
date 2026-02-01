import { Hono } from 'hono';
import { type Address, encodeFunctionData, parseAbi, keccak256, toHex } from 'viem';
import { searchTasks, getTask, upsertTask } from '../services/db.js';
import { storeMetadata, fetchMetadata, generateCriteriaHash } from '../services/ipfs.js';
import { indexTask } from '../services/indexer.js';
import type {
  TaskSearchParams,
  CreateTaskRequest,
  TaskListing,
  TaskCategory,
  EscrowState,
  TaskRow,
} from '../types/marketplace.js';

export const marketplaceRoutes = new Hono();

const contractAddress = process.env.ESCROW_CONTRACT_ADDRESS as Address;

const escrowAbi = parseAbi([
  'function createEscrow(address token, uint256 amount, uint256 deadline, bytes32 criteriaHash, uint256 reviewPeriod) payable returns (bytes32)',
]);

// Helper to convert TaskRow to TaskListing
function rowToListing(row: TaskRow): TaskListing {
  return {
    escrowId: row.escrow_id,
    client: row.client,
    worker: row.worker,
    token: row.token,
    amount: row.amount,
    deadline: row.deadline,
    state: row.state as EscrowState,
    createdAt: row.created_at,
    reviewPeriod: row.review_period,
    criteriaHash: row.criteria_hash,
    title: row.title,
    description: row.description,
    category: row.category,
    skills: row.skills ? JSON.parse(row.skills) : [],
  };
}

/**
 * GET /v2/marketplace/tasks
 * Search and list available tasks
 */
marketplaceRoutes.get('/tasks', async (c) => {
  const query = c.req.query();

  const params: TaskSearchParams = {
    skills: query.skills ? query.skills.split(',').map(s => s.trim()) : undefined,
    category: query.category as TaskCategory | undefined,
    minAmount: query.minAmount,
    maxAmount: query.maxAmount,
    token: query.token,
    state: (query.state as EscrowState) || 'Pending',
    sort: query.sort as 'newest' | 'amount_desc' | 'deadline_asc' | undefined,
    limit: query.limit ? parseInt(query.limit, 10) : 20,
    offset: query.offset ? parseInt(query.offset, 10) : 0,
    q: query.q,
  };

  const { tasks, total } = searchTasks(params);

  return c.json({
    tasks: tasks.map(rowToListing),
    total,
    limit: params.limit,
    offset: params.offset,
  });
});

/**
 * GET /v2/marketplace/tasks/:id
 * Get full task details
 */
marketplaceRoutes.get('/tasks/:id', async (c) => {
  const escrowId = c.req.param('id');

  const task = getTask(escrowId);

  if (!task) {
    return c.json({ error: 'Task not found', code: 'NOT_FOUND' }, 404);
  }

  // Try to fetch full metadata from IPFS
  let fullMetadata = null;
  if (task.criteria_hash) {
    try {
      fullMetadata = await fetchMetadata(task.criteria_hash);
    } catch (e) {
      // Metadata not available
    }
  }

  const listing = rowToListing(task);

  return c.json({
    ...listing,
    // Include full metadata if available
    successCriteria: fullMetadata?.successCriteria || null,
    deliverables: fullMetadata?.deliverables || null,
  });
});

/**
 * POST /v2/marketplace/tasks
 * Create a new task (stores metadata + returns unsigned tx)
 */
marketplaceRoutes.post('/tasks', async (c) => {
  const body = await c.req.json() as CreateTaskRequest;

  // Validate required fields
  const { from, token, amount, deadline, title, description, category, skills, successCriteria } = body;

  if (!from || !token || !amount || !deadline) {
    return c.json(
      { error: 'Missing required fields: from, token, amount, deadline', code: 'INVALID_INPUT' },
      400
    );
  }

  if (!title || !description || !category || !skills || !successCriteria) {
    return c.json(
      { error: 'Missing required metadata: title, description, category, skills, successCriteria', code: 'INVALID_INPUT' },
      400
    );
  }

  // Create metadata object
  const metadata = {
    title,
    description,
    skills,
    category,
    successCriteria,
    deliverables: body.deliverables,
  };

  // Store metadata (locally or IPFS)
  const { hash: metadataHash, uri: metadataUri } = await storeMetadata(metadata);

  // Generate criteriaHash for contract
  const criteriaHash = generateCriteriaHash(metadata);

  // Build unsigned transaction
  const isEth = token === '0x0000000000000000000000000000000000000000';
  const value = isEth ? BigInt(amount) : 0n;
  const reviewPeriod = body.reviewPeriod ? BigInt(body.reviewPeriod) : 0n;

  const data = encodeFunctionData({
    abi: escrowAbi,
    functionName: 'createEscrow',
    args: [token as Address, BigInt(amount), BigInt(deadline), criteriaHash as `0x${string}`, reviewPeriod],
  });

  const unsignedTx = {
    to: contractAddress,
    from: from as Address,
    data,
    value: value.toString(),
    chainId: 84532, // Base Sepolia
  };

  return c.json({
    unsignedTx,
    metadataUri,
    criteriaHash,
    description: 'Sign this transaction to create the task. After broadcast, call POST /v2/marketplace/tasks/confirm with the txHash.',
  });
});

/**
 * POST /v2/marketplace/tasks/confirm
 * Confirm task creation after tx broadcast (indexes the task)
 */
marketplaceRoutes.post('/tasks/confirm', async (c) => {
  const body = await c.req.json();
  const { txHash, metadataUri, escrowId } = body;

  if (!metadataUri) {
    return c.json({ error: 'Missing metadataUri', code: 'INVALID_INPUT' }, 400);
  }

  // Fetch metadata
  const metadata = await fetchMetadata(metadataUri);

  if (!metadata) {
    return c.json({ error: 'Could not fetch metadata from URI', code: 'METADATA_NOT_FOUND' }, 400);
  }

  // If escrowId provided, index it directly
  if (escrowId) {
    await indexTask(escrowId, metadataUri);

    return c.json({
      success: true,
      escrowId,
      indexed: true,
    });
  }

  // If only txHash provided, we need to wait for the tx and parse the event
  // For now, store metadata and let the indexer pick it up
  if (txHash) {
    // The indexer will pick up the EscrowCreated event and match by criteriaHash
    // For immediate feedback, we can store a pending task
    const criteriaHash = generateCriteriaHash(metadata);

    // Create a temporary entry that will be updated by indexer
    upsertTask({
      escrow_id: `pending-${txHash}`,
      client: 'pending',
      worker: null,
      token: 'pending',
      amount: '0',
      deadline: 0,
      criteria_hash: criteriaHash,
      state: 'Pending',
      created_at: Math.floor(Date.now() / 1000),
      review_period: 0,
      title: metadata.title,
      description: metadata.description,
      category: metadata.category,
      skills: JSON.stringify(metadata.skills),
      block_number: 0,
    });

    return c.json({
      success: true,
      txHash,
      criteriaHash,
      message: 'Task metadata stored. The indexer will update with on-chain data once the transaction confirms.',
    });
  }

  return c.json({ error: 'Provide either escrowId or txHash', code: 'INVALID_INPUT' }, 400);
});

/**
 * POST /v2/marketplace/tasks/register
 * Register a task directly in the database (for testing without on-chain tx)
 */
marketplaceRoutes.post('/tasks/register', async (c) => {
  const body = await c.req.json();
  const { escrowId, client, token, amount, deadline, reviewPeriod, title, description, category, skills, successCriteria } = body;

  if (!escrowId || !client || !token || !amount || !deadline) {
    return c.json(
      { error: 'Missing required fields: escrowId, client, token, amount, deadline', code: 'INVALID_INPUT' },
      400
    );
  }

  // Create metadata
  const metadata = {
    title: title || 'Untitled Task',
    description: description || '',
    skills: skills || [],
    category: category || 'other',
    successCriteria: successCriteria || '',
  };

  // Store metadata
  const { hash: criteriaHash, uri: metadataUri } = await storeMetadata(metadata);

  // Insert into database
  upsertTask({
    escrow_id: escrowId,
    client,
    worker: null,
    token,
    amount: amount.toString(),
    deadline: Number(deadline),
    criteria_hash: criteriaHash,
    state: 'Pending',
    created_at: Math.floor(Date.now() / 1000),
    review_period: reviewPeriod ? Number(reviewPeriod) : 0,
    title: metadata.title,
    description: metadata.description,
    category: metadata.category,
    skills: JSON.stringify(metadata.skills),
    block_number: 0,
  });

  return c.json({
    success: true,
    escrowId,
    metadataUri,
    criteriaHash,
  });
});

/**
 * GET /v2/marketplace/stats
 * Get marketplace statistics
 */
marketplaceRoutes.get('/stats', async (c) => {
  const { total: pendingTasks } = searchTasks({ state: 'Pending', limit: 0 });
  const { total: activeTasks } = searchTasks({ state: 'Active', limit: 0 });
  const { total: completedTasks } = searchTasks({ state: 'Resolved', limit: 0 });

  return c.json({
    pendingTasks,
    activeTasks,
    completedTasks,
    totalTasks: pendingTasks + activeTasks + completedTasks,
  });
});
