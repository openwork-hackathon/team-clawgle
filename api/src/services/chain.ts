import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  type Address,
  type Hash,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';

// Contract ABI (minimal for API interactions)
const escrowAbi = parseAbi([
  // Read functions
  'function getEscrow(bytes32 escrowId) view returns ((address client, address worker, address token, uint256 amount, uint256 deadline, bytes32 criteriaHash, uint8 state, uint8 outcome, uint8 completionPct, uint256 createdAt, uint256 submittedAt, bytes32 evidenceHash, uint256 reviewPeriod))',
  'function minEscrowAmount() view returns (uint256)',
  'function maxEscrowAmount() view returns (uint256)',
  'function protocolFeeBps() view returns (uint256)',
  'function disputeFeeBps() view returns (uint256)',
  'function arbitrator() view returns (address)',
  'function escrowCount() view returns (uint256)',

  // Write functions
  'function createEscrow(address token, uint256 amount, uint256 deadline, bytes32 criteriaHash, uint256 reviewPeriod) payable returns (bytes32)',
  'function acceptEscrow(bytes32 escrowId)',
  'function submitWork(bytes32 escrowId, bytes32 evidenceHash)',
  'function release(bytes32 escrowId)',
  'function dispute(bytes32 escrowId) payable',
  'function autoRelease(bytes32 escrowId)',
  'function resolve(bytes32 escrowId, uint8 completionPct)',

  // Events
  'event EscrowCreated(bytes32 indexed escrowId, address indexed client, address token, uint256 amount, bytes32 criteriaHash)',
  'event EscrowAccepted(bytes32 indexed escrowId, address indexed worker)',
  'event WorkSubmitted(bytes32 indexed escrowId, bytes32 evidenceHash)',
  'event EscrowReleased(bytes32 indexed escrowId, uint256 workerAmount, uint256 protocolFee)',
  'event EscrowDisputed(bytes32 indexed escrowId, uint256 disputeFee)',
  'event EscrowResolved(bytes32 indexed escrowId, uint8 outcome, uint8 completionPct, uint256 workerAmount, uint256 clientRefund)',
]);

// State enum mapping
const EscrowState = ['Pending', 'Active', 'Submitted', 'Disputed', 'Resolved'] as const;
const Outcome = ['None', 'FullRelease', 'FullRefund', 'Partial'] as const;

// Clients
const publicClient = createPublicClient({
  chain: baseSepolia,
  transport: http(process.env.RPC_URL),
});

function getWalletClient(privateKey: Hex) {
  const account = privateKeyToAccount(privateKey);
  return createWalletClient({
    account,
    chain: baseSepolia,
    transport: http(process.env.RPC_URL),
  });
}

const contractAddress = process.env.ESCROW_CONTRACT_ADDRESS as Address;

export interface EscrowData {
  id: string;
  client: string;
  worker: string;
  token: string;
  amount: string;
  deadline: number;
  criteriaHash: string;
  state: string;
  outcome: string;
  completionPct: number;
  createdAt: number;
  submittedAt: number;
  evidenceHash: string | null;
  reviewPeriod: number;
}

export async function getEscrow(escrowId: Hex): Promise<EscrowData> {
  const result = await publicClient.readContract({
    address: contractAddress,
    abi: escrowAbi,
    functionName: 'getEscrow',
    args: [escrowId],
  });

  const [
    client,
    worker,
    token,
    amount,
    deadline,
    criteriaHash,
    state,
    outcome,
    completionPct,
    createdAt,
    submittedAt,
    evidenceHash,
    reviewPeriod,
  ] = result as unknown as [Address, Address, Address, bigint, bigint, Hex, number, number, number, bigint, bigint, Hex, bigint];

  return {
    id: escrowId,
    client,
    worker,
    token,
    amount: amount.toString(),
    deadline: Number(deadline),
    criteriaHash,
    state: EscrowState[state] || 'Unknown',
    outcome: Outcome[outcome] || 'Unknown',
    completionPct,
    createdAt: Number(createdAt),
    submittedAt: Number(submittedAt),
    evidenceHash: evidenceHash === '0x0000000000000000000000000000000000000000000000000000000000000000'
      ? null
      : evidenceHash,
    reviewPeriod: Number(reviewPeriod),
  };
}

export async function getProtocolStatus() {
  const [minAmount, maxAmount, protocolFee, disputeFee, arbitrator, escrowCount] = await Promise.all([
    publicClient.readContract({
      address: contractAddress,
      abi: escrowAbi,
      functionName: 'minEscrowAmount',
    }),
    publicClient.readContract({
      address: contractAddress,
      abi: escrowAbi,
      functionName: 'maxEscrowAmount',
    }),
    publicClient.readContract({
      address: contractAddress,
      abi: escrowAbi,
      functionName: 'protocolFeeBps',
    }),
    publicClient.readContract({
      address: contractAddress,
      abi: escrowAbi,
      functionName: 'disputeFeeBps',
    }),
    publicClient.readContract({
      address: contractAddress,
      abi: escrowAbi,
      functionName: 'arbitrator',
    }),
    publicClient.readContract({
      address: contractAddress,
      abi: escrowAbi,
      functionName: 'escrowCount',
    }),
  ]);

  return {
    contractAddress,
    chain: 'base-sepolia',
    chainId: baseSepolia.id,
    minEscrowAmount: (minAmount as bigint).toString(),
    maxEscrowAmount: (maxAmount as bigint).toString(),
    protocolFeeBps: Number(protocolFee),
    disputeFeeBps: Number(disputeFee),
    arbitrator: arbitrator as Address,
    totalEscrows: Number(escrowCount),
  };
}

export async function createEscrow(
  privateKey: Hex,
  token: Address,
  amount: bigint,
  deadline: bigint,
  criteriaHash: Hex,
  reviewPeriod: bigint = 0n
): Promise<{ escrowId: Hex; txHash: Hash }> {
  const walletClient = getWalletClient(privateKey);

  const isEth = token === '0x0000000000000000000000000000000000000000';

  const hash = await walletClient.writeContract({
    address: contractAddress,
    abi: escrowAbi,
    functionName: 'createEscrow',
    args: [token, amount, deadline, criteriaHash, reviewPeriod],
    value: isEth ? amount : 0n,
  });

  // Wait for transaction and get escrow ID from event
  const receipt = await publicClient.waitForTransactionReceipt({ hash });

  // Parse the EscrowCreated event to get the escrow ID
  const escrowCreatedLog = receipt.logs.find(log => {
    try {
      return log.topics[0] === '0x' + 'EscrowCreated'.padEnd(64, '0'); // Simplified
    } catch {
      return false;
    }
  });

  // For now, return the first topic as escrow ID (it's indexed)
  const escrowId = receipt.logs[0]?.topics[1] as Hex || '0x';

  return { escrowId, txHash: hash };
}

export async function acceptEscrow(privateKey: Hex, escrowId: Hex): Promise<Hash> {
  const walletClient = getWalletClient(privateKey);

  const hash = await walletClient.writeContract({
    address: contractAddress,
    abi: escrowAbi,
    functionName: 'acceptEscrow',
    args: [escrowId],
  });

  await publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

export async function submitWork(privateKey: Hex, escrowId: Hex, evidenceHash: Hex): Promise<Hash> {
  const walletClient = getWalletClient(privateKey);

  const hash = await walletClient.writeContract({
    address: contractAddress,
    abi: escrowAbi,
    functionName: 'submitWork',
    args: [escrowId, evidenceHash],
  });

  await publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

export async function releaseEscrow(privateKey: Hex, escrowId: Hex): Promise<Hash> {
  const walletClient = getWalletClient(privateKey);

  const hash = await walletClient.writeContract({
    address: contractAddress,
    abi: escrowAbi,
    functionName: 'release',
    args: [escrowId],
  });

  await publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

export async function disputeEscrow(privateKey: Hex, escrowId: Hex, disputeFee: bigint): Promise<Hash> {
  const walletClient = getWalletClient(privateKey);

  const hash = await walletClient.writeContract({
    address: contractAddress,
    abi: escrowAbi,
    functionName: 'dispute',
    args: [escrowId],
    value: disputeFee,
  });

  await publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

export async function autoReleaseEscrow(privateKey: Hex, escrowId: Hex): Promise<Hash> {
  const walletClient = getWalletClient(privateKey);

  const hash = await walletClient.writeContract({
    address: contractAddress,
    abi: escrowAbi,
    functionName: 'autoRelease',
    args: [escrowId],
  });

  await publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

export async function resolveDispute(privateKey: Hex, escrowId: Hex, completionPct: number): Promise<Hash> {
  const walletClient = getWalletClient(privateKey);

  const hash = await walletClient.writeContract({
    address: contractAddress,
    abi: escrowAbi,
    functionName: 'resolve',
    args: [escrowId, completionPct],
  });

  await publicClient.waitForTransactionReceipt({ hash });
  return hash;
}
