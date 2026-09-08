import { parseEther } from "ethers";
import { OrderBuilder, Side as OrderSide } from "@predictdotfun/sdk";

export type OutcomeSide = "YES" | "NO";

export type PresignMarket = {
  id: number;
  endsAt: string;
  feeRateBps: number;
  isNegRisk: boolean;
  isYieldBearing: boolean;
  outcomes: Array<{
    name: string;
    indexSet: number;
    onChainId: string;
  }>;
};

export type PresignedOrder = {
  marketId: number;
  epoch: number;
  side: OutcomeSide;
  shares: number;
  price: number;
  pricePerShare: string;
  expiresAtMs: number;
  signedOrder: Awaited<ReturnType<OrderBuilder["signTypedDataOrder"]>>;
  hash: string;
};

export type PresignOptions = {
  perBucket: number;
  shares: number;
  flipShares: number;
  price: number;
  minTtlMs: number;
  ttlBufferMs: number;
};

function poolKey(side: OutcomeSide, shares: number): string {
  return `${side}:${shares}`;
}

export function outcomeToken(details: PresignMarket, side: OutcomeSide): string {
  const yes =
    details.outcomes.find((outcome) => /^(yes|up)$/i.test(outcome.name)) ??
    details.outcomes.find((outcome) => outcome.indexSet === 1);
  const no =
    details.outcomes.find((outcome) => /^(no|down)$/i.test(outcome.name)) ??
    details.outcomes.find((outcome) => outcome.indexSet !== yes?.indexSet);
  const match = side === "YES" ? yes : no;
  if (!match?.onChainId) {
    throw new Error(`No ${side} outcome token on market ${details.id}`);
  }
  return match.onChainId;
}

export class PresignPool {
  private signChain: Promise<unknown> = Promise.resolve();
  private readonly pools = new Map<string, PresignedOrder[]>();

  constructor(
    private readonly builder: OrderBuilder,
    private readonly options: PresignOptions,
  ) {}

  clear() {
    this.pools.clear();
  }

  remaining(side: OutcomeSide, shares: number): number {
    return this.pools.get(poolKey(side, shares))?.length ?? 0;
  }

  take(side: OutcomeSide, shares: number, epoch: number, marketId: number): PresignedOrder | null {
    const bucket = this.pools.get(poolKey(side, shares));
    if (!bucket?.length) return null;
    const minExpiry = Date.now() + this.options.minTtlMs;
    while (bucket.length) {
      const next = bucket.shift();
      if (!next) break;
      if (next.epoch !== epoch || next.marketId !== marketId) continue;
      if (next.expiresAtMs < minExpiry) continue;
      return next;
    }
    return null;
  }

  async takeOrSign(
    details: PresignMarket,
    side: OutcomeSide,
    shares: number,
    price: number,
    epoch: number,
    stillCurrent: () => boolean,
  ): Promise<{ order: PresignedOrder; source: "presign" | "live"; signMs: number }> {
    const prepared = this.take(side, shares, epoch, details.id);
    if (prepared) return { order: prepared, source: "presign", signMs: 0 };

    const signStarted = performance.now();
    const order = await this.enqueueSign(() => {
      if (!stillCurrent()) throw new Error("Market rolled during live sign");
      return this.signLimitBuy(details, side, shares, price, epoch);
    });
    return { order, source: "live", signMs: performance.now() - signStarted };
  }

  async fill(details: PresignMarket, epoch: number, stillCurrent: () => boolean) {
    const { perBucket, shares, flipShares, price } = this.options;
    if (!(perBucket > 0)) return;

    const sizes = [shares, flipShares];
    const sides: OutcomeSide[] = ["YES", "NO"];
    const total = perBucket * sizes.length * sides.length;
    const started = performance.now();
    let done = 0;

    console.log(
      `${new Date().toISOString()}  |  presign start  ${perBucket} each  YES/NO @ ${shares} and @ ${flipShares}  total=${total}  expires=${details.endsAt}`,
    );

    for (let i = 0; i < perBucket; i++) {
      for (const size of sizes) {
        for (const side of sides) {
          if (!stillCurrent()) return;
          try {
            const signed = await this.enqueueSign(async () => {
              if (!stillCurrent()) return null;
              return this.signLimitBuy(details, side, size, price, epoch);
            });
            if (!signed) return;
            this.put(signed, epoch, details.id);
            done += 1;
          } catch (error) {
            console.error(
              `${new Date().toISOString()}  |  presign ${size} ${side} failed: ${error instanceof Error ? error.message : String(error)}`,
            );
            return;
          }
        }
      }
      if ((i + 1) % 10 === 0 || i + 1 === perBucket) {
        console.log(
          `${new Date().toISOString()}  |  presign ${done}/${total}  YES@${shares}=${this.remaining("YES", shares)}  NO@${shares}=${this.remaining("NO", shares)}  YES@${flipShares}=${this.remaining("YES", flipShares)}  NO@${flipShares}=${this.remaining("NO", flipShares)}`,
        );
      }
    }

    console.log(
      `${new Date().toISOString()}  |  presign ready  ${done}/${total}  ${Math.round(performance.now() - started)}ms`,
    );
  }

  private put(order: PresignedOrder, epoch: number, marketId: number) {
    if (order.epoch !== epoch || order.marketId !== marketId) return;
    const key = poolKey(order.side, order.shares);
    const bucket = this.pools.get(key);
    if (bucket) bucket.push(order);
    else this.pools.set(key, [order]);
  }

  private enqueueSign<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.signChain.then(fn, fn);
    this.signChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async signLimitBuy(
    details: PresignMarket,
    side: OutcomeSide,
    shares: number,
    price: number,
    epoch: number,
  ): Promise<PresignedOrder> {
    const { pricePerShare, makerAmount, takerAmount } = this.builder.getLimitOrderAmounts({
      side: OrderSide.BUY,
      pricePerShareWei: parseEther(price.toString()),
      quantityWei: parseEther(shares.toString()),
    });

    const expiresAt = new Date(
      Math.max(
        Date.now() + this.options.minTtlMs + this.options.ttlBufferMs,
        new Date(details.endsAt).getTime(),
      ),
    );

    const order = this.builder.buildOrder("LIMIT", {
      side: OrderSide.BUY,
      tokenId: outcomeToken(details, side),
      makerAmount,
      takerAmount,
      nonce: 0n,
      feeRateBps: details.feeRateBps,
      expiresAt,
    });

    const typedData = this.builder.buildTypedData(order, {
      isNegRisk: details.isNegRisk,
      isYieldBearing: details.isYieldBearing,
    });
    const signedOrder = await this.builder.signTypedDataOrder(typedData);
    const hash = this.builder.buildTypedDataHash(typedData);

    return {
      marketId: details.id,
      epoch,
      side,
      shares,
      price,
      pricePerShare: pricePerShare.toString(),
      expiresAtMs: expiresAt.getTime(),
      signedOrder,
      hash,
    };
  }
}
