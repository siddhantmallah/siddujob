/**
 * Visa pre-filtering.
 *
 * This is a TIME-SAVING FILTER, not immigration advice. It answers one question:
 * "is it even possible for this employer to hire me?" so you stop spending
 * evenings on roles that were never reachable. Always confirm on the job ad or
 * with the employer before treating an answer as final.
 *
 * Thresholds below are a snapshot — see THRESHOLD_SNAPSHOT_DATE. They are plain
 * data so you can edit them in one place when the rules move.
 */

export const THRESHOLD_SNAPSHOT_DATE = "2025-04";

export type VisaVerdict = {
  /** true = an employer in this country could sponsor this role for you */
  possible: boolean;
  /** 0-1, how confident the check is; low means "read the ad yourself" */
  confidence: number;
  note: string;
  /** Subtracted from the job score when the route looks blocked */
  penalty: number;
};

/* ─────────────────────────── UNITED KINGDOM ─────────────────────────── */

/** Skilled Worker salary floors, GBP per year. */
export const UK_SALARY = {
  general: 38_700,
  newEntrant: 30_960,
  /** Below this, no Skilled Worker route exists regardless of going rate. */
  absoluteFloor: 30_960,
};

/**
 * Two hard gates decide almost every UK rejection for a sponsorship candidate:
 *   1. the employer holds a licence on the Home Office register
 *   2. the salary clears the Skilled Worker floor
 * Everything else (going rates per SOC code, English tests) is downstream.
 */
export function assessUk(input: {
  hasSponsorLicence: boolean;
  sponsorNameMatched: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
  currency: string | null;
  descriptionLower: string;
  isNewEntrant: boolean;
}): VisaVerdict {
  const explicitNo =
    /(no\s+sponsorship|not\s+able\s+to\s+sponsor|cannot\s+sponsor|unable\s+to\s+(offer\s+)?sponsor|without\s+sponsorship|must\s+have\s+(the\s+)?right\s+to\s+work|existing\s+right\s+to\s+work|sponsorship\s+is\s+not\s+(available|offered)|no\s+visa\s+sponsorship)/.test(
      input.descriptionLower,
    );
  const explicitYes =
    /(visa\s+sponsorship\s+(is\s+)?(available|offered|provided)|we\s+(can\s+)?sponsor|sponsorship\s+available|skilled\s+worker\s+visa|tier\s*2\s+sponsor)/.test(
      input.descriptionLower,
    );

  if (explicitNo && !explicitYes) {
    return {
      possible: false,
      confidence: 0.92,
      note: "Ad states sponsorship is not available.",
      penalty: 100,
    };
  }

  const salary = input.salaryMax ?? input.salaryMin;
  const floor = input.isNewEntrant ? UK_SALARY.newEntrant : UK_SALARY.general;
  const currencyOk = !input.currency || input.currency.toUpperCase() === "GBP";

  if (!input.hasSponsorLicence) {
    return {
      possible: false,
      confidence: 0.8,
      note: "Employer is not on the Home Office register of licensed sponsors — they legally cannot sponsor a Skilled Worker visa.",
      penalty: 60,
    };
  }

  if (salary != null && currencyOk && salary < UK_SALARY.absoluteFloor) {
    return {
      possible: false,
      confidence: 0.85,
      note: `Advertised salary (~£${salary.toLocaleString()}) is below the Skilled Worker floor of £${UK_SALARY.absoluteFloor.toLocaleString()}.`,
      penalty: 70,
    };
  }

  if (salary != null && currencyOk && salary < floor) {
    return {
      possible: true,
      confidence: 0.5,
      note: `Licensed sponsor, but ~£${salary.toLocaleString()} is under the £${floor.toLocaleString()} general threshold — only works if you qualify as a new entrant or the role has a lower going rate.`,
      penalty: 18,
    };
  }

  const matched = input.sponsorNameMatched ? ` (matched "${input.sponsorNameMatched}")` : "";
  return {
    possible: true,
    confidence: explicitYes ? 0.95 : 0.75,
    note: explicitYes
      ? `Ad mentions sponsorship and the employer holds a licence${matched}.`
      : `Employer holds a sponsor licence${matched} and salary clears the threshold.`,
    penalty: 0,
  };
}

/* ───────────────────────────── EUROPE ───────────────────────────── */

type EuRule = {
  country: string;
  /** Gross annual EUR (or local, see currency) needed for the main work route */
  threshold: number;
  /** Reduced threshold for shortage occupations / young professionals */
  shortageThreshold?: number;
  currency: string;
  route: string;
  /** True where IT roles routinely qualify under a shortage-occupation carve-out */
  itShortage: boolean;
  note?: string;
};

/**
 * Snapshot of the main employment routes for a non-EU national.
 * IT/infrastructure salaries often sit UNDER these floors — that is real signal,
 * not a bug: it tells you which EU markets are actually open to you.
 */
export const EU_RULES: Record<string, EuRule> = {
  de: {
    country: "Germany",
    threshold: 48_300,
    shortageThreshold: 43_760,
    currency: "EUR",
    route: "EU Blue Card",
    itShortage: true,
    note: "Germany also has an IT-specialist route that can waive the degree requirement for proven experience.",
  },
  nl: {
    country: "Netherlands",
    threshold: 68_256,
    shortageThreshold: 50_052,
    currency: "EUR",
    route: "Highly Skilled Migrant (recognised sponsor required)",
    itShortage: false,
    note: "Employer must be an IND-recognised sponsor. Lower threshold applies if you are under 30.",
  },
  ie: {
    country: "Ireland",
    threshold: 64_000,
    shortageThreshold: 38_000,
    currency: "EUR",
    route: "Critical Skills Employment Permit",
    itShortage: true,
    note: "Most ICT and infrastructure roles sit on the Critical Skills list, which unlocks the lower floor.",
  },
  fr: {
    country: "France",
    threshold: 53_836,
    currency: "EUR",
    route: "EU Blue Card / Passeport Talent",
    itShortage: false,
  },
  es: {
    country: "Spain",
    threshold: 40_077,
    shortageThreshold: 33_908,
    currency: "EUR",
    route: "Highly Qualified Professional",
    itShortage: true,
  },
  pl: {
    country: "Poland",
    threshold: 36_000,
    currency: "EUR",
    route: "EU Blue Card",
    itShortage: true,
  },
  pt: {
    country: "Portugal",
    threshold: 26_000,
    currency: "EUR",
    route: "EU Blue Card / Tech Visa",
    itShortage: true,
  },
  se: {
    country: "Sweden",
    threshold: 34_000,
    currency: "EUR",
    route: "Work Permit (union-benchmarked salary)",
    itShortage: false,
  },
  dk: {
    country: "Denmark",
    threshold: 66_000,
    currency: "EUR",
    route: "Pay Limit Scheme",
    itShortage: false,
  },
  be: {
    country: "Belgium",
    threshold: 49_000,
    currency: "EUR",
    route: "EU Blue Card",
    itShortage: false,
  },
  at: {
    country: "Austria",
    threshold: 50_700,
    currency: "EUR",
    route: "Red-White-Red Card",
    itShortage: true,
  },
  cz: {
    country: "Czechia",
    threshold: 31_000,
    currency: "EUR",
    route: "EU Blue Card",
    itShortage: true,
  },
  it: {
    country: "Italy",
    threshold: 33_500,
    currency: "EUR",
    route: "EU Blue Card (subject to decreto flussi quota)",
    itShortage: false,
  },
  fi: {
    country: "Finland",
    threshold: 42_000,
    currency: "EUR",
    route: "Specialist Residence Permit",
    itShortage: true,
  },
  lu: {
    country: "Luxembourg",
    threshold: 58_968,
    currency: "EUR",
    route: "EU Blue Card",
    itShortage: false,
  },
};

export function assessEu(input: {
  countryCode: string;
  salaryMin: number | null;
  salaryMax: number | null;
  currency: string | null;
  descriptionLower: string;
  isItRole: boolean;
}): VisaVerdict {
  const rule = EU_RULES[input.countryCode.toLowerCase()];
  if (!rule) {
    return {
      possible: true,
      confidence: 0.2,
      note: "No visa rules on file for this country — check the ad yourself.",
      penalty: 5,
    };
  }

  if (/(no\s+(visa\s+)?sponsorship|eu\s+citizens?\s+only|must\s+(already\s+)?have\s+(an?\s+)?(eu|valid)\s+work\s+permit|existing\s+eu\s+work\s+authorisation)/.test(input.descriptionLower)) {
    return {
      possible: false,
      confidence: 0.9,
      note: `${rule.country}: ad requires existing EU work authorisation.`,
      penalty: 100,
    };
  }

  const applicable =
    input.isItRole && rule.itShortage && rule.shortageThreshold
      ? rule.shortageThreshold
      : rule.threshold;

  const salary = input.salaryMax ?? input.salaryMin;
  const currencyOk = !input.currency || input.currency.toUpperCase() === rule.currency;

  if (salary == null) {
    return {
      possible: true,
      confidence: 0.35,
      note: `${rule.country} — ${rule.route}. No salary advertised; needs roughly €${applicable.toLocaleString()}+ to qualify.${rule.note ? " " + rule.note : ""}`,
      penalty: 6,
    };
  }

  if (!currencyOk) {
    return {
      possible: true,
      confidence: 0.25,
      note: `${rule.country} — salary quoted in ${input.currency}, could not compare against the €${applicable.toLocaleString()} floor.`,
      penalty: 5,
    };
  }

  if (salary < applicable * 0.85) {
    return {
      possible: false,
      confidence: 0.8,
      note: `${rule.country}: ~€${salary.toLocaleString()} is well under the €${applicable.toLocaleString()} ${rule.route} floor.`,
      penalty: 65,
    };
  }

  if (salary < applicable) {
    return {
      possible: true,
      confidence: 0.5,
      note: `${rule.country}: ~€${salary.toLocaleString()} is just under the €${applicable.toLocaleString()} floor — worth asking whether the range flexes.`,
      penalty: 20,
    };
  }

  return {
    possible: true,
    confidence: 0.8,
    note: `${rule.country} — ${rule.route}: salary clears the €${applicable.toLocaleString()} threshold.${rule.note ? " " + rule.note : ""}`,
    penalty: 0,
  };
}

/** Rough IT/infrastructure detector, used to pick the shortage-occupation floor. */
export function looksLikeItRole(title: string): boolean {
  return /(it|ict|service ?desk|help ?desk|support|infrastructure|system|sysadmin|network|devops|sre|cloud|platform|server|desktop|technician|engineer|administrator|security|azure|aws|linux|windows)/i.test(
    title,
  );
}
