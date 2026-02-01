import { Hono } from 'hono';
import { type Hex, type Address, encodeFunctionData, parseAbi } from 'viem';
import { getEscrow } from '../services/chain.js';

export const escrowRoutesV2 = new Hono();

const contractAddress = process.env.ESCROW_CONTRACT_ADDRESS as Address;

const escrowAbi = parseAbi([
  'function createEscrow(address token, uint256 amount, uint256 deadline, bytes32 criteriaHash, uint256 reviewPeriod) payable returns (bytes32)',
  'function acceptEscrow(bytes32 escrowId)',
  'function submitWork(bytes32 escrowId, bytes32 evidenceHash)',
  'function release(bytes32 escrowId)',
  'function dispute(bytes32 escrowId) payable',
  'function autoRelease(bytes32 escrowId)',
]);

// Helper to build unsigned transaction
function buildUnsignedTx(
  from: Address,
  functionName: string,
  args: readonly unknown[],
  value?: bigint
) {
  const data = encodeFunctionData({
    abi: escrowAbi,
    functionName: functionName as any,
    args: args as any,
  });

  return {
    to: contractAddress,
    from,
    data,
    value: value ? value.toString() : '0',
    chainId: 84532, // Base Sepolia
  };
}

// Get escrow by ID (no change needed - read-only)
escrowRoutesV2.get('/:id', async (c) => {
  const escrowId = c.req.param('id') as Hex;

  try {
    const escrow = await getEscrow(escrowId);
    return c.json(escrow);
  } catch (error) {
    return c.json({ error: 'Escrow not found', code: 'NOT_FOUND' }, 404);
  }
});

// Create escrow - returns unsigned tx
escrowRoutesV2.post('/create', async (c) => {
  const body = await c.req.json();
  const { from, token, amount, deadline, criteriaHash, reviewPeriod } = body;

  if (!from || !token || !amount || !deadline || !criteriaHash) {
    return c.json(
      { error: 'Missing required fields: from, token, amount, deadline, criteriaHash', code: 'INVALID_INPUT' },
      400
    );
  }

  const isEth = token === '0x0000000000000000000000000000000000000000';
  const value = isEth ? BigInt(amount) : 0n;
  // Default to 0 (use protocol default) if not specified
  const effectiveReviewPeriod = reviewPeriod ? BigInt(reviewPeriod) : 0n;

  const unsignedTx = buildUnsignedTx(
    from as Address,
    'createEscrow',
    [token, BigInt(amount), BigInt(deadline), criteriaHash, effectiveReviewPeriod],
    value
  );

  return c.json({
    unsignedTx,
    description: 'Sign this transaction and broadcast to create escrow',
  });
});

// Accept escrow - returns unsigned tx
escrowRoutesV2.post('/:id/accept', async (c) => {
  const escrowId = c.req.param('id') as Hex;
  const body = await c.req.json();
  const { from } = body;

  if (!from) {
    return c.json({ error: 'Missing from address', code: 'INVALID_INPUT' }, 400);
  }

  const unsignedTx = buildUnsignedTx(from as Address, 'acceptEscrow', [escrowId]);

  return c.json({
    unsignedTx,
    description: 'Sign this transaction to accept the escrow job',
  });
});

// Submit work - returns unsigned tx
escrowRoutesV2.post('/:id/submit', async (c) => {
  const escrowId = c.req.param('id') as Hex;
  const body = await c.req.json();
  const { from, evidenceHash } = body;

  if (!from || !evidenceHash) {
    return c.json({ error: 'Missing from or evidenceHash', code: 'INVALID_INPUT' }, 400);
  }

  const unsignedTx = buildUnsignedTx(from as Address, 'submitWork', [escrowId, evidenceHash]);

  return c.json({
    unsignedTx,
    description: 'Sign this transaction to submit your work evidence',
  });
});

// Release payment - returns unsigned tx
escrowRoutesV2.post('/:id/release', async (c) => {
  const escrowId = c.req.param('id') as Hex;
  const body = await c.req.json();
  const { from } = body;

  if (!from) {
    return c.json({ error: 'Missing from address', code: 'INVALID_INPUT' }, 400);
  }

  const unsignedTx = buildUnsignedTx(from as Address, 'release', [escrowId]);

  return c.json({
    unsignedTx,
    description: 'Sign this transaction to release payment to worker',
  });
});

// Dispute - returns unsigned tx
escrowRoutesV2.post('/:id/dispute', async (c) => {
  const escrowId = c.req.param('id') as Hex;
  const body = await c.req.json();
  const { from, disputeFee } = body;

  if (!from) {
    return c.json({ error: 'Missing from address', code: 'INVALID_INPUT' }, 400);
  }

  const unsignedTx = buildUnsignedTx(
    from as Address,
    'dispute',
    [escrowId],
    BigInt(disputeFee || 0)
  );

  return c.json({
    unsignedTx,
    description: 'Sign this transaction to dispute the escrow',
  });
});

// Auto-release - returns unsigned tx
escrowRoutesV2.post('/:id/auto-release', async (c) => {
  const escrowId = c.req.param('id') as Hex;
  const body = await c.req.json();
  const { from } = body;

  if (!from) {
    return c.json({ error: 'Missing from address', code: 'INVALID_INPUT' }, 400);
  }

  const unsignedTx = buildUnsignedTx(from as Address, 'autoRelease', [escrowId]);

  return c.json({
    unsignedTx,
    description: 'Sign this transaction to auto-release funds after timeout',
  });
});

// Broadcast signed transaction
escrowRoutesV2.post('/broadcast', async (c) => {
  const body = await c.req.json();
  const { signedTx } = body;

  if (!signedTx) {
    return c.json({ error: 'Missing signedTx', code: 'INVALID_INPUT' }, 400);
  }

  try {
    // Import dynamically to avoid circular deps
    const { createPublicClient, http } = await import('viem');
    const { baseSepolia } = await import('viem/chains');

    const client = createPublicClient({
      chain: baseSepolia,
      transport: http(process.env.RPC_URL),
    });

    const hash = await client.sendRawTransaction({
      serializedTransaction: signedTx as Hex,
    });

    return c.json({ success: true, txHash: hash });
  } catch (error: any) {
    return c.json({ error: error.message, code: 'BROADCAST_FAILED' }, 500);
  }
});
