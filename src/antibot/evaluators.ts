export type AntiBotEvaluatorName = 'cloudflare' | 'sannysoft' | 'generic';

export interface AntiBotRule {
  evaluator: AntiBotEvaluatorName;
  /** Text that must be present on the page for the check to count as passed. */
  successText?: string;
  /** Any of these texts on the page means the browser was blocked. */
  failureTexts?: string[];
}

/**
 * passed    : normal page served
 * challenge : an interstitial challenge is still displayed (Cloudflare "Just a moment...", Turnstile)
 * blocked   : explicit block page / 4xx-5xx
 * detected  : page served but fingerprinting checks flagged the browser as automated
 * unknown   : could not decide (e.g. page never loaded)
 */
export type AntiBotOutcome = 'passed' | 'challenge' | 'blocked' | 'detected' | 'unknown';

export interface AntiBotVerdict {
  outcome: AntiBotOutcome;
  passed: boolean;
  detail: string;
  /** Time spent waiting after `load` for a challenge to clear. */
  resolveMs?: number;
}

export interface PageEvidence {
  html: string;
  title: string;
  url: string;
  httpStatus?: number;
}

const CLOUDFLARE_CHALLENGE_TITLES = [/just a moment/i, /un instant/i, /checking your browser/i, /attention required/i];
const CLOUDFLARE_CHALLENGE_MARKERS = ['_cf_chl_opt', 'cf-browser-verification', 'id="challenge-form"', 'cf-challenge-running'];
const CLOUDFLARE_BLOCK_MARKERS = [
  'sorry, you have been blocked',
  'cf-error-details',
  'error 1020',
  'access denied',
  'you do not have access to',
];

function verdict(outcome: AntiBotOutcome, detail: string): AntiBotVerdict {
  return { outcome, passed: outcome === 'passed', detail };
}

function applyTextRules(rule: AntiBotRule, evidence: PageEvidence): AntiBotVerdict | null {
  const html = evidence.html.toLowerCase();
  const failure = rule.failureTexts?.find((t) => html.includes(t.toLowerCase()));
  if (failure) return verdict('blocked', `failure text found: "${failure}"`);
  if (rule.successText && !html.includes(rule.successText.toLowerCase())) {
    return verdict('unknown', `success text not found: "${rule.successText}"`);
  }
  return null;
}

function evaluateCloudflare(rule: AntiBotRule, evidence: PageEvidence): AntiBotVerdict {
  const html = evidence.html.toLowerCase();
  const blockMarker = CLOUDFLARE_BLOCK_MARKERS.find((m) => html.includes(m));
  if (blockMarker) return verdict('blocked', `block page marker: "${blockMarker}"`);

  const titleHit = CLOUDFLARE_CHALLENGE_TITLES.find((re) => re.test(evidence.title));
  const markerHit = CLOUDFLARE_CHALLENGE_MARKERS.find((m) => html.includes(m.toLowerCase()));
  if (titleHit || markerHit) {
    return verdict('challenge', titleHit ? `challenge title: "${evidence.title}"` : `challenge marker: "${markerHit}"`);
  }
  if (evidence.httpStatus !== undefined && evidence.httpStatus >= 400) {
    return verdict('blocked', `HTTP ${evidence.httpStatus}`);
  }
  return applyTextRules(rule, evidence) ?? verdict('passed', 'no challenge detected');
}

/** bot.sannysoft.com marks each fingerprint check cell with class "passed" / "warn" / "failed". */
function evaluateSannysoft(rule: AntiBotRule, evidence: PageEvidence): AntiBotVerdict {
  const counts = { passed: 0, warn: 0, failed: 0 };
  for (const match of evidence.html.matchAll(/class="([^"]*)"/g)) {
    const classes = match[1].split(/\s+/);
    if (classes.includes('failed')) counts.failed++;
    else if (classes.includes('warn')) counts.warn++;
    else if (classes.includes('passed')) counts.passed++;
  }
  const detail = `${counts.passed} passed, ${counts.warn} warn, ${counts.failed} failed`;
  if (counts.passed + counts.failed + counts.warn === 0) return verdict('unknown', 'no fingerprint check results found');
  const textVerdict = applyTextRules(rule, evidence);
  if (textVerdict) return textVerdict;
  return verdict(counts.failed === 0 ? 'passed' : 'detected', detail);
}

function evaluateGeneric(rule: AntiBotRule, evidence: PageEvidence): AntiBotVerdict {
  if (evidence.httpStatus !== undefined && evidence.httpStatus >= 400) {
    return verdict('blocked', `HTTP ${evidence.httpStatus}`);
  }
  return applyTextRules(rule, evidence) ?? verdict('passed', 'page served');
}

const EVALUATORS: Record<AntiBotEvaluatorName, (rule: AntiBotRule, evidence: PageEvidence) => AntiBotVerdict> = {
  cloudflare: evaluateCloudflare,
  sannysoft: evaluateSannysoft,
  generic: evaluateGeneric,
};

export function evaluateAntiBot(rule: AntiBotRule, evidence: PageEvidence): AntiBotVerdict {
  const evaluator = EVALUATORS[rule.evaluator];
  if (!evaluator) throw new Error(`Unknown anti-bot evaluator "${rule.evaluator}"`);
  return evaluator(rule, evidence);
}

export function isKnownEvaluator(name: string): name is AntiBotEvaluatorName {
  return name in EVALUATORS;
}
