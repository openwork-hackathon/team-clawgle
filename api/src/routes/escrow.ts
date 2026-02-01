import { Hono } from 'hono';
import { type Hex } from 'viem';
import {
  getEscrow,
  createEscrow,
  acceptEscrow,
  submitWork,
  releaseEscrow,
  disputeEscrow,
  autoReleaseEscrow,
} from '../services/chain.js';

export const escrowRoutes = new Hono();

// Get escrow by ID
escrowRoutes.get('/:id', async (c) => {
  const escrowId = c.req.param('id') as Hex;

  try {
    const escrow = await getEscrow(escrowId);
    return c.json(escrow);
  } catch (error) {
    return c.json({ error: 'Escrow not found', code: 'NOT_FOUND' }, 404);
  }
});

// Create new escrow
escrowRoutes.post('/create', async (c) => {
  const body = await c.req.json();
  const { privateKey, token, amount, deadline, criteriaHash, reviewPeriod } = body;

  if (!privateKey || !token || !amount || !deadline || !criteriaHash) {
    return c.json(
      { error: 'Missing required fields: privateKey, token, amount, deadline, criteriaHash', code: 'INVALID_INPUT' },
      400
    );
  }

  try {
    const result = await createEscrow(
      privateKey as Hex,
      token as Hex,
      BigInt(amount),
      BigInt(deadline),
      criteriaHash as Hex,
      BigInt(reviewPeriod || 0)
    );

    return c.json({
      success: true,
      escrowId: result.escrowId,
      txHash: result.txHash,
    });
  } catch (error: any) {
    return c.json({ error: error.message, code: 'TX_FAILED' }, 500);
  }
});

// Accept escrow (worker)
escrowRoutes.post('/:id/accept', async (c) => {
  const escrowId = c.req.param('id') as Hex;
  const body = await c.req.json();
  const { privateKey } = body;

  if (!privateKey) {
    return c.json({ error: 'Missing privateKey', code: 'INVALID_INPUT' }, 400);
  }

  try {
    const txHash = await acceptEscrow(privateKey as Hex, escrowId);
    return c.json({ success: true, txHash });
  } catch (error: any) {
    return c.json({ error: error.message, code: 'TX_FAILED' }, 500);
  }
});

// Submit work (worker)
escrowRoutes.post('/:id/submit', async (c) => {
  const escrowId = c.req.param('id') as Hex;
  const body = await c.req.json();
  const { privateKey, evidenceHash } = body;

  if (!privateKey || !evidenceHash) {
    return c.json({ error: 'Missing privateKey or evidenceHash', code: 'INVALID_INPUT' }, 400);
  }

  try {
    const txHash = await submitWork(privateKey as Hex, escrowId, evidenceHash as Hex);
    return c.json({ success: true, txHash });
  } catch (error: any) {
    return c.json({ error: error.message, code: 'TX_FAILED' }, 500);
  }
});

// Release payment (client)
escrowRoutes.post('/:id/release', async (c) => {
  const escrowId = c.req.param('id') as Hex;
  const body = await c.req.json();
  const { privateKey } = body;

  if (!privateKey) {
    return c.json({ error: 'Missing privateKey', code: 'INVALID_INPUT' }, 400);
  }

  try {
    const txHash = await releaseEscrow(privateKey as Hex, escrowId);
    return c.json({ success: true, txHash });
  } catch (error: any) {
    return c.json({ error: error.message, code: 'TX_FAILED' }, 500);
  }
});

// Dispute (client)
escrowRoutes.post('/:id/dispute', async (c) => {
  const escrowId = c.req.param('id') as Hex;
  const body = await c.req.json();
  const { privateKey, disputeFee } = body;

  if (!privateKey) {
    return c.json({ error: 'Missing privateKey', code: 'INVALID_INPUT' }, 400);
  }

  try {
    const txHash = await disputeEscrow(privateKey as Hex, escrowId, BigInt(disputeFee || 0));
    return c.json({ success: true, txHash });
  } catch (error: any) {
    return c.json({ error: error.message, code: 'TX_FAILED' }, 500);
  }
});

// Auto-release after timeout
escrowRoutes.post('/:id/auto-release', async (c) => {
  const escrowId = c.req.param('id') as Hex;
  const body = await c.req.json();
  const { privateKey } = body;

  if (!privateKey) {
    return c.json({ error: 'Missing privateKey', code: 'INVALID_INPUT' }, 400);
  }

  try {
    const txHash = await autoReleaseEscrow(privateKey as Hex, escrowId);
    return c.json({ success: true, txHash });
  } catch (error: any) {
    return c.json({ error: error.message, code: 'TX_FAILED' }, 500);
  }
});
