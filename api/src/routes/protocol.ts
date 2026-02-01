import { Hono } from 'hono';
import { type Hex } from 'viem';
import { getProtocolStatus, resolveDispute } from '../services/chain.js';

export const protocolRoutes = new Hono();

// Get protocol status
protocolRoutes.get('/status', async (c) => {
  try {
    const status = await getProtocolStatus();
    return c.json(status);
  } catch (error: any) {
    return c.json({ error: error.message, code: 'FETCH_FAILED' }, 500);
  }
});

// Resolve dispute (arbitrator only)
protocolRoutes.post('/resolve/:id', async (c) => {
  const escrowId = c.req.param('id') as Hex;
  const body = await c.req.json();
  const { privateKey, completionPct } = body;

  if (!privateKey || completionPct === undefined) {
    return c.json(
      { error: 'Missing privateKey or completionPct', code: 'INVALID_INPUT' },
      400
    );
  }

  if (completionPct < 0 || completionPct > 100) {
    return c.json(
      { error: 'completionPct must be between 0 and 100', code: 'INVALID_INPUT' },
      400
    );
  }

  try {
    const txHash = await resolveDispute(privateKey as Hex, escrowId, completionPct);
    return c.json({ success: true, txHash });
  } catch (error: any) {
    return c.json({ error: error.message, code: 'TX_FAILED' }, 500);
  }
});
