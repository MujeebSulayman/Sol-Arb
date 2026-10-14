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

async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(5_000) });
  const text = await res.text();
  if (!res.ok) throw new Error(`Jupiter ${res.status} ${res.statusText}: ${text.slice(0, 300)}`);
  return JSON.parse(text) as T;
}

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
    // No route / rate limit: treat as "no opportunity" for this round.
    if (process.env.DEBUG) console.warn(`[quote] ${params.inputMint} -> ${params.outputMint}:`, (err as Error).message);
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
