import { JsonRpcProvider, Wallet, formatEther, parseEther } from "ethers";
import { ChainId, OrderBuilder, Side } from "@predictdotfun/sdk";
import { resolveBtc5mMarket } from "./markets";

const API_URL = process.env.PREDICT_API_URL ?? "https://api.predict.fun";
const RPC_URL = process.env.RPC_URL ?? "https://bsc-dataseed.binance.org";
const PRICE = 0.8;
const SHARES = Number(process.env.ORDER_SHARES ?? "5");
const MIN_ORDER_TTL_MS = 2 * 60 * 1000;
const ORDER_TTL_BUFFER_MS = 15_000;

type MarketDetails = {
  id: number;
  title: string;
  tradingStatus: string;
  feeRateBps: number;
  isNegRisk: boolean;
  isYieldBearing: boolean;
  shareThreshold?: number;
  outcomes: Array<{
    name: string;
    indexSet: number;
    onChainId: string;
  }>;
};

type ApiEnvelope<T> = {
  success: boolean;
  data?: T;
  error?: { code?: string; message?: string };
};

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is missing. Copy .env.example to .env and fill it in.`);
  }
  return value;
}

function apiHeaders(jwt?: string): HeadersInit {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-api-key": requireEnv("PREDICT_API_KEY"),
  };
  if (jwt) headers.authorization = `Bearer ${jwt}`;
  return headers;
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, init);
  const body = (await response.json()) as ApiEnvelope<T>;
  if (!response.ok || !body.success || body.data == null) {
    const detail = body.error?.message ?? body.error?.code ?? JSON.stringify(body);
    throw new Error(`${init.method ?? "GET"} ${path} failed (${response.status}): ${detail}`);
  }
  return body.data;
}

function yesOutcome(market: MarketDetails) {
  const match =
    market.outcomes.find((outcome) => /^(yes|up)$/i.test(outcome.name)) ??
    market.outcomes.find((outcome) => outcome.indexSet === 1);
  if (!match) {
    throw new Error(`No YES/Up outcome on market ${market.id}`);
  }
  return match;
}

async function getJwt(
  signer: Wallet,
  builder: OrderBuilder,
  predictAccount?: string,
): Promise<string> {
  const { message } = await api<{ message: string }>("/v1/auth/message", {
    headers: apiHeaders(),
  });
  console.log(signer.address)
  console.log(predictAccount)
  const signature = predictAccount
    ? await builder.signPredictAccountMessage(message)
    : await signer.signMessage(message);

  const { token } = await api<{ token: string }>("/v1/auth", {
    method: "POST",
    headers: apiHeaders(),
    body: JSON.stringify({
      signer: predictAccount ?? signer.address,
      message,
      signature,
    }),
  });

  return token;
}

async function main() {
  if (!Number.isFinite(SHARES) || SHARES <= 0) {
    throw new Error("ORDER_SHARES must be a positive number");
  }

  const privateKey = process.env.WALLET_PRIVATE_KEY ?? process.env.PRIVY_WALLET_PRIVATE_KEY;
  if (!privateKey) {
    throw new Error("WALLET_PRIVATE_KEY (or PRIVY_WALLET_PRIVATE_KEY) is missing.");
  }

  const predictAccount = process.env.PREDICT_ACCOUNT_ADDRESS?.trim() || undefined;
  const provider = new JsonRpcProvider(RPC_URL, 56, { staticNetwork: true });
  provider.pollingInterval = 300;
  const signer = new Wallet(privateKey, provider);
  const builder = await OrderBuilder.make(
    ChainId.BnbMainnet,
    signer,
    predictAccount ? { predictAccount } : undefined,
  );

  const resolved = await resolveBtc5mMarket();
  const market = await api<MarketDetails>(`/v1/markets/${resolved.id}`, {
    headers: apiHeaders(),
  });
  const outcome = yesOutcome(market);

  const jwt = await getJwt(signer, builder, predictAccount);
  const { pricePerShare, makerAmount, takerAmount } = builder.getLimitOrderAmounts({
    side: Side.BUY,
    pricePerShareWei: parseEther(PRICE.toString()),
    quantityWei: parseEther(SHARES.toString()),
  });

  const maker = predictAccount ?? signer.address;
  const usdt = await builder.balanceOf("USDT", maker);
  if (usdt < makerAmount) {
    throw new Error(
      `Insufficient USDT: ${formatEther(usdt)} available, ${formatEther(makerAmount)} required for this bid`,
    );
  }

  const approvalSteps = builder.getApprovalSteps({
    operation: "TRADE",
    isNegRisk: market.isNegRisk,
    isYieldBearing: market.isYieldBearing,
    side: Side.BUY,
  });
  const approvals = await builder.runApprovals(approvalSteps, {
    onProgress: ({ step, status }) => {
      console.log(`approval  ${step.label}  ${status}`);
    },
  });
  if (!approvals.success) {
    const failed = approvals.steps.filter((step) => step.status === "failed");
    throw new Error(`Approvals failed: ${failed.map((step) => step.step.id).join(", ")}`);
  }

  const expiresAt = new Date(
    Math.max(
      Date.now() + MIN_ORDER_TTL_MS + ORDER_TTL_BUFFER_MS,
      new Date(resolved.endsAt).getTime(),
    ),
  );

  const order = builder.buildOrder("LIMIT", {
    side: Side.BUY,
    tokenId: outcome.onChainId,
    makerAmount,
    takerAmount,
    nonce: 0n,
    feeRateBps: market.feeRateBps,
    expiresAt,
  });

  const typedData = builder.buildTypedData(order, {
    isNegRisk: market.isNegRisk,
    isYieldBearing: market.isYieldBearing,
  });

  const signStarted = performance.now();
  const signedOrder = await builder.signTypedDataOrder(typedData);
  const signMs = performance.now() - signStarted;
  const hash = builder.buildTypedDataHash(typedData);

  const costUsdt = Number(makerAmount) / 1e18;
  console.log(
    [
      `market ${market.id}  ${market.title}`,
      `status ${market.tradingStatus}`,
      `YES/Up ${outcome.name}  token ${outcome.onChainId}`,
      `limit BUY ${SHARES} shares @ ${PRICE}  (~${costUsdt} USDT)`,
      `USDT ${formatEther(usdt)}`,
      `expires ${expiresAt.toISOString()}`,
      `maker ${maker}`,
    ].join("\n"),
  );

  const postStarted = performance.now();
  const created = await api<unknown>("/v1/orders", {
    method: "POST",
    headers: apiHeaders(jwt),
    body: JSON.stringify({
      data: {
        strategy: "LIMIT",
        pricePerShare: pricePerShare.toString(),
        order: {
          ...signedOrder,
          hash,
          expiration: Number(signedOrder.expiration),
        },
      },
    }),
  });
  const postMs = performance.now() - postStarted;

  console.log("order placed");
  console.log(`latency  sign ${signMs.toFixed(0)}ms  post ${postMs.toFixed(0)}ms  total ${(signMs + postMs).toFixed(0)}ms`);
  console.log(JSON.stringify(created, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
