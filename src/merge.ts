import { formatEther, JsonRpcProvider, Wallet } from "ethers";
import { ChainId, OrderBuilder } from "@predictdotfun/sdk";
import { resolveBtc5mMarket, type Btc5mMarket } from "./markets";

const API_URL = process.env.PREDICT_API_URL ?? "https://api.predict.fun";
const RPC_URL = process.env.RPC_URL ?? "https://bsc-dataseed.binance.org";
const INTERVAL_MS = Number(process.env.MERGE_INTERVAL_MS ?? "60000");
const MIN_MERGE_WEI = BigInt(process.env.MERGE_MIN_WEI ?? "10000000000000000"); // 0.01 shares

type ApiEnvelope<T> = {
  success: boolean;
  cursor?: string;
  data?: T;
  error?: { code?: string; message?: string };
};

type Outcome = {
  name: string;
  indexSet: number;
  onChainId: string;
};

type MarketDetails = {
  id: number;
  title: string;
  tradingStatus: string;
  conditionId: string;
  isNegRisk: boolean;
  isYieldBearing: boolean;
  outcomes: Outcome[];
};

type PositionRow = {
  id: string;
  amount: string;
  market: MarketDetails;
  outcome: Outcome;
};

type Session = {
  apiKey: string;
  predictAccount?: string;
  signer: Wallet;
  builder: OrderBuilder;
  maker: string;
  jwt: string;
};

let session: Session | null = null;
let approvedKey: string | null = null;
let busy = false;

function ts(): string {
  return new Date().toISOString();
}

function apiHeaders(jwt?: string): HeadersInit {
  const apiKey = session?.apiKey ?? process.env.PREDICT_API_KEY;
  if (!apiKey) throw new Error("PREDICT_API_KEY is missing. Copy .env.example to .env.");
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-api-key": apiKey,
  };
  if (jwt) headers.authorization = `Bearer ${jwt}`;
  return headers;
}

async function api<T>(path: string, init: RequestInit = {}, retryAuth = true): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, init);
  const body = (await response.json()) as ApiEnvelope<T>;
  if (!response.ok || !body.success || body.data == null) {
    const status = response.status;
    if (status === 401 && retryAuth && session) {
      await refreshJwt();
      const headers = new Headers(init.headers);
      headers.set("authorization", `Bearer ${session.jwt}`);
      return api<T>(path, { ...init, headers }, false);
    }
    const detail = body.error?.message ?? body.error?.code ?? JSON.stringify(body);
    const error = new Error(`${init.method ?? "GET"} ${path} failed (${status}): ${detail}`);
    (error as Error & { status?: number }).status = status;
    throw error;
  }
  return body.data;
}

async function apiPage<T>(
  path: string,
  init: RequestInit = {},
  retryAuth = true,
): Promise<{ data: T; cursor?: string }> {
  const response = await fetch(`${API_URL}${path}`, init);
  const body = (await response.json()) as ApiEnvelope<T>;
  if (!response.ok || !body.success || body.data == null) {
    const status = response.status;
    if (status === 401 && retryAuth && session) {
      await refreshJwt();
      const headers = new Headers(init.headers);
      headers.set("authorization", `Bearer ${session.jwt}`);
      return apiPage<T>(path, { ...init, headers }, false);
    }
    const detail = body.error?.message ?? body.error?.code ?? JSON.stringify(body);
    throw new Error(`${init.method ?? "GET"} ${path} failed (${status}): ${detail}`);
  }
  return { data: body.data, cursor: body.cursor };
}

async function getJwt(
  signer: Wallet,
  builder: OrderBuilder,
  predictAccount?: string,
): Promise<string> {
  const { message } = await api<{ message: string }>("/v1/auth/message", {
    headers: apiHeaders(),
  });

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

async function refreshJwt() {
  if (!session) throw new Error("Merge session is not initialized");
  session.jwt = await getJwt(session.signer, session.builder, session.predictAccount);
}

function parseAmount(value: string | undefined): bigint {
  if (!value) return 0n;
  const trimmed = value.trim();
  if (!trimmed) return 0n;
  try {
    if (trimmed.includes(".")) {
      const [whole, frac = ""] = trimmed.split(".");
      const padded = (frac + "000000000000000000").slice(0, 18);
      return BigInt(whole || "0") * 10n ** 18n + BigInt(padded || "0");
    }
    return BigInt(trimmed);
  } catch {
    return 0n;
  }
}

function isYes(outcome: Outcome): boolean {
  if (/^(yes|up)$/i.test(outcome.name)) return true;
  if (/^(no|down)$/i.test(outcome.name)) return false;
  return outcome.indexSet === 1;
}

async function fetchPositions(marketId: number): Promise<PositionRow[]> {
  if (!session) throw new Error("Merge session is not initialized");

  const rows: PositionRow[] = [];
  let after: string | undefined;
  for (;;) {
    const params = new URLSearchParams({
      marketId: String(marketId),
      isResolved: "false",
      first: "50",
    });
    if (after) params.set("after", after);
    const page = await apiPage<PositionRow[]>(`/v1/positions?${params}`, {
      headers: apiHeaders(session.jwt),
    });
    rows.push(...page.data);
    if (!page.cursor || page.data.length === 0) break;
    after = page.cursor;
  }
  return rows;
}

async function ensureMergeApprovals(market: MarketDetails) {
  if (!session) throw new Error("Merge session is not initialized");
  const key = `${market.isNegRisk}:${market.isYieldBearing}`;
  if (approvedKey === key) return;

  const steps = session.builder.getApprovalSteps({
    operation: "MERGE",
    isNegRisk: market.isNegRisk,
    isYieldBearing: market.isYieldBearing,
  });
  if (steps.length > 0) {
    const approvals = await session.builder.runApprovals(steps, {
      onProgress: ({ step, status }) => {
        console.log(`${ts()}  |  approval  ${step.label}  ${status}`);
      },
    });
    if (!approvals.success) {
      const failed = approvals.steps.filter((step) => step.status === "failed");
      throw new Error(`MERGE approvals failed: ${failed.map((step) => step.step.id).join(", ")}`);
    }
  }
  approvedKey = key;
}

function summarize(rows: PositionRow[]): {
  yes: bigint;
  no: bigint;
  market: MarketDetails | null;
} {
  let yes = 0n;
  let no = 0n;
  let market: MarketDetails | null = null;
  for (const row of rows) {
    market = row.market ?? market;
    const amount = parseAmount(row.amount);
    if (isYes(row.outcome)) yes += amount;
    else no += amount;
  }
  return { yes, no, market };
}

async function mergeMarket(resolved: Btc5mMarket) {
  if (!session) throw new Error("Merge session is not initialized");

  const rows = await fetchPositions(resolved.id);
  const { yes, no, market: fromPositions } = summarize(rows);
  const mergeAmount = yes < no ? yes : no;

  if (mergeAmount < MIN_MERGE_WEI) {
    console.log(
      `${ts()}  |  skip ${resolved.id}  ${resolved.title}  YES ${formatEther(yes)}  NO ${formatEther(no)}  mergeable ${formatEther(mergeAmount)}`,
    );
    return;
  }

  const market =
    fromPositions ??
    (await api<MarketDetails>(`/v1/markets/${resolved.id}`, {
      headers: apiHeaders(),
    }));

  await ensureMergeApprovals(market);

  console.log(
    `${ts()}  |  MERGE ${formatEther(mergeAmount)}  ${resolved.id}  ${market.title}  YES ${formatEther(yes)}  NO ${formatEther(no)}  condition=${market.conditionId}`,
  );

  const result = await session.builder.mergePositions({
    conditionId: market.conditionId,
    amount: mergeAmount,
    isNegRisk: market.isNegRisk,
    isYieldBearing: market.isYieldBearing,
  });

  if (!result.success) {
    throw result.cause ?? new Error("mergePositions failed");
  }

  const leftoverYes = yes - mergeAmount;
  const leftoverNo = no - mergeAmount;
  const hash = result.receipt?.hash;
  console.log(
    `${ts()}  |  merged ${formatEther(mergeAmount)} USDT  leftover YES ${formatEther(leftoverYes)}  NO ${formatEther(leftoverNo)}${hash ? `  tx=${hash}` : ""}`,
  );
}

async function tick() {
  if (busy) {
    console.log(`${ts()}  |  skip tick; previous merge still running`);
    return;
  }
  busy = true;
  try {
    const resolved = await resolveBtc5mMarket();
    await mergeMarket(resolved);
  } catch (error) {
    console.error(`${ts()}  |  ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    busy = false;
  }
}

async function main() {
  if (!Number.isFinite(INTERVAL_MS) || INTERVAL_MS < 1_000) {
    throw new Error("MERGE_INTERVAL_MS must be at least 1000");
  }

  const apiKey = process.env.PREDICT_API_KEY;
  if (!apiKey) {
    throw new Error("PREDICT_API_KEY is missing. Copy .env.example to .env.");
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
  const maker = predictAccount ?? signer.address;

  session = {
    apiKey,
    predictAccount,
    signer,
    builder,
    maker,
    jwt: "",
  };
  await refreshJwt();

  console.log(
    `${ts()}  |  MERGE maker=${maker}  interval=${INTERVAL_MS}ms  min=${formatEther(MIN_MERGE_WEI)} shares`,
  );

  await tick();
  const timer = setInterval(() => {
    void tick();
  }, INTERVAL_MS);

  const shutdown = () => {
    clearInterval(timer);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
