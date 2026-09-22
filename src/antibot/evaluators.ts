export type AntiBotEvaluatorName = 'cloudflare' | 'sannysoft' | 'deviceandbrowserinfo' | 'creepjs' | 'generic';

export interface AntiBotRule {
  evaluator: AntiBotEvaluatorName;
  /** Visible text that must be present for the check to count as passed. */
  successText?: string;
  /** Any of these visible texts means the browser was blocked. */
  failureTexts?: string[];
  /** generic: regex on visible text that must match for a pass (case-insensitive). */
  passedPattern?: string;
  /** generic: regex on visible text meaning the browser was flagged as a bot (case-insensitive). */
  detectedPattern?: string;
}

/**
 * passed    : normal page served / not flagged
 * challenge : an interstitial challenge is still displayed (Cloudflare "Just a moment...", Turnstile)
 * blocked   : explicit block page / 4xx-5xx
 * detected  : page served but the browser was flagged as automated
 * unknown   : no verdict found (page never finished computing it, layout changed...)
 */
export type AntiBotOutcome = 'passed' | 'challenge' | 'blocked' | 'detected' | 'unknown';

export interface AntiBotVerdict {
  outcome: AntiBotOutcome;
  passed: boolean;
  detail: string;
  /** Time spent after `load` waiting for a challenge to clear or a verdict to appear. */
  resolveMs?: number;
  /** Start of the page's visible text, to see what was actually served when there is no clear verdict. */
  excerpt?: string;
}

export interface PageEvidence {
  html: string;
  /** Visible text only: verdict strings also tend to appear inside the page's scripts. */
  text: string;
  title: string;
  url: string;
  httpStatus?: number;
}

const CLOUDFLARE_CHALLENGE_TITLES = [/just a moment/i, /un instant/i, /checking your browser/i, /attention required/i];
const CLOUDFLARE_CHALLENGE_MARKERS = ['_cf_chl_opt', 'cf-browser-verification', 'id="challenge-form"', 'cf-challenge-running'];
const CLOUDFLARE_BLOCK_TEXTS = ['sorry, you have been blocked', 'you are unable to access', 'error 1020', 'access denied'];

function verdict(outcome: AntiBotOutcome, detail: string): AntiBotVerdict {
  return { outcome, passed: outcome === 'passed', detail };
}

function applyTextRules(rule: AntiBotRule, evidence: PageEvidence): AntiBotVerdict | null {
  const text = evidence.text.toLowerCase();
  const failure = rule.failureTexts?.find((t) => text.includes(t.toLowerCase()));
  if (failure) return verdict('blocked', `failure text found: "${failure}"`);
  if (rule.successText && !text.includes(rule.successText.toLowerCase())) {
    return verdict('unknown', `success text not found: "${rule.successText}"`);
  }
  return null;
}

function evaluateCloudflare(rule: AntiBotRule, evidence: PageEvidence): AntiBotVerdict {
  const html = evidence.html.toLowerCase();
  const titleHit = CLOUDFLARE_CHALLENGE_TITLES.find((re) => re.test(evidence.title));
  const markerHit = CLOUDFLARE_CHALLENGE_MARKERS.find((m) => html.includes(m.toLowerCase()));
  if (titleHit || markerHit) {
    return verdict('challenge', titleHit ? `challenge title: "${evidence.title}"` : `challenge marker: "${markerHit}"`);
  }
  const text = evidence.text.toLowerCase();
  const blockText = CLOUDFLARE_BLOCK_TEXTS.find((m) => text.includes(m));
  if (blockText) return verdict('blocked', `block page: "${blockText}"`);
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
  return applyTextRules(rule, evidence) ?? verdict(counts.failed === 0 ? 'passed' : 'detected', detail);
}

/**
 * deviceandbrowserinfo.com/are_you_a_bot prints its raw verdict as JSON:
 * {"isBot": true, "details": {"hasWebdriverTrue": true, "isAutomatedWithCDP": true, ...}}
 */
function evaluateDeviceAndBrowserInfo(_rule: AntiBotRule, evidence: PageEvidence): AntiBotVerdict {
  const isBot = /"isBot"\s*:\s*(true|false)/.exec(evidence.text)?.[1];
  if (!isBot) return verdict('unknown', 'no isBot verdict displayed: the detection script did not complete in this browser');
  const signals = [...evidence.text.matchAll(/"(\w+)"\s*:\s*true/g)].map((m) => m[1]).filter((name) => name !== 'isBot');
  if (isBot === 'false') return verdict('passed', 'isBot: false');
  return verdict('detected', signals.length ? `isBot: true (${signals.join(', ')})` : 'isBot: true');
}

/** CreepJS renders three ratings: "headless" and "stealth" (lies/patches) must both be 0%. */
function evaluateCreepJs(_rule: AntiBotRule, evidence: PageEvidence): AntiBotVerdict {
  const rating = (name: string) => {
    const value = new RegExp(`class="${name}-rating">\\s*(\\d+)%`).exec(evidence.html)?.[1];
    return value === undefined ? undefined : Number(value);
  };
  const headless = rating('headless');
  const likeHeadless = rating('like-headless');
  const stealth = rating('stealth');
  if (headless === undefined || stealth === undefined) return verdict('unknown', 'ratings never rendered: the fingerprinting script did not complete in this browser');
  const detail = `headless ${headless}%, like-headless ${likeHeadless ?? '?'}%, stealth ${stealth}%`;
  return verdict(headless === 0 && stealth === 0 ? 'passed' : 'detected', detail);
}

function evaluateGeneric(rule: AntiBotRule, evidence: PageEvidence): AntiBotVerdict {
  if (evidence.httpStatus !== undefined && evidence.httpStatus >= 400) {
    return verdict('blocked', `HTTP ${evidence.httpStatus}`);
  }
  const textVerdict = applyTextRules(rule, evidence);
  if (textVerdict) return textVerdict;
  if (rule.detectedPattern) {
    const hit = new RegExp(rule.detectedPattern, 'i').exec(evidence.text);
    if (hit) return verdict('detected', `matched "${hit[0]}"`);
  }
  if (rule.passedPattern) {
    const hit = new RegExp(rule.passedPattern, 'i').exec(evidence.text);
    return hit ? verdict('passed', `matched "${hit[0]}"`) : verdict('unknown', 'no verdict displayed: the detection script did not complete in this browser');
  }
  return verdict('passed', 'page served');
}

const EVALUATORS: Record<AntiBotEvaluatorName, (rule: AntiBotRule, evidence: PageEvidence) => AntiBotVerdict> = {
  cloudflare: evaluateCloudflare,
  sannysoft: evaluateSannysoft,
  deviceandbrowserinfo: evaluateDeviceAndBrowserInfo,
  creepjs: evaluateCreepJs,
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
