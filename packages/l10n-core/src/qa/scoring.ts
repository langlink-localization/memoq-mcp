import type { QaIssue, QaSeverity } from "./types.ts";

export interface MqmOptions {
  /** Evaluation word count; must be > 0. */
  ewc: number;
  /** Severity multipliers; defaults 0/1/5/25. */
  severityWeights?: Partial<Record<QaSeverity, number>>;
  /** Optional per-rule error-type weights; default 1. */
  errorTypeWeights?: Readonly<Record<string, number>>;
  /** Optional calibration: acceptable penalty points per 1000 words. */
  acceptablePenaltyPoints?: number;
  /** Optional pass score 0..100; with acceptablePenaltyPoints produces CQS. */
  passScore?: number;
  /** Any critical issue fails regardless of score (default true). */
  failOnCritical?: boolean;
}

export interface MqmScore {
  ewc: number;
  apt: number;
  npt: number;
  rqs: number;
  cqs?: number;
  pass?: boolean;
  bySeverity: Record<QaSeverity, number>;
  issues: number;
}

const DEFAULT_WEIGHTS: Record<QaSeverity, number> = {
  neutral: 0,
  minor: 1,
  major: 5,
  critical: 25,
};

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * MQM scoring (themqm.org): APT = Σ count × SPM × ETW;
 * RQS = 100 − 100×APT/EWC; NPT = APT/EWC×1000;
 * CQS = MSV − NPT×SF, SF = (MSV−PT)/APP.
 */
export function scoreMqm(issues: readonly QaIssue[], options: MqmOptions): MqmScore {
  if (!Number.isFinite(options.ewc) || options.ewc <= 0) {
    throw new Error("MQM requires a positive evaluation word count (ewc)");
  }
  const weights = { ...DEFAULT_WEIGHTS, ...options.severityWeights };
  const bySeverity: Record<QaSeverity, number> = {
    neutral: 0,
    minor: 0,
    major: 0,
    critical: 0,
  };
  let apt = 0;
  for (const issue of issues) {
    bySeverity[issue.severity] += 1;
    const etw = options.errorTypeWeights?.[issue.ruleId] ?? 1;
    if (!Number.isFinite(etw) || etw < 0) {
      throw new Error(`invalid error-type weight for ${issue.ruleId}`);
    }
    apt += weights[issue.severity] * etw;
  }
  const rqs = 100 - (100 * apt) / options.ewc;
  const npt = (apt / options.ewc) * 1000;
  const result: MqmScore = {
    ewc: options.ewc,
    apt: round(apt, 4),
    npt: round(npt, 4),
    rqs: round(rqs, 2),
    bySeverity,
    issues: issues.length,
  };
  if (options.acceptablePenaltyPoints !== undefined && options.passScore !== undefined) {
    if (options.acceptablePenaltyPoints <= 0) {
      throw new Error("acceptablePenaltyPoints must be > 0");
    }
    const msV = 100;
    const sf = (msV - options.passScore) / options.acceptablePenaltyPoints;
    const cqs = msV - npt * sf;
    result.cqs = round(cqs, 2);
    result.pass = cqs >= options.passScore;
  } else if (options.passScore !== undefined) {
    result.pass = rqs >= options.passScore;
  }
  if (options.failOnCritical !== false && bySeverity.critical > 0) result.pass = false;
  return result;
}
