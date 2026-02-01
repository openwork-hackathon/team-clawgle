import { Hono } from 'hono';
import { type Address } from 'viem';
import {
  getAgent,
  createSocialClaim,
  isPostUrlClaimed,
  getAgentSocialClaimsToday,
  getAgentSocialClaims,
} from '../services/db.js';
import { verifyTweet, extractTweetId } from '../services/twitter.js';

export const socialRoutes = new Hono();

// Post-to-earn constants
const POST_REWARD = 25; // 25 SETTLE per post
const MAX_CLAIMS_PER_DAY = 3;

/**
 * POST /v2/social/claim
 * Claim post-to-earn reward for a social media post
 */
socialRoutes.post('/claim', async (c) => {
  const body = await c.req.json();
  const { from, platform, postUrl } = body;

  if (!from || !postUrl) {
    return c.json({ error: 'Missing from or postUrl', code: 'INVALID_INPUT' }, 400);
  }

  const address = from.toLowerCase() as Address;
  const normalizedPlatform = (platform || 'twitter').toLowerCase();

  // Only support Twitter/X for now
  if (normalizedPlatform !== 'twitter' && normalizedPlatform !== 'x') {
    return c.json({ error: 'Only Twitter/X posts are supported', code: 'UNSUPPORTED_PLATFORM' }, 400);
  }

  // Check if agent exists and has claimed airdrop
  const agent = getAgent(address);
  if (!agent || !agent.airdrop_claimed) {
    return c.json({
      error: 'Must claim airdrop first before post-to-earn',
      code: 'AIRDROP_NOT_CLAIMED',
    }, 400);
  }

  // Check daily claim limit
  const todayClaims = getAgentSocialClaimsToday(address);
  if (todayClaims.length >= MAX_CLAIMS_PER_DAY) {
    return c.json({
      error: `Daily limit reached. You can claim ${MAX_CLAIMS_PER_DAY} posts per day.`,
      code: 'DAILY_LIMIT_REACHED',
      claimsToday: todayClaims.length,
      maxClaims: MAX_CLAIMS_PER_DAY,
    }, 400);
  }

  // Check if post URL already claimed (globally)
  if (isPostUrlClaimed(postUrl)) {
    return c.json({
      error: 'This post has already been claimed',
      code: 'POST_ALREADY_CLAIMED',
    }, 400);
  }

  // Verify the tweet
  const verification = await verifyTweet(postUrl);
  if (!verification.valid) {
    return c.json({
      error: verification.error || 'Invalid tweet',
      code: 'VERIFICATION_FAILED',
    }, 400);
  }

  // Create the claim
  const now = Math.floor(Date.now() / 1000);
  const claim = createSocialClaim({
    agent_address: address,
    platform: normalizedPlatform,
    post_url: postUrl,
    claimed_at: now,
    payout: POST_REWARD,
  });

  return c.json({
    success: true,
    claimId: claim.id,
    payout: POST_REWARD,
    tweetId: verification.tweetId,
    claimsToday: todayClaims.length + 1,
    remainingToday: MAX_CLAIMS_PER_DAY - todayClaims.length - 1,
    message: `Claimed ${POST_REWARD} SETTLE for your post!`,
  });
});

/**
 * GET /v2/social/status/:address
 * Get social claim status for an agent
 */
socialRoutes.get('/status/:address', async (c) => {
  const address = c.req.param('address').toLowerCase() as Address;

  const agent = getAgent(address);
  if (!agent) {
    return c.json({
      address,
      eligible: false,
      claimsToday: 0,
      remainingToday: 0,
      totalClaims: 0,
      totalEarned: 0,
      message: 'Claim airdrop first to enable post-to-earn',
    });
  }

  const todayClaims = getAgentSocialClaimsToday(address);
  const allClaims = getAgentSocialClaims(address, 100);
  const totalEarned = allClaims.reduce((sum, c) => sum + c.payout, 0);

  return c.json({
    address,
    eligible: agent.airdrop_claimed === 1,
    claimsToday: todayClaims.length,
    remainingToday: Math.max(0, MAX_CLAIMS_PER_DAY - todayClaims.length),
    maxClaimsPerDay: MAX_CLAIMS_PER_DAY,
    rewardPerPost: POST_REWARD,
    totalClaims: allClaims.length,
    totalEarned,
    recentClaims: allClaims.slice(0, 10).map(claim => ({
      id: claim.id,
      postUrl: claim.post_url,
      platform: claim.platform,
      payout: claim.payout,
      claimedAt: claim.claimed_at,
    })),
  });
});

/**
 * GET /v2/social/claims/:address
 * Get claim history for an agent
 */
socialRoutes.get('/claims/:address', async (c) => {
  const address = c.req.param('address').toLowerCase() as Address;
  const limit = parseInt(c.req.query('limit') || '50');

  const claims = getAgentSocialClaims(address, limit);
  const totalEarned = claims.reduce((sum, c) => sum + c.payout, 0);

  return c.json({
    address,
    claims: claims.map(claim => ({
      id: claim.id,
      postUrl: claim.post_url,
      platform: claim.platform,
      payout: claim.payout,
      claimedAt: claim.claimed_at,
    })),
    total: claims.length,
    totalEarned,
  });
});

/**
 * GET /v2/social/validate
 * Validate a post URL before claiming
 */
socialRoutes.get('/validate', async (c) => {
  const postUrl = c.req.query('url');

  if (!postUrl) {
    return c.json({ error: 'Missing url parameter', code: 'INVALID_INPUT' }, 400);
  }

  const tweetId = extractTweetId(postUrl);
  if (!tweetId) {
    return c.json({
      valid: false,
      error: 'Invalid tweet URL format',
    });
  }

  const alreadyClaimed = isPostUrlClaimed(postUrl);
  if (alreadyClaimed) {
    return c.json({
      valid: false,
      tweetId,
      error: 'This post has already been claimed',
    });
  }

  return c.json({
    valid: true,
    tweetId,
    reward: POST_REWARD,
    message: 'Post is eligible for claim',
  });
});
