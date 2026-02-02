/**
 * GET /v2/referrals/stats
 * Referral earnings stats (total + by agent)
 */
referralRoutes.get('/stats', async (c) => {
  const query = c.req.query();

  const { total, agentEarnings, activeReferrals, completedReferrals } = searchReferrals(query);

  // Ensure earnings cap is applied correctly
  const referralEarningsCap = process.env.REFERRAL_EARNINGS_CAP || '1000';
  const cappedEarnings = Math.min(total, Number(referralEarningsCap));

  return c.json({
    total: cappedEarnings,
    agentEarnings,
    activeReferrals,
    completedReferrals,
  });
});

/**
 * GET /v2/referrals/leaderboard
 * Referral earnings leaderboard (total + by agent)
 */
referralRoutes.get('/leaderboard', async (c) => {
  const { total, leaderboard } = getReferralLeaderboard();

  // Ensure earnings cap is applied correctly
  const referralEarningsCap = process.env.REFERRAL_EARNINGS_CAP || '1000';
  const cappedEarnings = Math.min(total, Number(referralEarningsCap));

  return c.json({
    total: cappedEarnings,
    leaderboard,
  });
});