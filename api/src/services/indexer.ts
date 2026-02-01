import {
  createPublicClient,
  http,
  parseAbi,
  parseAbiItem,
  type Address,
  type Log,
} from 'viem';
import { baseSepolia } from 'viem/chains';
import {
  upsertTask,
  updateTaskState,
  getLastIndexedBlock,
  setLastIndexedBlock,
} from './db.js';
import { fetchMetadata } from './ipfs.js';
import type { EscrowState } from '../types/marketplace.js';

const contractAddress = process.env.ESCROW_CONTRACT_ADDRESS as Address;

const publicClient = createPublicClient({
  chain: baseSepolia,
  transport: http(process.env.RPC_URL),
});

// Event ABIs
const escrowCreatedEvent = parseAbiItem(
  'event EscrowCreated(bytes32 indexed escrowId, address indexed client, address token, uint256 amount, bytes32 criteriaHash)'
);
const escrowAcceptedEvent = parseAbiItem(
  'event EscrowAccepted(bytes32 indexed escrowId, address indexed worker)'
);
const workSubmittedEvent = parseAbiItem(
  'event WorkSubmitted(bytes32 indexed escrowId, bytes32 evidenceHash)'
);
const escrowReleasedEvent = parseAbiItem(
  'event EscrowReleased(bytes32 indexed escrowId, uint256 workerAmount, uint256 protocolFee)'
);
const escrowDisputedEvent = parseAbiItem(
  'event EscrowDisputed(bytes32 indexed escrowId, uint256 disputeFee)'
);
const escrowResolvedEvent = parseAbiItem(
  'event EscrowResolved(bytes32 indexed escrowId, uint8 outcome, uint8 completionPct, uint256 workerAmount, uint256 clientRefund)'
);

// Contract ABI for reading escrow data
const escrowAbi = parseAbi([
  'function getEscrow(bytes32 escrowId) view returns ((address client, address worker, address token, uint256 amount, uint256 deadline, bytes32 criteriaHash, uint8 state, uint8 outcome, uint8 completionPct, uint256 createdAt, uint256 submittedAt, bytes32 evidenceHash, uint256 reviewPeriod))',
]);

const StateMap: Record<number, EscrowState> = {
  0: 'Pending',
  1: 'Active',
  2: 'Submitted',
  3: 'Disputed',
  4: 'Resolved',
};

let indexerRunning = false;
let indexerInterval: NodeJS.Timeout | null = null;

/**
 * Index events from a specific block range
 */
async function indexBlockRange(fromBlock: bigint, toBlock: bigint): Promise<void> {
  if (!contractAddress) {
    console.log('[Indexer] No contract address configured, skipping');
    return;
  }

  console.log(`[Indexer] Indexing blocks ${fromBlock} to ${toBlock}`);

  // Fetch EscrowCreated events
  const createdLogs = await publicClient.getLogs({
    address: contractAddress,
    event: escrowCreatedEvent,
    fromBlock,
    toBlock,
  });

  for (const log of createdLogs) {
    await processEscrowCreated(log);
  }

  // Fetch EscrowAccepted events
  const acceptedLogs = await publicClient.getLogs({
    address: contractAddress,
    event: escrowAcceptedEvent,
    fromBlock,
    toBlock,
  });

  for (const log of acceptedLogs) {
    await processEscrowAccepted(log);
  }

  // Fetch state change events
  const releasedLogs = await publicClient.getLogs({
    address: contractAddress,
    event: escrowReleasedEvent,
    fromBlock,
    toBlock,
  });

  for (const log of releasedLogs) {
    const escrowId = log.args.escrowId as string;
    console.log(`[Indexer] EscrowReleased event for ${escrowId}`);
    updateTaskState(escrowId, 'Resolved');
  }

  const disputedLogs = await publicClient.getLogs({
    address: contractAddress,
    event: escrowDisputedEvent,
    fromBlock,
    toBlock,
  });

  for (const log of disputedLogs) {
    const escrowId = log.args.escrowId as string;
    updateTaskState(escrowId, 'Disputed');
  }

  const submittedLogs = await publicClient.getLogs({
    address: contractAddress,
    event: workSubmittedEvent,
    fromBlock,
    toBlock,
  });

  for (const log of submittedLogs) {
    const escrowId = log.args.escrowId as string;
    updateTaskState(escrowId, 'Submitted');
  }

  const resolvedLogs = await publicClient.getLogs({
    address: contractAddress,
    event: escrowResolvedEvent,
    fromBlock,
    toBlock,
  });

  for (const log of resolvedLogs) {
    const escrowId = log.args.escrowId as string;
    updateTaskState(escrowId, 'Resolved');
  }

  // Update last indexed block
  setLastIndexedBlock(toBlock);
  console.log(`[Indexer] Indexed ${createdLogs.length} created, ${acceptedLogs.length} accepted events`);
}

/**
 * Process an EscrowCreated event
 */
async function processEscrowCreated(log: Log<bigint, number, false, typeof escrowCreatedEvent>): Promise<void> {
  const { escrowId, client, token, amount, criteriaHash } = log.args;

  if (!escrowId || !client || !token || amount === undefined || !criteriaHash) {
    console.log('[Indexer] Skipping malformed EscrowCreated event');
    return;
  }

  // Fetch full escrow data from contract
  const escrowData = await publicClient.readContract({
    address: contractAddress,
    abi: escrowAbi,
    functionName: 'getEscrow',
    args: [escrowId],
  }) as any;

  // Try to fetch metadata from IPFS using criteriaHash
  let metadata = null;
  try {
    metadata = await fetchMetadata(criteriaHash);
  } catch (e) {
    console.log(`[Indexer] Could not fetch metadata for ${escrowId}`);
  }

  // Extract escrow data - viem returns named properties or array
  // Try named properties first, fall back to array indices
  const deadline = Number(escrowData.deadline ?? escrowData[4] ?? Math.floor(Date.now() / 1000) + 86400);
  const createdAt = Number(escrowData.createdAt ?? escrowData[9] ?? Math.floor(Date.now() / 1000));
  const reviewPeriod = Number(escrowData.reviewPeriod ?? escrowData[12] ?? 0);

  console.log(`[Indexer] Processing escrow ${escrowId}: deadline=${deadline}, createdAt=${createdAt}`, escrowData);

  // Insert into database
  upsertTask({
    escrow_id: escrowId,
    client: client,
    worker: null,
    token: token,
    amount: amount.toString(),
    deadline,
    criteria_hash: criteriaHash,
    state: 'Pending',
    created_at: createdAt,
    review_period: reviewPeriod,
    title: metadata?.title || null,
    description: metadata?.description || null,
    category: metadata?.category || null,
    skills: metadata?.skills ? JSON.stringify(metadata.skills) : null,
    block_number: Number(log.blockNumber),
  });

  console.log(`[Indexer] Indexed task ${escrowId} - ${metadata?.title || 'No title'}`);
}

/**
 * Process an EscrowAccepted event
 */
async function processEscrowAccepted(log: Log<bigint, number, false, typeof escrowAcceptedEvent>): Promise<void> {
  const { escrowId, worker } = log.args;

  if (!escrowId || !worker) {
    return;
  }

  updateTaskState(escrowId, 'Active', worker);
  console.log(`[Indexer] Task ${escrowId} accepted by ${worker}`);
}

/**
 * Start the indexer polling loop
 */
export async function startIndexer(pollIntervalMs = 10000): Promise<void> {
  if (indexerRunning) {
    console.log('[Indexer] Already running');
    return;
  }

  if (!contractAddress) {
    console.log('[Indexer] No contract address configured, indexer disabled');
    return;
  }

  indexerRunning = true;
  console.log('[Indexer] Starting...');

  // Initial sync
  await syncToLatest();

  // Start polling
  indexerInterval = setInterval(async () => {
    try {
      await syncToLatest();
    } catch (e) {
      console.error('[Indexer] Error during sync:', e);
    }
  }, pollIntervalMs);
}

/**
 * Sync from last indexed block to latest
 */
async function syncToLatest(): Promise<void> {
  const currentBlock = await publicClient.getBlockNumber();
  const lastIndexed = getLastIndexedBlock();

  // Start from a reasonable block if never indexed
  const fromBlock = lastIndexed > 0n ? lastIndexed + 1n : currentBlock - 10000n;

  if (fromBlock > currentBlock) {
    return; // Already up to date
  }

  // Index in chunks of 2000 blocks
  const chunkSize = 2000n;
  let from = fromBlock;

  while (from <= currentBlock) {
    const to = from + chunkSize > currentBlock ? currentBlock : from + chunkSize;
    await indexBlockRange(from, to);
    from = to + 1n;
  }
}

/**
 * Stop the indexer
 */
export function stopIndexer(): void {
  if (indexerInterval) {
    clearInterval(indexerInterval);
    indexerInterval = null;
  }
  indexerRunning = false;
  console.log('[Indexer] Stopped');
}

/**
 * Manually index a single task (for immediate indexing after creation)
 */
export async function indexTask(escrowId: string, metadataUri?: string): Promise<void> {
  if (!contractAddress) {
    console.log('[Indexer] No contract address, storing locally only');
  }

  // Try to fetch metadata
  let metadata = null;
  if (metadataUri) {
    try {
      metadata = await fetchMetadata(metadataUri);
    } catch (e) {
      console.log(`[Indexer] Could not fetch metadata from ${metadataUri}`);
    }
  }

  // If contract is deployed, fetch on-chain data
  if (contractAddress) {
    try {
      const escrowData = await publicClient.readContract({
        address: contractAddress,
        abi: escrowAbi,
        functionName: 'getEscrow',
        args: [escrowId as `0x${string}`],
      }) as any;

      const currentBlock = await publicClient.getBlockNumber();

      upsertTask({
        escrow_id: escrowId,
        client: escrowData[0],
        worker: escrowData[1] === '0x0000000000000000000000000000000000000000' ? null : escrowData[1],
        token: escrowData[2],
        amount: escrowData[3].toString(),
        deadline: Number(escrowData[4]),
        criteria_hash: escrowData[5],
        state: StateMap[escrowData[6]] || 'Pending',
        created_at: Number(escrowData[9]),
        review_period: Number(escrowData[12]),
        title: metadata?.title || null,
        description: metadata?.description || null,
        category: metadata?.category || null,
        skills: metadata?.skills ? JSON.stringify(metadata.skills) : null,
        block_number: Number(currentBlock),
      });
    } catch (e) {
      console.log(`[Indexer] Could not fetch on-chain data for ${escrowId}:`, e);
    }
  }
}
