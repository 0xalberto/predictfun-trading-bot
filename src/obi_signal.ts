import type { BinanceImbalance } from "./binance";

export type Side = "YES" | "NO";
export type ObiMode = "legacy" | "predictive";
export type SignalName =
  | "NONE"
  | "BULLISH"
  | "BEARISH"
  | "YES_EXIT"
  | "NO_EXIT"
  | "REVERSAL_BEARISH"
  | "REVERSAL_BULLISH";
export type SignalAction =
  | "HOLD"
  | "BUY_YES"
  | "BUY_NO"
  | "EXIT_YES"
  | "EXIT_NO"
  | "FLIP_YES_TO_NO"
  | "FLIP_NO_TO_YES";

export type ObiConfig = {
  mode: ObiMode;
  predictionHorizonMs: number;
  executionLatencyMs: number;
  useMeasuredLatency: boolean;
  earlyEntryObi: number;
  bullishEntryPredictedObi: number;
  bearishEntryPredictedObi: number;
  yesExitObi: number;
  noExitObi: number;
  minPersistence: number;
  minExitPersistence: number;
  emaFastMs: number;
  emaSlowMs: number;
  velocityLookbackMs: number;
  velocitySlowLookbackMs: number;
  accelerationLookbackMs: number;
  persistenceWindowMs: number;
  micropriceLookbackMs: number;
  historyMs: number;
  staleMs: number;
  maxGapMs: number;
  minHistoryMs: number;
  minBullishVelocity: number;
  minBearishVelocity: number;
  maxPredictionVelocity: number;
  predictionFadeFactor: number;
  useMicropriceConfirmation: boolean;
  minMicropriceDelta: number;
  minEntryScore: number;
  signalLog: boolean;
  signalLogEveryMs: number;
  weightLevel: number;
  weightVelocity: number;
  weightAcceleration: number;
  weightPersistence: number;
  weightPredicted: number;
  weightMicroprice: number;
};

export type ObiFeatures = {
  ts: number;
  rawObi: number;
  obiFast: number;
  obiSlow: number;
  velocity: number;
  velocitySlow: number;
  acceleration: number;
  bullishPersistence: number;
  bearishPersistence: number;
  yesExitPersistence: number;
  noExitPersistence: number;
  predictedObi: number;
  horizonMs: number;
  bestBid: number | null;
  bestAsk: number | null;
  bidSize: number | null;
  askSize: number | null;
  microprice: number | null;
  mid: number | null;
  micropriceDelta: number | null;
  ready: boolean;
  stale: boolean;
  sampleCount: number;
};

export type ObiDecision = {
  action: SignalAction;
  signal: SignalName;
  bullishScore: number;
  bearishScore: number;
  score: number;
};

const HOLD: ObiDecision = {
  action: "HOLD",
  signal: "NONE",
  bullishScore: 0,
  bearishScore: 0,
  score: 0,
};

const SAMPLE_CAPACITY = 128;

type Sample = {
  ts: number;
  rawObi: number;
  obiFast: number;
  obiSlow: number;
  velocity: number;
  microprice: number;
  mid: number;
  hasMicroprice: boolean;
  hasMid: boolean;
};

function env(name: string): string | undefined {
  const value = process.env[name];
  return value == null || value === "" ? undefined : value;
}

function parseNumber(name: string, fallback: number): number {
  const raw = env(name);
  if (raw == null) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function parseBool(name: string, fallback: boolean): boolean {
  const raw = env(name)?.trim().toLowerCase();
  if (raw == null) return fallback;
  if (raw === "1" || raw === "true" || raw === "yes") return true;
  if (raw === "0" || raw === "false" || raw === "no") return false;
  return fallback;
}

function parseMode(name: string, fallback: ObiMode): ObiMode {
  const raw = env(name)?.trim().toLowerCase();
  if (raw === "legacy" || raw === "predictive") return raw;
  return fallback;
}

/** Thresholds: `80` or `0.8` both mean +0.8. Velocity: `133` or `1.33` both mean 1.33 OBI/sec. */
export function parseObiUnit(value: number, kind: "level" | "velocity"): number {
  if (!Number.isFinite(value)) return 0;
  if (kind === "level") return Math.abs(value) > 1 ? value / 100 : value;
  return Math.abs(value) > 10 ? value / 100 : value;
}

export function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

export function timeEma(prev: number, value: number, dtMs: number, tauMs: number): number {
  if (!(tauMs > 0)) return value;
  if (!(dtMs > 0)) return prev;
  const alpha = 1 - Math.exp(-dtMs / tauMs);
  return alpha * value + (1 - alpha) * prev;
}

export function computeMicroprice(
  bid: number | null | undefined,
  ask: number | null | undefined,
  bidSize: number | null | undefined,
  askSize: number | null | undefined,
): number | null {
  if (
    bid == null ||
    ask == null ||
    bidSize == null ||
    askSize == null ||
    !Number.isFinite(bid) ||
    !Number.isFinite(ask) ||
    !Number.isFinite(bidSize) ||
    !Number.isFinite(askSize)
  ) {
    return null;
  }
  const denom = bidSize + askSize;
  if (!(denom > 0)) return null;
  return (ask * bidSize + bid * askSize) / denom;
}

function derivedMinVelocity(entryPredicted: number, earlyEntry: number, horizonMs: number): number {
  const horizonS = Math.max(horizonMs, 1) / 1000;
  return Math.abs(entryPredicted - earlyEntry) / horizonS;
}

export function defaultObiConfig(): ObiConfig {
  const predictionHorizonMs = 300;
  const earlyEntryObi = 0.4;
  const bullishEntryPredictedObi = 0.8;
  const minVelocity = derivedMinVelocity(
    bullishEntryPredictedObi,
    earlyEntryObi,
    predictionHorizonMs,
  );

  return {
    mode: "legacy",
    predictionHorizonMs,
    executionLatencyMs: 300,
    useMeasuredLatency: false,
    earlyEntryObi,
    bullishEntryPredictedObi,
    bearishEntryPredictedObi: -0.8,
    yesExitObi: 0.3,
    noExitObi: -0.3,
    minPersistence: 0.7,
    minExitPersistence: 0.7,
    emaFastMs: 50,
    emaSlowMs: 200,
    velocityLookbackMs: 100,
    velocitySlowLookbackMs: 200,
    accelerationLookbackMs: 100,
    persistenceWindowMs: 200,
    micropriceLookbackMs: 100,
    historyMs: 1000,
    staleMs: 400,
    maxGapMs: 500,
    minHistoryMs: 200,
    minBullishVelocity: minVelocity,
    minBearishVelocity: minVelocity,
    maxPredictionVelocity: 3,
    predictionFadeFactor: 0.7,
    useMicropriceConfirmation: true,
    minMicropriceDelta: 0,
    minEntryScore: 0,
    signalLog: false,
    signalLogEveryMs: 0,
    weightLevel: 0.25,
    weightVelocity: 0.2,
    weightAcceleration: 0.1,
    weightPersistence: 0.2,
    weightPredicted: 0.2,
    weightMicroprice: 0.05,
  };
}

export function loadObiConfigFromEnv(): ObiConfig {
  const base = defaultObiConfig();
  const executionLatencyMs = parseNumber(
    "EXECUTION_LATENCY_MS",
    parseNumber("ORDER_POST_LATENCY_MS", base.executionLatencyMs),
  );
  const predictionHorizonMs = parseNumber("PREDICTION_HORIZON_MS", executionLatencyMs);
  const earlyEntryObi = parseObiUnit(parseNumber("EARLY_ENTRY_OBI", base.earlyEntryObi * 100), "level");
  const bullishEntryPredictedObi = parseObiUnit(
    parseNumber("BULLISH_ENTRY_PREDICTED_OBI", base.bullishEntryPredictedObi * 100),
    "level",
  );
  const derived = derivedMinVelocity(bullishEntryPredictedObi, earlyEntryObi, predictionHorizonMs);
  const minVelocityRaw = env("MIN_BULLISH_VELOCITY");
  const minVelocity = minVelocityRaw == null
    ? derived
    : Math.abs(parseObiUnit(Number(minVelocityRaw), "velocity"));

  return {
    ...base,
    mode: parseMode("OBI_MODE", base.mode),
    predictionHorizonMs,
    executionLatencyMs,
    useMeasuredLatency: parseBool("USE_MEASURED_LATENCY", base.useMeasuredLatency),
    earlyEntryObi,
    bullishEntryPredictedObi,
    bearishEntryPredictedObi: parseObiUnit(
      parseNumber("BEARISH_ENTRY_PREDICTED_OBI", base.bearishEntryPredictedObi * 100),
      "level",
    ),
    yesExitObi: parseObiUnit(parseNumber("YES_EXIT_OBI", base.yesExitObi * 100), "level"),
    noExitObi: parseObiUnit(parseNumber("NO_EXIT_OBI", base.noExitObi * 100), "level"),
    minPersistence: parseNumber("MIN_PERSISTENCE", base.minPersistence),
    minExitPersistence: parseNumber("MIN_EXIT_PERSISTENCE", parseNumber("MIN_PERSISTENCE", base.minExitPersistence)),
    emaFastMs: parseNumber("EMA_FAST_MS", base.emaFastMs),
    emaSlowMs: parseNumber("EMA_SLOW_MS", base.emaSlowMs),
    velocityLookbackMs: parseNumber("VELOCITY_LOOKBACK_MS", base.velocityLookbackMs),
    velocitySlowLookbackMs: parseNumber("VELOCITY_SLOW_LOOKBACK_MS", base.velocitySlowLookbackMs),
    accelerationLookbackMs: parseNumber("ACCELERATION_LOOKBACK_MS", base.accelerationLookbackMs),
    persistenceWindowMs: parseNumber("PERSISTENCE_WINDOW_MS", base.persistenceWindowMs),
    micropriceLookbackMs: parseNumber("MICROPRICE_LOOKBACK_MS", base.micropriceLookbackMs),
    historyMs: parseNumber("OBI_HISTORY_MS", base.historyMs),
    staleMs: parseNumber("OBI_STALE_MS", base.staleMs),
    maxGapMs: parseNumber("OBI_MAX_GAP_MS", base.maxGapMs),
    minHistoryMs: parseNumber("OBI_MIN_HISTORY_MS", base.minHistoryMs),
    minBullishVelocity: minVelocity,
    minBearishVelocity: Math.abs(
      minVelocityRaw == null && env("MIN_BEARISH_VELOCITY") == null
        ? derived
        : parseObiUnit(parseNumber("MIN_BEARISH_VELOCITY", minVelocity * 100), "velocity"),
    ),
    maxPredictionVelocity: Math.abs(
      parseObiUnit(parseNumber("MAX_PREDICTION_VELOCITY", base.maxPredictionVelocity * 100), "velocity"),
    ),
    predictionFadeFactor: parseNumber("PREDICTION_FADE_FACTOR", base.predictionFadeFactor),
    useMicropriceConfirmation: parseBool("USE_MICROPRICE_CONFIRMATION", base.useMicropriceConfirmation),
    minMicropriceDelta: parseNumber("MIN_MICROPRICE_DELTA", base.minMicropriceDelta),
    minEntryScore: parseNumber("MIN_ENTRY_SCORE", base.minEntryScore),
    signalLog: parseBool("OBI_SIGNAL_LOG", base.signalLog),
    signalLogEveryMs: parseNumber("OBI_SIGNAL_LOG_EVERY_MS", base.signalLogEveryMs),
  };
}

export function resolutionHorizonMs(
  config: ObiConfig,
  estimatedLatencyMs?: number | null,
): number {
  if (
    config.useMeasuredLatency &&
    estimatedLatencyMs != null &&
    Number.isFinite(estimatedLatencyMs) &&
    estimatedLatencyMs > 0
  ) {
    return clamp(estimatedLatencyMs, 50, 1000);
  }
  return config.predictionHorizonMs;
}

export class RollingLatency {
  private ema: number | null = null;

  constructor(
    private readonly fallbackMs: number,
    private readonly alpha = 0.2,
  ) {}

  observe(ms: number) {
    if (!(ms > 0) || !Number.isFinite(ms)) return;
    this.ema = this.ema == null ? ms : this.alpha * ms + (1 - this.alpha) * this.ema;
  }

  get ms(): number {
    return this.ema ?? this.fallbackMs;
  }
}

function emptySample(): Sample {
  return {
    ts: 0,
    rawObi: 0,
    obiFast: 0,
    obiSlow: 0,
    velocity: 0,
    microprice: 0,
    mid: 0,
    hasMicroprice: false,
    hasMid: false,
  };
}

export function predictObi(
  obiFast: number,
  velocity: number,
  acceleration: number,
  horizonMs: number,
  config: Pick<ObiConfig, "maxPredictionVelocity" | "predictionFadeFactor">,
): number {
  const horizonS = Math.max(horizonMs, 0) / 1000;
  const cappedVel = clamp(velocity, -config.maxPredictionVelocity, config.maxPredictionVelocity);
  let delta = cappedVel * horizonS;
  if (acceleration * cappedVel < 0) {
    delta *= config.predictionFadeFactor;
  }
  return clamp(obiFast + delta, -1, 1);
}

export function scoreTerms(
  features: ObiFeatures,
  config: ObiConfig,
): { bullishScore: number; bearishScore: number } {
  const entry = Math.max(config.bullishEntryPredictedObi, 1e-6);
  const minVel = Math.max(config.minBullishVelocity, 1e-6);
  const accScale = Math.max(minVel / Math.max(config.accelerationLookbackMs / 1000, 0.05), 1e-6);
  const microScale = 2;

  const levelBull = clamp(features.obiFast / entry, 0, 1);
  const levelBear = clamp(-features.obiFast / entry, 0, 1);
  const velBull = clamp(features.velocity / minVel, 0, 1);
  const velBear = clamp(-features.velocity / minVel, 0, 1);
  const accBull = clamp(features.acceleration / accScale, 0, 1);
  const accBear = clamp(-features.acceleration / accScale, 0, 1);
  const predBull = clamp(features.predictedObi / entry, 0, 1);
  const predBear = clamp(-features.predictedObi / entry, 0, 1);
  const microDelta = features.micropriceDelta;
  const microBull =
    microDelta == null ? 0 : clamp(microDelta / microScale, 0, 1);
  const microBear =
    microDelta == null ? 0 : clamp(-microDelta / microScale, 0, 1);

  let wMicro = config.useMicropriceConfirmation ? config.weightMicroprice : 0;
  const wRest =
    config.weightLevel +
    config.weightVelocity +
    config.weightAcceleration +
    config.weightPersistence +
    config.weightPredicted +
    wMicro;
  const norm = wRest > 0 ? 1 / wRest : 1;

  const combine = (
    level: number,
    vel: number,
    acc: number,
    persist: number,
    pred: number,
    micro: number,
  ) =>
    clamp(
      (config.weightLevel * level +
        config.weightVelocity * vel +
        config.weightAcceleration * acc +
        config.weightPersistence * persist +
        config.weightPredicted * pred +
        wMicro * micro) *
        norm,
      0,
      1,
    );

  return {
    bullishScore: combine(
      levelBull,
      velBull,
      accBull,
      features.bullishPersistence,
      predBull,
      microBull,
    ),
    bearishScore: combine(
      levelBear,
      velBear,
      accBear,
      features.bearishPersistence,
      predBear,
      microBear,
    ),
  };
}

function micropriceConfirms(
  direction: "bull" | "bear",
  features: ObiFeatures,
  config: ObiConfig,
): boolean {
  if (!config.useMicropriceConfirmation) return true;
  const delta = features.micropriceDelta;
  if (delta == null || !Number.isFinite(delta)) return false;
  return direction === "bull"
    ? delta >= config.minMicropriceDelta
    : delta <= -config.minMicropriceDelta;
}

export function isBullishEntry(features: ObiFeatures, config: ObiConfig): boolean {
  if (!features.ready || features.stale) return false;
  if (features.obiFast < config.earlyEntryObi) return false;
  if (features.velocity < config.minBullishVelocity) return false;
  if (features.bullishPersistence < config.minPersistence) return false;
  if (features.predictedObi < config.bullishEntryPredictedObi) return false;
  if (!micropriceConfirms("bull", features, config)) return false;
  return true;
}

export function isBearishEntry(features: ObiFeatures, config: ObiConfig): boolean {
  if (!features.ready || features.stale) return false;
  if (features.obiFast > -config.earlyEntryObi) return false;
  if (features.velocity > -config.minBearishVelocity) return false;
  if (features.bearishPersistence < config.minPersistence) return false;
  if (features.predictedObi > config.bearishEntryPredictedObi) return false;
  if (!micropriceConfirms("bear", features, config)) return false;
  return true;
}

export function isYesExit(features: ObiFeatures, config: ObiConfig): boolean {
  if (!features.ready || features.stale) return false;
  return (
    features.obiFast < config.yesExitObi &&
    features.predictedObi < config.yesExitObi &&
    features.yesExitPersistence >= config.minExitPersistence
  );
}

export function isNoExit(features: ObiFeatures, config: ObiConfig): boolean {
  if (!features.ready || features.stale) return false;
  return (
    features.obiFast > config.noExitObi &&
    features.predictedObi > config.noExitObi &&
    features.noExitPersistence >= config.minExitPersistence
  );
}

function withScores(
  features: ObiFeatures,
  config: ObiConfig,
  partial: Pick<ObiDecision, "action" | "signal">,
): ObiDecision {
  const { bullishScore, bearishScore } = scoreTerms(features, config);
  const score =
    partial.signal === "BEARISH" ||
    partial.signal === "REVERSAL_BEARISH" ||
    partial.signal === "YES_EXIT"
      ? bearishScore
      : bullishScore;
  return { ...partial, bullishScore, bearishScore, score };
}

export function decideLegacy(
  rawObi: number,
  position: Side | null,
  config: ObiConfig,
): ObiDecision {
  const upEnter = rawObi > config.bullishEntryPredictedObi;
  const upExpired = rawObi < config.yesExitObi;
  const downEnter = rawObi < config.bearishEntryPredictedObi;
  const downExpired = rawObi > config.noExitObi;
  const scores = {
    bullishScore: clamp(rawObi, 0, 1),
    bearishScore: clamp(-rawObi, 0, 1),
    score: 0,
  };

  if (!position) {
    if (upEnter) return { action: "BUY_YES", signal: "BULLISH", ...scores, score: scores.bullishScore };
    if (downEnter) return { action: "BUY_NO", signal: "BEARISH", ...scores, score: scores.bearishScore };
    return HOLD;
  }

  if (position === "YES") {
    if (downEnter) {
      return { action: "FLIP_YES_TO_NO", signal: "REVERSAL_BEARISH", ...scores, score: scores.bearishScore };
    }
    if (upExpired) {
      return { action: "EXIT_YES", signal: "YES_EXIT", ...scores, score: scores.bearishScore };
    }
    return HOLD;
  }

  if (upEnter) {
    return { action: "FLIP_NO_TO_YES", signal: "REVERSAL_BULLISH", ...scores, score: scores.bullishScore };
  }
  if (downExpired) {
    return { action: "EXIT_NO", signal: "NO_EXIT", ...scores, score: scores.bullishScore };
  }
  return HOLD;
}

export function decidePredictive(
  features: ObiFeatures,
  position: Side | null,
  config: ObiConfig,
): ObiDecision {
  const bullish = isBullishEntry(features, config);
  const bearish = isBearishEntry(features, config);
  const scored = (partial: Pick<ObiDecision, "action" | "signal">) =>
    withScores(features, config, partial);

  if (!position) {
    const { bullishScore, bearishScore } = scoreTerms(features, config);
    if (bullish && bullishScore >= config.minEntryScore) {
      return { action: "BUY_YES", signal: "BULLISH", bullishScore, bearishScore, score: bullishScore };
    }
    if (bearish && bearishScore >= config.minEntryScore) {
      return { action: "BUY_NO", signal: "BEARISH", bullishScore, bearishScore, score: bearishScore };
    }
    return { action: "HOLD", signal: "NONE", bullishScore, bearishScore, score: 0 };
  }

  if (position === "YES") {
    if (bearish) return scored({ action: "FLIP_YES_TO_NO", signal: "REVERSAL_BEARISH" });
    if (isYesExit(features, config)) return scored({ action: "EXIT_YES", signal: "YES_EXIT" });
    return scored({ action: "HOLD", signal: "NONE" });
  }

  if (bullish) return scored({ action: "FLIP_NO_TO_YES", signal: "REVERSAL_BULLISH" });
  if (isNoExit(features, config)) return scored({ action: "EXIT_NO", signal: "NO_EXIT" });
  return scored({ action: "HOLD", signal: "NONE" });
}

export function decide(
  features: ObiFeatures | null,
  position: Side | null,
  config: ObiConfig,
  pendingOrder = false,
): ObiDecision {
  if (pendingOrder || features == null) return HOLD;
  if (config.mode === "legacy") return decideLegacy(features.rawObi, position, config);
  return decidePredictive(features, position, config);
}

export function formatSignalLog(
  features: ObiFeatures,
  decision: ObiDecision,
  position: Side | null,
): string {
  const pct = (value: number) => (value * 100).toFixed(1);
  const signed = (value: number | null) => {
    if (value == null || !Number.isFinite(value)) return "—";
    const sign = value > 0 ? "+" : "";
    return `${sign}${value.toFixed(2)}`;
  };
  return [
    "OBI_SIGNAL",
    `ts=${new Date(features.ts).toISOString()}`,
    `obi=${pct(features.rawObi)}`,
    `obi_fast=${pct(features.obiFast)}`,
    `obi_slow=${pct(features.obiSlow)}`,
    `velocity=${pct(features.velocity)}`,
    `acceleration=${pct(features.acceleration)}`,
    `persistence=${features.bullishPersistence.toFixed(2)}/${features.bearishPersistence.toFixed(2)}`,
    `predicted_obi=${pct(features.predictedObi)}`,
    `microprice=${features.microprice == null ? "—" : features.microprice.toFixed(2)}`,
    `microprice_delta=${signed(features.micropriceDelta)}`,
    `pos=${position ?? "FLAT"}`,
    `signal=${decision.signal}`,
    `score=${decision.score.toFixed(2)}`,
    `action=${decision.action}`,
  ].join(" ");
}

export class ObiTracker {
  private readonly samples: Sample[];
  private head = 0;
  private len = 0;
  private fastEma = 0;
  private slowEma = 0;
  private hasEma = false;
  private lastTs = 0;
  private lastUpdateId: number | null = null;
  private firstTs = 0;
  private lastLogTs = 0;
  private estimatedLatencyMs: number | null = null;

  constructor(private config: ObiConfig) {
    this.samples = Array.from({ length: SAMPLE_CAPACITY }, emptySample);
  }

  setConfig(config: ObiConfig) {
    this.config = config;
  }

  setEstimatedLatency(ms: number | null) {
    this.estimatedLatencyMs = ms;
  }

  reset() {
    this.head = 0;
    this.len = 0;
    this.fastEma = 0;
    this.slowEma = 0;
    this.hasEma = false;
    this.lastTs = 0;
    this.lastUpdateId = null;
    this.firstTs = 0;
    this.lastLogTs = 0;
  }

  get sampleCount(): number {
    return this.len;
  }

  shouldLog(decision: ObiDecision, now: number): boolean {
    if (decision.action !== "HOLD") return true;
    if (!this.config.signalLog) return false;
    if (!(this.config.signalLogEveryMs > 0)) return false;
    if (now - this.lastLogTs < this.config.signalLogEveryMs) return false;
    this.lastLogTs = now;
    return true;
  }

  update(tick: BinanceImbalance, now = tick.ts): ObiFeatures | null {
    if (!Number.isFinite(tick.imbalance) || !Number.isFinite(tick.ts)) return null;
    if (tick.ts > now) return this.latestFeatures(now);

    if (
      tick.lastUpdateId != null &&
      this.lastUpdateId != null &&
      tick.lastUpdateId < this.lastUpdateId &&
      now - this.lastTs < this.config.staleMs
    ) {
      return this.latestFeatures(now);
    }

    const dtMs = this.hasEma ? tick.ts - this.lastTs : 0;
    if (this.hasEma && dtMs < 0) return this.latestFeatures(now);

    if (!this.hasEma || dtMs > this.config.maxGapMs) {
      this.fastEma = tick.imbalance;
      this.slowEma = tick.imbalance;
      this.hasEma = true;
      if (!this.firstTs || dtMs > this.config.maxGapMs) this.firstTs = tick.ts;
    } else if (dtMs > 0) {
      this.fastEma = timeEma(this.fastEma, tick.imbalance, dtMs, this.config.emaFastMs);
      this.slowEma = timeEma(this.slowEma, tick.imbalance, dtMs, this.config.emaSlowMs);
    }

    const microprice = computeMicroprice(
      tick.bestBid,
      tick.bestAsk,
      tick.bestBidQty,
      tick.bestAskQty,
    );
    const sample = this.samples[this.head];
    sample.ts = tick.ts;
    sample.rawObi = tick.imbalance;
    sample.obiFast = this.fastEma;
    sample.obiSlow = this.slowEma;
    sample.velocity = 0;
    sample.microprice = microprice ?? 0;
    sample.mid = tick.mid ?? 0;
    sample.hasMicroprice = microprice != null;
    sample.hasMid = tick.mid != null;
    this.head = (this.head + 1) % SAMPLE_CAPACITY;
    if (this.len < SAMPLE_CAPACITY) this.len += 1;
    this.lastTs = tick.ts;
    if (tick.lastUpdateId != null) this.lastUpdateId = tick.lastUpdateId;

    const velocity = this.valueDelta(tick.ts, this.config.velocityLookbackMs, "obiFast");
    const velocitySlow = this.valueDelta(tick.ts, this.config.velocitySlowLookbackMs, "obiFast");
    sample.velocity = velocity ?? 0;

    const priorVel = this.velocityAt(tick.ts, this.config.accelerationLookbackMs);
    const accDt = this.config.accelerationLookbackMs / 1000;
    const acceleration =
      velocity != null && priorVel != null && accDt > 0 ? (velocity - priorVel) / accDt : 0;

    const persist = this.persistence(tick.ts);
    const horizonMs = resolutionHorizonMs(this.config, this.estimatedLatencyMs);
    const predictedObi = predictObi(
      this.fastEma,
      velocity ?? 0,
      acceleration,
      horizonMs,
      this.config,
    );
    const micropriceDelta = this.micropriceDelta(tick.ts);
    const ready =
      this.len >= 2 &&
      tick.ts - this.firstTs >= this.config.minHistoryMs &&
      persist.total > 0;
    const stale = now - tick.ts > this.config.staleMs;

    return {
      ts: tick.ts,
      rawObi: tick.imbalance,
      obiFast: this.fastEma,
      obiSlow: this.slowEma,
      velocity: velocity ?? 0,
      velocitySlow: velocitySlow ?? 0,
      acceleration,
      bullishPersistence: persist.bullish,
      bearishPersistence: persist.bearish,
      yesExitPersistence: persist.yesExit,
      noExitPersistence: persist.noExit,
      predictedObi,
      horizonMs,
      bestBid: tick.bestBid,
      bestAsk: tick.bestAsk,
      bidSize: tick.bestBidQty,
      askSize: tick.bestAskQty,
      microprice,
      mid: tick.mid,
      micropriceDelta,
      ready,
      stale,
      sampleCount: this.len,
    };
  }

  private at(indexFromNewest: number): Sample | null {
    if (indexFromNewest < 0 || indexFromNewest >= this.len) return null;
    const idx = (this.head - 1 - indexFromNewest + SAMPLE_CAPACITY) % SAMPLE_CAPACITY;
    return this.samples[idx];
  }

  private atOrBefore(targetTs: number, currentTs: number): Sample | null {
    for (let i = 0; i < this.len; i++) {
      const sample = this.at(i);
      if (!sample || sample.ts > currentTs) continue;
      if (sample.ts <= targetTs) return sample;
    }
    return null;
  }

  private valueDelta(
    currentTs: number,
    lookbackMs: number,
    field: "obiFast",
  ): number | null {
    const current = this.at(0);
    if (!current) return null;
    const past = this.atOrBefore(currentTs - lookbackMs, currentTs);
    if (!past || past.ts === current.ts) return null;
    const dtS = (currentTs - past.ts) / 1000;
    if (dtS < (lookbackMs / 1000) * 0.5) return null;
    if (dtS > (lookbackMs / 1000) * 3) return null;
    return (current[field] - past[field]) / dtS;
  }

  private velocityAt(currentTs: number, lookbackMs: number): number | null {
    const past = this.atOrBefore(currentTs - lookbackMs, currentTs);
    if (!past) return null;
    return past.velocity;
  }

  private persistence(currentTs: number): {
    bullish: number;
    bearish: number;
    yesExit: number;
    noExit: number;
    total: number;
  } {
    const windowStart = currentTs - this.config.persistenceWindowMs;
    let total = 0;
    let bullish = 0;
    let bearish = 0;
    let yesExit = 0;
    let noExit = 0;
    for (let i = 0; i < this.len; i++) {
      const sample = this.at(i);
      if (!sample || sample.ts > currentTs) continue;
      if (sample.ts < windowStart) break;
      total += 1;
      if (sample.obiFast > 0) bullish += 1;
      if (sample.obiFast < 0) bearish += 1;
      if (sample.obiFast < this.config.yesExitObi) yesExit += 1;
      if (sample.obiFast > this.config.noExitObi) noExit += 1;
    }
    if (total === 0) {
      return { bullish: 0, bearish: 0, yesExit: 0, noExit: 0, total: 0 };
    }
    return {
      bullish: bullish / total,
      bearish: bearish / total,
      yesExit: yesExit / total,
      noExit: noExit / total,
      total,
    };
  }

  private micropriceDelta(currentTs: number): number | null {
    const current = this.at(0);
    if (!current?.hasMicroprice) return null;
    const past = this.atOrBefore(currentTs - this.config.micropriceLookbackMs, currentTs);
    if (!past?.hasMicroprice || past.ts === current.ts) return null;
    return current.microprice - past.microprice;
  }

  private latestFeatures(now: number): ObiFeatures | null {
    const current = this.at(0);
    if (!current) return null;
    const persist = this.persistence(current.ts);
    const horizonMs = resolutionHorizonMs(this.config, this.estimatedLatencyMs);
    return {
      ts: current.ts,
      rawObi: current.rawObi,
      obiFast: current.obiFast,
      obiSlow: current.obiSlow,
      velocity: current.velocity,
      velocitySlow: 0,
      acceleration: 0,
      bullishPersistence: persist.bullish,
      bearishPersistence: persist.bearish,
      yesExitPersistence: persist.yesExit,
      noExitPersistence: persist.noExit,
      predictedObi: predictObi(current.obiFast, current.velocity, 0, horizonMs, this.config),
      horizonMs,
      bestBid: null,
      bestAsk: null,
      bidSize: null,
      askSize: null,
      microprice: current.hasMicroprice ? current.microprice : null,
      mid: current.hasMid ? current.mid : null,
      micropriceDelta: null,
      ready: current.ts - this.firstTs >= this.config.minHistoryMs,
      stale: now - current.ts > this.config.staleMs,
      sampleCount: this.len,
    };
  }
}

export function tickFromObi(
  ts: number,
  imbalance: number,
  extras: Partial<BinanceImbalance> = {},
): BinanceImbalance {
  return {
    imbalance,
    bidQty: extras.bidQty ?? (imbalance >= 0 ? 1 + imbalance : 1),
    askQty: extras.askQty ?? (imbalance < 0 ? 1 - imbalance : 1),
    levels: extras.levels ?? 10,
    ts,
    receivedAt: extras.receivedAt ?? ts,
    eventTime: extras.eventTime ?? ts,
    lastUpdateId: extras.lastUpdateId ?? null,
    bestBid: extras.bestBid ?? 100_000,
    bestAsk: extras.bestAsk ?? 100_001,
    bestBidQty: extras.bestBidQty ?? 1,
    bestAskQty: extras.bestAskQty ?? 1,
    mid: extras.mid ?? 100_000.5,
  };
}
