import { Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";

function env(name: string, fallback?: string): string {
  const value = process.env[name]?.trim();
  if (value) return value;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required env var: ${name}`);
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`Env var ${name} must be a non-negative number, got "${raw}"`);
  return Math.floor(n);
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  return raw === "true" || raw === "1" || raw === "yes";
}

function loadWallet(): Keypair | null {
  const secret = process.env.WALLET_PRIVATE_KEY?.trim();
  if (!secret) return null;
  try {
    // Accept either base58 or a JSON byte array (Solana CLI keypair format).
    const bytes = secret.startsWith("[") ? Uint8Array.from(JSON.parse(secret)) : bs58.decode(secret);
    return Keypair.fromSecretKey(bytes);
  } catch {
    throw new Error("WALLET_PRIVATE_KEY is not a valid base58 secret key or JSON byte array");
  }
}

export const WSOL_MINT = "So11111111111111111111111111111111111111112";

const baseMint = env("BASE_MINT", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

/**
 * RPC resolution order:
 *   1. RPC_URL if set explicitly (any provider)
 *   2. ALCHEMY_API_KEY -> Alchemy Solana mainnet endpoint
 *   3. Public mainnet RPC (slow, rate-limited; testing only)
 */
function resolveRpc(): { rpcUrl: string; wsUrl?: string; provider: string } {
  const explicit = process.env.RPC_URL?.trim();
  const wsExplicit = process.env.WS_URL?.trim() || undefined;
  if (explicit) return { rpcUrl: explicit, wsUrl: wsExplicit, provider: "custom" };

  const alchemyKey = process.env.ALCHEMY_API_KEY?.trim();
  if (alchemyKey) {
    return {
      rpcUrl: `https://solana-mainnet.g.alchemy.com/v2/${alchemyKey}`,
      wsUrl: wsExplicit ?? `wss://solana-mainnet.g.alchemy.com/v2/${alchemyKey}`,
      provider: "alchemy",
    };
  }
  return { rpcUrl: "https://api.mainnet-beta.solana.com", wsUrl: wsExplicit, provider: "public" };
}

const rpc = resolveRpc();

export const config = {
  rpcUrl: rpc.rpcUrl,
  wsUrl: rpc.wsUrl,
  rpcProvider: rpc.provider,
  // api.jup.ag works with or without a key (lite-api.jup.ag is being retired).
  jupiterApiUrl: env("JUPITER_API_URL", "https://api.jup.ag/swap/v1").replace(/\/$/, ""),
  jupiterApiKey: process.env.JUPITER_API_KEY?.trim() || undefined,
  // Requests per second to Jupiter. Defaults sit just under Jupiter's limits:
  // keyless 0.5/s, free key 1/s. Raise only if your plan allows more.
  jupiterRps: Number(process.env.JUPITER_RPS?.trim()) || (process.env.JUPITER_API_KEY?.trim() ? 0.9 : 0.45),

  wallet: loadWallet(),

  baseMint,
  tradeAmount: envInt("TRADE_AMOUNT", 10_000_000),
  // Default targets: SOL, JUP, BONK
  targetMints: env(
    "TARGET_MINTS",
    [
      WSOL_MINT,
      "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
      "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
    ].join(","),
  )
    .split(",")
    .map((m) => m.trim())
    .filter((m) => m && m !== baseMint),
  minProfit: envInt("MIN_PROFIT", 10_000),
  maxAccountsPerLeg: envInt("MAX_ACCOUNTS_PER_LEG", 24),
  priorityFeeMicroLamports: envInt("PRIORITY_FEE_MICROLAMPORTS", 10_000),
  computeUnitLimit: envInt("COMPUTE_UNIT_LIMIT", 600_000),
  scanIntervalMs: envInt("SCAN_INTERVAL_MS", 2_000),

  useJito: envBool("USE_JITO", false),
  jitoTipLamports: envInt("JITO_TIP_LAMPORTS", 10_000),
  jitoBlockEngineUrl: env("JITO_BLOCK_ENGINE_URL", "https://mainnet.block-engine.jito.wtf").replace(/\/$/, ""),

  dryRun: envBool("DRY_RUN", true),
};

// Validate mints early so a typo fails loudly at startup.
for (const mint of [config.baseMint, ...config.targetMints]) {
  try {
    new PublicKey(mint);
  } catch {
    throw new Error(`Invalid mint address in config: ${mint}`);
  }
}
if (config.targetMints.length === 0) throw new Error("TARGET_MINTS must contain at least one mint other than BASE_MINT");

export type Config = typeof config;
