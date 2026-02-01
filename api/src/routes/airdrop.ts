import { Hono } from 'hono';
import { type Address, encodeFunctionData, parseAbi } from 'viem';
import {
  getAgent,
  getOrCreateAgent,
  markAirdropClaimed,
  getReferralStats,
  getAgentMilestones,
  isMilestoneClaimed,
  claimMilestone,
} from '../services/db.js';

export const airdropRoutes = new Hono();

const airdropAddress = process.env.SETTLE_AIRDROP_ADDRESS as Address;
const settleTokenAddress = process.env.SETTLE_TOKEN_ADDRESS as Address;

// Airdrop contract ABI
const airdropAbi = parseAbi([
  'function claim(address referrer)',
  'function claimMilestone(bytes32 milestone)',
  'function hasClaimed(address) view returns (bool)',
  'function referredBy(address) view returns (address)',
  'function referralCount(address) view returns (uint256)',
  'function tasksCompleted(address) view returns (uint256)',
  'function bountiesPosted(address) view returns (uint256)',
  'function getAgentStatus(address) view returns (bool claimed, address referrer, uint256 referrals, uint256 tasks, uint256 bounties, bool isActive)',
]);

// Milestone identifiers (must match contract)
const MILESTONES = {
  FIRST_TASK: '0x' + Buffer.from('FIRST_TASK').toString('hex').padEnd(64, '0'),
  FIRST_BOUNTY: '0x' + Buffer.from('FIRST_BOUNTY').toString('hex').padEnd(64, '0'),
  FIRST_REFERRAL: '0x' + Buffer.from('FIRST_REFERRAL').toString('hex').padEnd(64, '0'),
  FIVE_REFERRALS: '0x' + Buffer.from('FIVE_REFERRALS').toString('hex').padEnd(64, '0'),
} as const;

const MILESTONE_PAYOUTS = {
  FIRST_TASK: 50,
  FIRST_BOUNTY: 50,
  FIRST_REFERRAL: 100,
  FIVE_REFERRALS: 500,
} as const;

// Helper to build unsigned transaction
function buildUnsignedTx(
  from: Address,
  functionName: string,
  args: readonly unknown[]
) {
  const data = encodeFunctionData({
    abi: airdropAbi,
    functionName: functionName as any,
    args: args as any,
  });

  return {
    to: airdropAddress,
    from,
    data,
    value: '0',
    chainId: 84532, // Base Sepolia
  };
}

/**
 * GET /v2/airdrop/status/:address
 * Check airdrop status for an address
 */
airdropRoutes.get('/status/:address', async (c) => {
  const address = c.req.param('address').toLowerCase() as Address;

  // Get agent from database
  const agent = getAgent(address);

  // Calculate claimable milestones
  const claimableMilestones: { milestone: string; payout: number }[] = [];

  if (agent) {
    // Check each milestone
    if (agent.tasks_completed >= 1 && !isMilestoneClaimed(address, 'FIRST_TASK')) {
      claimableMilestones.push({ milestone: 'FIRST_TASK', payout: MILESTONE_PAYOUTS.FIRST_TASK });
    }
    if (agent.bounties_posted >= 1 && !isMilestoneClaimed(address, 'FIRST_BOUNTY')) {
      claimableMilestones.push({ milestone: 'FIRST_BOUNTY', payout: MILESTONE_PAYOUTS.FIRST_BOUNTY });
    }

    const { referralCount } = getReferralStats(address);
    if (referralCount >= 1 && !isMilestoneClaimed(address, 'FIRST_REFERRAL')) {
      claimableMilestones.push({ milestone: 'FIRST_REFERRAL', payout: MILESTONE_PAYOUTS.FIRST_REFERRAL });
    }
    if (referralCount >= 5 && !isMilestoneClaimed(address, 'FIVE_REFERRALS')) {
      claimableMilestones.push({ milestone: 'FIVE_REFERRALS', payout: MILESTONE_PAYOUTS.FIVE_REFERRALS });
    }
  }

  const referralStats = agent ? getReferralStats(address) : { referralCount: 0, totalEarnings: 0 };
  const completedMilestones = agent ? getAgentMilestones(address) : [];

  return c.json({
    address,
    airdropClaimed: agent?.airdrop_claimed === 1,
    referredBy: agent?.referred_by || null,
    tasksCompleted: agent?.tasks_completed || 0,
    bountiesPosted: agent?.bounties_posted || 0,
    referralCount: referralStats.referralCount,
    referralEarnings: referralStats.totalEarnings,
    claimableMilestones,
    completedMilestones: completedMilestones.map(m => ({
      milestone: m.milestone,
      payout: m.payout,
      completedAt: m.completed_at,
    })),
    suggestedTweet: !agent?.airdrop_claimed ? generateSuggestedTweet(address) : null,
  });
});

/**
 * POST /v2/airdrop/claim
 * Claim airdrop (1000 SETTLE + 100 if referred)
 */
airdropRoutes.post('/claim', async (c) => {
  const body = await c.req.json();
  const { from, referrer } = body;

  if (!from) {
    return c.json({ error: 'Missing from address', code: 'INVALID_INPUT' }, 400);
  }

  const address = from.toLowerCase() as Address;

  // Check if already claimed (in our database)
  const existingAgent = getAgent(address);
  if (existingAgent?.airdrop_claimed) {
    return c.json({ error: 'Airdrop already claimed', code: 'ALREADY_CLAIMED' }, 400);
  }

  // Validate referrer if provided
  let validReferrer: Address | null = null;
  if (referrer) {
    const referrerAddress = referrer.toLowerCase() as Address;
    if (referrerAddress === address) {
      return c.json({ error: 'Cannot refer yourself', code: 'INVALID_REFERRER' }, 400);
    }
    const referrerAgent = getAgent(referrerAddress);
    if (referrerAgent?.airdrop_claimed) {
      validReferrer = referrerAddress;
    }
  }

  // Create/update agent in database
  getOrCreateAgent(address, validReferrer || undefined);

  // Build unsigned transaction
  const unsignedTx = buildUnsignedTx(
    from as Address,
    'claim',
    [validReferrer || '0x0000000000000000000000000000000000000000']
  );

  // Calculate expected payout
  const basePayout = 1000;
  const referralBonus = validReferrer ? 100 : 0;
  const totalPayout = basePayout + referralBonus;

  return c.json({
    unsignedTx,
    amount: totalPayout,
    referrer: validReferrer,
    referralBonus,
    description: `Sign to claim ${totalPayout} SETTLE tokens`,
    suggestedTweet: generateSuggestedTweet(address),
  });
});

/**
 * POST /v2/airdrop/confirm
 * Confirm airdrop claim after transaction is mined
 */
airdropRoutes.post('/confirm', async (c) => {
  const body = await c.req.json();
  const { address, txHash } = body;

  if (!address || !txHash) {
    return c.json({ error: 'Missing address or txHash', code: 'INVALID_INPUT' }, 400);
  }

  const normalizedAddress = address.toLowerCase() as Address;

  // Mark as claimed in database
  markAirdropClaimed(normalizedAddress);

  return c.json({
    success: true,
    address: normalizedAddress,
    txHash,
    message: 'Airdrop claim confirmed',
  });
});

/**
 * POST /v2/airdrop/milestone
 * Claim a milestone bonus
 */
airdropRoutes.post('/milestone', async (c) => {
  const body = await c.req.json();
  const { from, milestone } = body;

  if (!from || !milestone) {
    return c.json({ error: 'Missing from or milestone', code: 'INVALID_INPUT' }, 400);
  }

  const address = from.toLowerCase() as Address;

  // Validate milestone exists
  if (!MILESTONES[milestone as keyof typeof MILESTONES]) {
    return c.json({ error: 'Invalid milestone', code: 'INVALID_MILESTONE' }, 400);
  }

  // Check if already claimed
  if (isMilestoneClaimed(address, milestone)) {
    return c.json({ error: 'Milestone already claimed', code: 'ALREADY_CLAIMED' }, 400);
  }

  // Check eligibility
  const agent = getAgent(address);
  if (!agent) {
    return c.json({ error: 'Agent not found. Claim airdrop first.', code: 'NOT_FOUND' }, 404);
  }

  const { referralCount } = getReferralStats(address);
  let eligible = false;
  let payout = 0;

  switch (milestone) {
    case 'FIRST_TASK':
      eligible = agent.tasks_completed >= 1;
      payout = MILESTONE_PAYOUTS.FIRST_TASK;
      break;
    case 'FIRST_BOUNTY':
      eligible = agent.bounties_posted >= 1;
      payout = MILESTONE_PAYOUTS.FIRST_BOUNTY;
      break;
    case 'FIRST_REFERRAL':
      eligible = referralCount >= 1;
      payout = MILESTONE_PAYOUTS.FIRST_REFERRAL;
      break;
    case 'FIVE_REFERRALS':
      eligible = referralCount >= 5;
      payout = MILESTONE_PAYOUTS.FIVE_REFERRALS;
      break;
  }

  if (!eligible) {
    return c.json({ error: 'Milestone requirements not met', code: 'NOT_ELIGIBLE' }, 400);
  }

  // Build unsigned transaction
  const milestoneHash = MILESTONES[milestone as keyof typeof MILESTONES];
  const unsignedTx = buildUnsignedTx(from as Address, 'claimMilestone', [milestoneHash]);

  return c.json({
    unsignedTx,
    milestone,
    payout,
    description: `Sign to claim ${payout} SETTLE for ${milestone} milestone`,
  });
});

/**
 * POST /v2/airdrop/milestone/confirm
 * Confirm milestone claim after transaction
 */
airdropRoutes.post('/milestone/confirm', async (c) => {
  const body = await c.req.json();
  const { address, milestone, txHash } = body;

  if (!address || !milestone || !txHash) {
    return c.json({ error: 'Missing address, milestone, or txHash', code: 'INVALID_INPUT' }, 400);
  }

  const normalizedAddress = address.toLowerCase() as Address;
  const payout = MILESTONE_PAYOUTS[milestone as keyof typeof MILESTONE_PAYOUTS] || 0;

  // Record milestone in database
  claimMilestone(normalizedAddress, milestone, payout);

  return c.json({
    success: true,
    address: normalizedAddress,
    milestone,
    payout,
    txHash,
  });
});

/**
 * Generate suggested tweet for verification
 */
function generateSuggestedTweet(address: string): string {
  return `My agent just joined @ClawgleXYZ 🔵

Claimed 1000 $SETTLE — ready to post and complete bounties.

Zero wallet funding needed.

ref: ${address.slice(0, 10)}
clawgle.xyz/join?ref=${address}`;
}
