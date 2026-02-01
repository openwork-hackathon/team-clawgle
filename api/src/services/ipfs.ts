/**
 * IPFS Service
 * 
 * Handles storage of deliverables on IPFS via Pinata or web3.storage
 * Falls back to local storage for development
 */

import { createHash } from 'crypto';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

const PINATA_JWT = process.env.PINATA_JWT;
const PINATA_API = 'https://api.pinata.cloud';
const LOCAL_STORAGE_PATH = process.env.IPFS_LOCAL_PATH || './data/ipfs';

export interface IPFSResult {
  hash: string;
  uri: string;
  gateway: string;
  size: number;
}

/**
 * Upload content to IPFS (or local storage as fallback)
 */
export async function uploadToIPFS(content: string | object, filename?: string): Promise<IPFSResult> {
  const data = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
  const hash = createHash('sha256').update(data).digest('hex').slice(0, 32);
  
  // Try Pinata if configured
  if (PINATA_JWT) {
    try {
      const formData = new FormData();
      const blob = new Blob([data], { type: 'application/json' });
      formData.append('file', blob, filename || `${hash}.json`);
      
      const res = await fetch(`${PINATA_API}/pinning/pinFileToIPFS`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${PINATA_JWT}`
        },
        body: formData
      });
      
      if (res.ok) {
        const result = await res.json();
        return {
          hash: result.IpfsHash,
          uri: `ipfs://${result.IpfsHash}`,
          gateway: `https://gateway.pinata.cloud/ipfs/${result.IpfsHash}`,
          size: data.length
        };
      }
    } catch (err) {
      console.error('Pinata upload failed, falling back to local:', err);
    }
  }
  
  // Fallback to local storage
  if (!existsSync(LOCAL_STORAGE_PATH)) {
    mkdirSync(LOCAL_STORAGE_PATH, { recursive: true });
  }
  
  const filepath = join(LOCAL_STORAGE_PATH, `${hash}.json`);
  writeFileSync(filepath, data);
  
  return {
    hash: hash,
    uri: `local://${hash}`,
    gateway: `/ipfs/${hash}`,
    size: data.length
  };
}

/**
 * Fetch content from IPFS (or local storage)
 */
export async function fetchFromIPFS(hashOrUri: string): Promise<string | null> {
  // Extract hash from various formats
  let hash = hashOrUri;
  if (hashOrUri.startsWith('ipfs://')) {
    hash = hashOrUri.replace('ipfs://', '');
  } else if (hashOrUri.startsWith('local://')) {
    hash = hashOrUri.replace('local://', '');
  }
  
  // Try IPFS gateways
  const gateways = [
    `https://gateway.pinata.cloud/ipfs/${hash}`,
    `https://ipfs.io/ipfs/${hash}`,
    `https://cloudflare-ipfs.com/ipfs/${hash}`,
    `https://w3s.link/ipfs/${hash}`
  ];
  
  for (const gateway of gateways) {
    try {
      const res = await fetch(gateway, { 
        signal: AbortSignal.timeout(5000) 
      });
      if (res.ok) {
        return await res.text();
      }
    } catch (err) {
      continue;
    }
  }
  
  // Try local storage
  const localPath = join(LOCAL_STORAGE_PATH, `${hash}.json`);
  if (existsSync(localPath)) {
    return readFileSync(localPath, 'utf-8');
  }
  
  return null;
}

/**
 * Generate a content hash (for verification)
 */
export function hashContent(content: string | object): string {
  const data = typeof content === 'string' ? content : JSON.stringify(content);
  return '0x' + createHash('sha256').update(data).digest('hex');
}

/**
 * Fetch metadata from IPFS (alias for fetchFromIPFS for backwards compatibility)
 */
export async function fetchMetadata(hashOrUri: string): Promise<any | null> {
  const content = await fetchFromIPFS(hashOrUri);
  if (!content) return null;
  try {
    return JSON.parse(content);
  } catch {
    return content;
  }
}

/**
 * Store metadata on IPFS (alias for uploadToIPFS)
 */
export async function storeMetadata(metadata: object): Promise<{ uri: string; hash: string }> {
  const result = await uploadToIPFS(metadata);
  return {
    uri: result.uri,
    hash: result.hash
  };
}

/**
 * Generate criteria hash from metadata
 */
export function generateCriteriaHash(metadata: object): string {
  return hashContent(metadata);
}
