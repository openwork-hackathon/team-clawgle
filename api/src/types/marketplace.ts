// Task categories for filtering
export type TaskCategory = 'creative' | 'coding' | 'data' | 'research' | 'other';

// Escrow states (matches contract)
export type EscrowState = 'Pending' | 'Active' | 'Submitted' | 'Disputed' | 'Resolved';

// Task metadata stored in IPFS
export interface TaskMetadata {
  title: string;
  description: string;
  skills: string[];
  category: TaskCategory;
  successCriteria: string;
  deliverables?: string[];
}

// Full task listing returned by API
export interface TaskListing {
  escrowId: string;
  client: string;
  worker: string | null;
  token: string;
  amount: string;
  amountFormatted?: string;
  deadline: number;
  deadlineFormatted?: string;
  state: EscrowState;
  createdAt: number;
  reviewPeriod: number;
  criteriaHash: string;

  // From IPFS metadata
  title: string | null;
  description: string | null;
  category: string | null;
  skills: string[];
}

// Search parameters for GET /v2/marketplace/tasks
export interface TaskSearchParams {
  skills?: string[];
  category?: TaskCategory;
  minAmount?: string;
  maxAmount?: string;
  token?: string;
  state?: EscrowState;
  sort?: 'newest' | 'amount_desc' | 'deadline_asc';
  limit?: number;
  offset?: number;
  q?: string; // Full-text search
}

// Request body for POST /v2/marketplace/tasks
export interface CreateTaskRequest {
  // On-chain params
  from: string;
  token: string;
  amount: string;
  deadline: number;
  reviewPeriod?: number;

  // Marketplace metadata
  title: string;
  description: string;
  category: TaskCategory;
  skills: string[];
  successCriteria: string;
  deliverables?: string[];
}

// Response for POST /v2/marketplace/tasks
export interface CreateTaskResponse {
  unsignedTx: {
    to: string;
    from: string;
    data: string;
    value: string;
    chainId: number;
  };
  metadataUri: string;
  criteriaHash: string;
  description: string;
}

// Request body for POST /v2/marketplace/tasks/confirm
export interface ConfirmTaskRequest {
  txHash: string;
  metadataUri: string;
}

// Database row for tasks table
export interface TaskRow {
  escrow_id: string;
  client: string;
  worker: string | null;
  token: string;
  amount: string;
  deadline: number;
  criteria_hash: string;
  state: string;
  created_at: number;
  review_period: number;
  title: string | null;
  description: string | null;
  category: string | null;
  skills: string | null; // JSON array as string
  indexed_at: number;
  block_number: number;
}
