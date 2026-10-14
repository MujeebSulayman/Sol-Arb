import { Connection } from "@solana/web3.js";
import { config, WSOL_MINT } from "./config.js";
import { buildCircularQuote, getQuote, getSwapInstructions, type QuoteResponse } from "./jupiter.js";
import { buildTransaction, send, simulate } from "./executor.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const short = (mint: string) => `${mint.slice(0, 4)}…${mint.slice(-4)}`;

interface Opportunity {
  targetMint: string;
  leg1: QuoteResponse;
  leg2: QuoteResponse;
  amountIn: bigint;
  amountOut: bigint;
  grossProfit: bigint;
  netProfit: bigint; // after fees, only meaningful in base units
}

/** Network cost of one attempt, in lamports. */
function estimatedFeeLamports(): bigint {
  const baseFee = 5_000n;
  const priority = (BigInt(config.priorityFeeMicroLamports) * BigInt(config.computeUnitLimit)) / 1_000_000n;
  const tip = config.useJito ? BigInt(config.jitoTipLamports) : 0n;
  return baseFee + priority + tip;
}

async function checkCycle(targetMint: string): Promise<Opportunity | null> {
  const amountIn = BigInt(config.tradeAmount);

  const leg1 = await getQuote({ inputMint: config.baseMint, outputMint: targetMint, amount: amountIn });
  if (!leg1) return null;

  const leg2 = await getQuote({ inputMint: targetMint, outputMint: config.baseMint, amount: BigInt(leg1.outAmount) });
  if (!leg2) return null;

  const amountOut = BigInt(leg2.outAmount);
  const grossProfit = amountOut - amountIn;
  // Fees are paid in SOL. When the base token is SOL we can subtract them
  // directly; otherwise MIN_PROFIT must be set high enough to cover them.
  const netProfit = config.baseMint === WSOL_MINT ? grossProfit - estimatedFeeLamports() : grossProfit;

  return { targetMint, leg1, leg2, amountIn, amountOut, grossProfit, netProfit };
}

async function execute(connection: Connection, opp: Opportunity): Promise<void> {
  const wallet = config.wallet!;
  // On-chain guard: revert unless we get back at least amountIn + minProfit.
  const minOut = opp.amountIn + BigInt(config.minProfit);
  const circular = buildCircularQuote(opp.leg1, opp.leg2, minOut);

  const ixs = await getSwapInstructions(circular, wallet.publicKey.toBase58());
  const { tx, blockhash, lastValidBlockHeight } = await buildTransaction(connection, ixs);

  const sim = await simulate(connection, tx);
  if (!sim.ok) {
    console.log(`  simulation failed (${JSON.stringify(sim.err)}); price likely moved. Skipping.`);
    if (process.env.DEBUG) console.log(sim.logs.slice(-10).join("\n"));
    return;
  }
  console.log(`  simulation OK (${sim.unitsConsumed ?? "?"} CU)`);

  if (config.dryRun) {
    console.log("  DRY_RUN=true, not sending.");
    return;
  }

  const result = await send(connection, tx, blockhash, lastValidBlockHeight);
  if (result.landed) console.log(`  ✅ landed: https://solscan.io/tx/${result.signature}`);
  else console.log(`  ❌ did not land (${JSON.stringify(result.err)}): ${result.signature}`);
}

async function main(): Promise<void> {
  const connection = new Connection(config.rpcUrl, "confirmed");

  console.log("Solana arbitrage bot");
  console.log(`  RPC:        ${config.rpcUrl}`);
  console.log(`  Base mint:  ${config.baseMint}`);
  console.log(`  Targets:    ${config.targetMints.map(short).join(", ")}`);
  console.log(`  Trade size: ${config.tradeAmount} (base units), min profit ${config.minProfit}`);
  console.log(`  Wallet:     ${config.wallet ? config.wallet.publicKey.toBase58() : "none (scan-only mode)"}`);
  console.log(`  Mode:       ${config.dryRun ? "DRY RUN (simulate only)" : "LIVE"}${config.useJito ? " via Jito" : ""}`);
  console.log(`  Est. fee per attempt: ${estimatedFeeLamports()} lamports\n`);

  if (!config.dryRun && !config.wallet) throw new Error("DRY_RUN=false requires WALLET_PRIVATE_KEY");

  let running = true;
  process.on("SIGINT", () => {
    console.log("\nStopping after current round…");
    running = false;
  });

  let round = 0;
  while (running) {
    round++;
    for (const targetMint of config.targetMints) {
      if (!running) break;
      try {
        const opp = await checkCycle(targetMint);
        if (!opp) continue;

        const bps = Number((opp.grossProfit * 10_000n) / opp.amountIn);
        const tag = `[r${round}] ${short(config.baseMint)} → ${short(targetMint)} → ${short(config.baseMint)}`;

        if (opp.netProfit < BigInt(config.minProfit)) {
          if (process.env.DEBUG) console.log(`${tag}: ${opp.grossProfit} (${bps} bps), below threshold`);
          continue;
        }

        console.log(`${tag}: in ${opp.amountIn}, out ${opp.amountOut}, profit ${opp.grossProfit} (${bps} bps)`);
        if (!config.wallet) {
          console.log("  no wallet configured, scan-only.");
          continue;
        }
        await execute(connection, opp);
      } catch (err) {
        console.error(`[r${round}] ${short(targetMint)} error:`, (err as Error).message);
      }
    }
    if (running) await sleep(config.scanIntervalMs);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
