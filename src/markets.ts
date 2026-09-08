const API_URL = process.env.PREDICT_API_URL ?? "https://api.predict.fun";
const API_KEY = process.env.PREDICT_API_KEY ?? "";
const WINDOW_SEC = 5 * 60;

export type Btc5mMarket = {
  id: number;
  slug: string;
  title: string;
  startsAt: string;
  endsAt: string;
  tradingStatus: string;
};

type CategoryResponse = {
  success: boolean;
  data?: {
    slug: string;
    startsAt: string;
    endsAt: string;
    markets?: Array<{
      id: number;
      title: string;
      tradingStatus?: string;
    }>;
  };
};

function windowStart(at = Date.now()): number {
  return Math.floor(at / 1000 / WINDOW_SEC) * WINDOW_SEC;
}

function slugFor(startTs: number): string {
  return `btc-updown-5m-${startTs}`;
}

async function fetchCategory(slug: string): Promise<Btc5mMarket | null> {
  const response = await fetch(`${API_URL}/v1/categories/${slug}`, {
    headers: { "x-api-key": API_KEY },
  });

  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`GET /v1/categories/${slug} failed: ${response.status}`);
  }

  const body = (await response.json()) as CategoryResponse;
  const category = body.data;
  const first = category?.markets?.[0];
  if (!category || !first) return null;

  return {
    id: first.id,
    slug: category.slug,
    title: first.title,
    startsAt: category.startsAt,
    endsAt: category.endsAt,
    tradingStatus: first.tradingStatus ?? "UNKNOWN",
  };
}

export async function resolveBtc5mMarket(): Promise<Btc5mMarket> {
  const start = windowStart();
  const slugs = [slugFor(start), slugFor(start + WINDOW_SEC), slugFor(start - WINDOW_SEC)];

  for (const slug of slugs) {
    const market = await fetchCategory(slug);
    if (market) return market;
  }

  throw new Error(`No BTC 5m market found for ${slugFor(start)}`);
}
