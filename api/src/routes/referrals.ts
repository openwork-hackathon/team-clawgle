import { Hono } from 'hono';
import { type Address } from 'viem';
import {
  getAgent,
  getReferralStats,
  getReferees,
  getRefereesPage,
  getRefereesCount,
  getReferralLeaderboard,
} from '../services/db.js';

export const referralRoutes = new Hono();

// Referral constants
const REFERRAL_SIGNUP_BONUS = 100; // 100 SETTLE for both parties
const REFERRAL_REVENUE_SHARE = 0.05; // 5% of worker earnings


/**
 * GET /v2/referrals/leaderboard
 * NOTE: Must be registered before /:address routes to avoid route shadowing.
 */
referralRoutes.get('/leaderboard', async (c) => {
  const rawLimit = c.req.query('limit') || '25';
  const limit = Math.min(Math.max(parseInt(rawLimit, 10) || 25, 1), 100);

  const rows = getReferralLeaderboard(limit);

  return c.json({
    topReferrers: rows.map(r => ({
      address: r.address,
      referralCount: r.referralCount,
      activeReferees: r.activeReferees,
      totalEarnings: r.totalEarnings,
      referralLink: `https://clawgle.xyz/join?ref=${r.address}`,
    })),
    limit,
  });
});

/**
 * GET /v2/referrals/:address/referees
 * Paginated list of referees for an agent
 */
referralRoutes.get('/:address/referees', async (c) => {
  const address = c.req.param('address').toLowerCase() as Address;

  const rawLimit = c.req.query('limit') || '25';
  const rawOffset = c.req.query('offset') || '0';
  const limit = Math.min(Math.max(parseInt(rawLimit, 10) || 25, 1), 100);
  const offset = Math.max(parseInt(rawOffset, 10) || 0, 0);

  const total = getRefereesCount(address);
  const referees = getRefereesPage(address, limit, offset);

  return c.json({
    address,
    total,
    limit,
    offset,
    referees: referees.map(ref => ({
      address: ref.address,
      joinedAt: ref.created_at,
      tasksCompleted: ref.tasks_completed,
      bountiesPosted: ref.bounties_posted,
      isActive: ref.tasks_completed > 0 || ref.bounties_posted > 0,
    })),
  });
});

/**
 * GET /v2/referrals/:address
 * Get referral stats for an agent
 */
referralRoutes.get('/:address', async (c) => {
  const address = c.req.param('address').toLowerCase() as Address;

  const agent = getAgent(address);
  if (!agent) {
    return c.json({
      address,
      referralLink: `https://clawgle.xyz/join?ref=${address}`,
      referralCount: 0,
      totalEarnings: 0,
      signupBonusPerReferral: REFERRAL_SIGNUP_BONUS,
      revenueSharePercent: REFERRAL_REVENUE_SHARE * 100,
      referees: [],
      eligibleForRevenueShare: false,
      message: 'Claim airdrop to start earning referral bonuses',
    });
  }

  const stats = getReferralStats(address);
  const referees = getReferees(address);
  const isActive = agent.tasks_completed > 0 || agent.bounties_posted > 0;

  return c.json({
    address,
    referralLink: `https://clawgle.xyz/join?ref=${address}`,
    referralCount: stats.referralCount,
    totalEarnings: stats.totalEarnings,
    signupBonusPerReferral: REFERRAL_SIGNUP_BONUS,
    revenueSharePercent: REFERRAL_REVENUE_SHARE * 100,
    eligibleForRevenueShare: isActive,
    eligibilityReason: isActive
      ? 'Active agent - earning 5% revenue share on referee earnings'
      : 'Complete a task or post a bounty to earn revenue share',
    referees: referees.slice(0, 50).map(ref => ({
      address: ref.address,
      joinedAt: ref.created_at,
      tasksCompleted: ref.tasks_completed,
      bountiesPosted: ref.bounties_posted,
      isActive: ref.tasks_completed > 0 || ref.bounties_posted > 0,
    })),
    stats: {
      totalReferees: stats.referralCount,
      activeReferees: referees.filter(r => r.tasks_completed > 0 || r.bounties_posted > 0).length,
      totalRevenueShareEarned: stats.totalEarnings,
    },
  });
});

/**
 * GET /v2/referrals/:address/earnings
 * Get detailed earnings breakdown
 */
referralRoutes.get('/:address/earnings', async (c) => {
  const address = c.req.param('address').toLowerCase() as Address;
  const rawLimit = c.req.query('limit') || '10';
  const limit = Math.min(Math.max(parseInt(rawLimit, 10) || 10, 1), 100);

  const agent = getAgent(address);
  if (!agent) {
    return c.json({
      address,
      totalEarnings: 0,
      signupBonuses: 0,
      revenueShareEarnings: 0,
      totalReferees: 0,
      activeReferees: 0,
      topRefereesLimit: limit,
      breakdown: [],
    });
  }

  const stats = getReferralStats(address);
  const referees = getReferees(address);
  const activeReferees = referees.filter(r => r.tasks_completed > 0 || r.bounties_posted > 0).length;

  // Calculate signup bonuses (100 SETTLE per referee who was active at time of signup)
  // For simplicity, assume all referees counted as bonuses
  const signupBonuses = stats.referralCount * REFERRAL_SIGNUP_BONUS;

  // Revenue share is tracked separately in agent.referral_earnings
  const revenueShareEarnings = agent.referral_earnings;

  return c.json({
    address,
    totalEarnings: signupBonuses + revenueShareEarnings,
    signupBonuses,
    signupBonusCount: stats.referralCount,
    revenueShareEarnings,
    revenueSharePercent: REFERRAL_REVENUE_SHARE * 100,
    totalReferees: stats.referralCount,
    activeReferees,
    topRefereesLimit: limit,
    topReferees: referees
      .sort((a, b) => b.tasks_completed - a.tasks_completed)
      .slice(0, limit)
      .map(ref => ({
        address: ref.address,
        tasksCompleted: ref.tasks_completed,
        estimatedContribution: Math.floor(ref.tasks_completed * 100 * REFERRAL_REVENUE_SHARE), // Rough estimate
      })),
  });
});

/**
 * GET /v2/referrals/:address/link
 * Get referral link for an agent
 */
referralRoutes.get('/:address/link', async (c) => {
  const address = c.req.param('address').toLowerCase() as Address;

  const agent = getAgent(address);
  const isEligible = agent?.airdrop_claimed === 1;

  return c.json({
    address,
    referralLink: `https://clawgle.xyz/join?ref=${address}`,
    shortLink: `clawgle.xyz/join?ref=${address.slice(0, 10)}`,
    eligible: isEligible,
    message: isEligible
      ? 'Share your referral link to earn 100 SETTLE per signup + 5% revenue share'
      : 'Claim your airdrop first to activate your referral link',
    rewards: {
      signupBonus: REFERRAL_SIGNUP_BONUS,
      revenueShare: `${REFERRAL_REVENUE_SHARE * 100}%`,
      description: 'Earn 100 SETTLE when someone signs up with your link, plus 5% of their bounty earnings forever',
    },
  });
});


