import { config } from "./config.js";

/** Subset of the Jupiter /quote response that the bot relies on. */
export interface QuoteResponse {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: "ExactIn" | "ExactOut";
  slippageBps: number;
  priceImpactPct: string;
  routePlan: Array<{
    swapInfo: { ammKey: string; label?: string; inputMint: string; outputMint: string; inAmount: string; outAmount: string };
    percent: number;
  }>;
  contextSlot?: number;
  [key: string]: unknown;
}

export interface SerializedInstruction {
  programId: string;
  accounts: Array<{ pubkey: string; isSigner: boolean; isWritable: boolean }>;
  data: string; // base64
}

export interface SwapInstructionsResponse {
  tokenLedgerInstruction?: SerializedInstruction | null;
  computeBudgetInstructions: SerializedInstruction[];
  setupInstructions: SerializedInstruction[];
  swapInstruction: SerializedInstruction;
  cleanupInstruction?: SerializedInstruction | null;
  otherInstructions?: SerializedInstruction[];
  addressLookupTableAddresses: string[];
  error?: string;
}

function headers(extra: Record<string, string> = {}): Record<string, string> {
  const h: Record<string, string> = { Accept: "application/json", ...extra };
  if (config.jupiterApiKey) h["x-api-key"] = config.jupiterApiKey;
  return h;
}

// --- Rate limiting ---------------------------------------------------------
// Jupiter limits: keyless = 0.5 req/s (30/min), free key = 1 req/s (60/min).
// Every request waits for its slot so we never exceed config.jupiterRps.
const minGapMs = Math.ceil(1000 / config.jupiterRps);
let nextSlot = 0;
let backoffUntil = 0;
let lastRateLimitLog = 0;

async function waitForSlot(): Promise<void> {
  const now = Date.now();
  const slot = Math.max(now, nextSlot, backoffUntil);
  nextSlot = slot + minGapMs;
  if (slot > now) await new Promise((r) => setTimeout(r, slot - now));
}

export class RateLimitError extends Error {}

async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  await waitForSlot();
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(5_000) });
  const text = await res.text();
  if (res.status === 429) {
    // Pause all requests for a few seconds, then carry on.
    backoffUntil = Date.now() + 5_000;
    if (Date.now() - lastRateLimitLog > 30_000) {
      lastRateLimitLog = Date.now();
      console.warn(
        `⚠️  Jupiter rate limit hit; pausing 5s. ${config.jupiterApiKey ? "Lower JUPITER_RPS." : "Add a free JUPITER_API_KEY to double the limit."}`,
      );
    }
    throw new RateLimitError("Jupiter 429 Too Many Requests");
  }
  if (!res.ok) throw new Error(`Jupiter ${res.status} ${res.statusText}: ${text.slice(0, 300)}`);
  return JSON.parse(text) as T;
}

/** Mints Jupiter reports as TOKEN_NOT_TRADABLE; skipped for the rest of the run. */
export const untradableMints = new Set<string>();

export async function getQuote(params: {
  inputMint: string;
  outputMint: string;
  amount: bigint;
}): Promise<QuoteResponse | null> {
  const qs = new URLSearchParams({
    inputMint: params.inputMint,
    outputMint: params.outputMint,
    amount: params.amount.toString(),
    slippageBps: "0",
    onlyDirectRoutes: "false",
    // Keep each leg small so both fit in a single transaction.
    maxAccounts: String(config.maxAccountsPerLeg),
    restrictIntermediateTokens: "true",
  });
  try {
    return await request<QuoteResponse>(`${config.jupiterApiUrl}/quote?${qs}`, { headers: headers() });
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes("TOKEN_NOT_TRADABLE")) {
      for (const mint of [params.inputMint, params.outputMint]) {
        if (msg.includes(mint) && !untradableMints.has(mint)) {
          untradableMints.add(mint);
          console.warn(`⚠️  Jupiter says ${mint} is not tradable; skipping it from now on.`);
        }
      }
      return null;
    }
    // No route / rate limit: treat as "no opportunity" for this round.
    if (process.env.DEBUG && !(err instanceof RateLimitError)) console.warn(`[quote] ${params.inputMint} -> ${params.outputMint}:`, (err as Error).message);
    return null;
  }
}

/**
 * Fuse the two legs (BASE -> X and X -> BASE) into one circular route.
 *
 * Jupiter's route instruction checks on-chain that the final output is at
 * least `outAmount * (1 - slippageBps)`. By setting outAmount to
 * `inAmount + minProfit` and slippage to 0, the whole transaction reverts
 * unless it ends with at least that much of the base token. A failed arb then
 * costs only the network fee, never principal.
 */
export function buildCircularQuote(leg1: QuoteResponse, leg2: QuoteResponse, minOut: bigint): QuoteResponse {
  return {
    ...leg1,
    outputMint: leg2.outputMint,
    outAmount: minOut.toString(),
    otherAmountThreshold: minOut.toString(),
    slippageBps: 0,
    priceImpactPct: "0",
    routePlan: [...leg1.routePlan, ...leg2.routePlan],
  };
}

export async function getSwapInstructions(quote: QuoteResponse, userPublicKey: string): Promise<SwapInstructionsResponse> {
  const body = {
    quoteResponse: quote,
    userPublicKey,
    // Base token account must already exist; we never wrap/unwrap mid-arb.
    wrapAndUnwrapSol: false,
    // Shared accounts don't support circular routes.
    useSharedAccounts: false,
    dynamicComputeUnitLimit: false,
    skipUserAccountsRpcCalls: true,
  };
  const res = await request<SwapInstructionsResponse>(`${config.jupiterApiUrl}/swap-instructions`, {
    method: "POST",
    headers: headers({ "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  });
  if (res.error) throw new Error(`swap-instructions error: ${res.error}`);
  return res;
}
