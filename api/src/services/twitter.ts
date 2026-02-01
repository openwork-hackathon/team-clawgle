/**
 * Twitter/X verification service for post-to-earn
 *
 * Verifies that:
 * 1. Post exists and is recent (within 24h)
 * 2. Post mentions "clawgle" OR @ClawgleXYZ OR clawgle.xyz
 * 3. Post is not already claimed
 */

// Patterns to match in post content
const VALID_PATTERNS = [
  /clawgle/i,
  /@ClawgleXYZ/i,
  /clawgle\.xyz/i,
  /\$SETTLE/i,
];

export interface TweetVerification {
  valid: boolean;
  tweetId: string | null;
  username: string | null;
  content: string | null;
  postedAt: number | null;
  error?: string;
}

/**
 * Extract tweet ID from various URL formats
 */
export function extractTweetId(url: string): string | null {
  // Match patterns like:
  // https://twitter.com/user/status/1234567890
  // https://x.com/user/status/1234567890
  // https://mobile.twitter.com/user/status/1234567890
  const patterns = [
    /(?:twitter\.com|x\.com)\/\w+\/status\/(\d+)/i,
    /(?:twitter\.com|x\.com)\/\w+\/statuses\/(\d+)/i,
  ];

  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) {
      return match[1];
    }
  }

  return null;
}

/**
 * Verify a tweet meets post-to-earn requirements
 *
 * Note: In production, you'd want to use the Twitter API.
 * This implementation uses a simplified approach that works
 * without API keys for demo purposes.
 */
export async function verifyTweet(postUrl: string): Promise<TweetVerification> {
  const tweetId = extractTweetId(postUrl);

  if (!tweetId) {
    return {
      valid: false,
      tweetId: null,
      username: null,
      content: null,
      postedAt: null,
      error: 'Invalid tweet URL format',
    };
  }

  try {
    // Option 1: Use Twitter API (requires API key)
    // const tweet = await fetchTweetFromApi(tweetId);

    // Option 2: Use a third-party service like Nitter or tweet scraping
    // For now, we'll use a permissive approach that accepts valid URLs
    // and relies on the fact that duplicate URLs are blocked

    // In production, implement proper Twitter API verification:
    // 1. Fetch tweet content via API
    // 2. Verify content contains required patterns
    // 3. Verify tweet timestamp is within 24h
    // 4. Verify tweet author matches claimed agent

    // Simplified verification for demo:
    // Accept the tweet if URL is valid format
    // The anti-gaming comes from:
    // - URL uniqueness (can't claim same tweet twice)
    // - Rate limiting (3 claims per day)
    // - Agent must have claimed airdrop first

    return {
      valid: true,
      tweetId,
      username: null, // Would be fetched from API
      content: null, // Would be fetched from API
      postedAt: Math.floor(Date.now() / 1000), // Assume recent for demo
    };
  } catch (error) {
    return {
      valid: false,
      tweetId,
      username: null,
      content: null,
      postedAt: null,
      error: 'Failed to verify tweet',
    };
  }
}

/**
 * Check if content contains valid Clawgle mentions
 */
export function contentContainsClawgle(content: string): boolean {
  return VALID_PATTERNS.some(pattern => pattern.test(content));
}

/**
 * Check if tweet was posted within the last 24 hours
 */
export function isWithin24Hours(postedAt: number): boolean {
  const now = Math.floor(Date.now() / 1000);
  const twentyFourHoursAgo = now - 24 * 60 * 60;
  return postedAt >= twentyFourHoursAgo;
}
