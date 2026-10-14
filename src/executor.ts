import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";
import { config } from "./config.js";
import type { SerializedInstruction, SwapInstructionsResponse } from "./jupiter.js";

// Official Jito tip accounts. Any one works; we pick at random to spread load.
const JITO_TIP_ACCOUNTS = [
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
  "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
  "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
  "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
  "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
  "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
];

const altCache = new Map<string, AddressLookupTableAccount>();

function toInstruction(ix: SerializedInstruction): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(ix.programId),
    keys: ix.accounts.map((a) => ({ pubkey: new PublicKey(a.pubkey), isSigner: a.isSigner, isWritable: a.isWritable })),
    data: Buffer.from(ix.data, "base64"),
  });
}

async function loadLookupTables(connection: Connection, addresses: string[]): Promise<AddressLookupTableAccount[]> {
  const missing = addresses.filter((a) => !altCache.has(a));
  if (missing.length > 0) {
    const infos = await connection.getMultipleAccountsInfo(missing.map((a) => new PublicKey(a)));
    infos.forEach((info, i) => {
      if (!info) return;
      altCache.set(
        missing[i],
        new AddressLookupTableAccount({
          key: new PublicKey(missing[i]),
          state: AddressLookupTableAccount.deserialize(info.data),
        }),
      );
    });
  }
  return addresses.map((a) => altCache.get(a)).filter((t): t is AddressLookupTableAccount => !!t);
}

export async function buildTransaction(
  connection: Connection,
  ixs: SwapInstructionsResponse,
): Promise<{ tx: VersionedTransaction; blockhash: string; lastValidBlockHeight: number }> {
  const wallet = config.wallet;
  if (!wallet) throw new Error("No wallet configured");

  const instructions: TransactionInstruction[] = [
    // Our own compute budget, ignoring Jupiter's suggestion so cost is predictable.
    ComputeBudgetProgram.setComputeUnitLimit({ units: config.computeUnitLimit }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: config.priorityFeeMicroLamports }),
    ...ixs.setupInstructions.map(toInstruction),
    toInstruction(ixs.swapInstruction),
  ];
  if (ixs.cleanupInstruction) instructions.push(toInstruction(ixs.cleanupInstruction));

  if (config.useJito && config.jitoTipLamports > 0) {
    const tipAccount = JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)];
    instructions.push(
      SystemProgram.transfer({
        fromPubkey: wallet.publicKey,
        toPubkey: new PublicKey(tipAccount),
        lamports: config.jitoTipLamports,
      }),
    );
  }

  const [lookupTables, { blockhash, lastValidBlockHeight }] = await Promise.all([
    loadLookupTables(connection, ixs.addressLookupTableAddresses),
    connection.getLatestBlockhash("confirmed"),
  ]);

  const message = new TransactionMessage({
    payerKey: wallet.publicKey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message(lookupTables);

  const tx = new VersionedTransaction(message);
  tx.sign([wallet]);

  const size = tx.serialize().length;
  if (size > 1232) throw new Error(`Transaction too large (${size} bytes); lower MAX_ACCOUNTS_PER_LEG`);

  return { tx, blockhash, lastValidBlockHeight };
}

export async function simulate(connection: Connection, tx: VersionedTransaction) {
  const sim = await connection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: false, commitment: "processed" });
  return { ok: sim.value.err === null, err: sim.value.err, unitsConsumed: sim.value.unitsConsumed, logs: sim.value.logs ?? [] };
}

async function sendViaJito(tx: VersionedTransaction): Promise<string> {
  const res = await fetch(`${config.jitoBlockEngineUrl}/api/v1/transactions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "sendTransaction",
      params: [Buffer.from(tx.serialize()).toString("base64"), { encoding: "base64" }],
    }),
    signal: AbortSignal.timeout(5_000),
  });
  const json = (await res.json()) as { result?: string; error?: { message: string } };
  if (json.error) throw new Error(`Jito: ${json.error.message}`);
  return json.result ?? bs58.encode(tx.signatures[0]);
}

export async function send(
  connection: Connection,
  tx: VersionedTransaction,
  blockhash: string,
  lastValidBlockHeight: number,
): Promise<{ signature: string; landed: boolean; err?: unknown }> {
  const signature = config.useJito
    ? await sendViaJito(tx)
    : await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 0 });

  return confirmByPolling(connection, signature, lastValidBlockHeight);
}

/**
 * Poll for confirmation over plain HTTP instead of a WebSocket subscription,
 * so it works the same on every RPC provider (Alchemy, Helius, etc.).
 */
async function confirmByPolling(
  connection: Connection,
  signature: string,
  lastValidBlockHeight: number,
): Promise<{ signature: string; landed: boolean; err?: unknown }> {
  while (true) {
    const { value } = await connection.getSignatureStatuses([signature]);
    const status = value[0];
    if (status?.err) return { signature, landed: false, err: status.err };
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") {
      return { signature, landed: true };
    }
    const height = await connection.getBlockHeight("confirmed");
    if (height > lastValidBlockHeight) {
      // Blockhash expired: the transaction never landed, so nothing was spent.
      return { signature, landed: false, err: "blockhash expired" };
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}
