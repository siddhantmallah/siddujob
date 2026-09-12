export type RawJob = {
  source: string;
  externalId: string;
  url: string;
  applyUrl?: string | null;
  title: string;
  company: string;
  location: string;
  /** ISO-3166 alpha-2, lowercase. "" when unknown. */
  country: string;
  description: string;
  salaryMin?: number | null;
  salaryMax?: number | null;
  currency?: string | null;
  postedAt?: Date | null;
  remote?: boolean;
  atsType?: string | null;
  atsToken?: string | null;
};

export type SourceContext = {
  /** Search terms derived from your target titles. */
  queries: string[];
  /** ISO-2 countries you want to work in. */
  countries: string[];
  /** Per-query result ceiling, to stay inside free API quotas. */
  maxPerQuery: number;
  /** Boards discovered from the sponsor register, merged with the env lists. */
  discoveredBoards?: { greenhouse: string[]; lever: string[]; ashby: string[] };
};

export type JobSource = {
  name: string;
  /** Covers the countries this source can actually serve. */
  regions: string[] | "all";
  enabled: () => boolean;
  fetch: (ctx: SourceContext) => Promise<RawJob[]>;
};

const COUNTRY_HINTS: Array<[RegExp, string]> = [
  [/\b(united kingdom|uk|england|scotland|wales|northern ireland|london|manchester|birmingham|leeds|glasgow|edinburgh|bristol|liverpool|sheffield|cardiff|belfast|reading|cambridge|oxford|newcastle|nottingham|milton keynes|slough|croydon)\b/i, "gb"],
  [/\b(ireland|dublin|cork|galway|limerick)\b/i, "ie"],
  [/\b(germany|deutschland|berlin|munich|münchen|hamburg|frankfurt|cologne|köln|stuttgart|düsseldorf|leipzig)\b/i, "de"],
  [/\b(netherlands|holland|amsterdam|rotterdam|utrecht|eindhoven|the hague|den haag)\b/i, "nl"],
  [/\b(france|paris|lyon|toulouse|marseille|bordeaux|lille|nantes)\b/i, "fr"],
  [/\b(spain|españa|madrid|barcelona|valencia|seville|malaga|málaga)\b/i, "es"],
  [/\b(poland|polska|warsaw|warszawa|krakow|kraków|wroclaw|wrocław|gdansk|gdańsk|poznan|poznań)\b/i, "pl"],
  [/\b(portugal|lisbon|lisboa|porto|braga)\b/i, "pt"],
  [/\b(italy|italia|milan|milano|rome|roma|turin|torino|bologna)\b/i, "it"],
  [/\b(sweden|sverige|stockholm|gothenburg|göteborg|malmö|malmo)\b/i, "se"],
  [/\b(denmark|danmark|copenhagen|københavn|aarhus)\b/i, "dk"],
  [/\b(belgium|belgië|brussels|bruxelles|antwerp|antwerpen|ghent|gent)\b/i, "be"],
  [/\b(austria|österreich|vienna|wien|graz|linz|salzburg)\b/i, "at"],
  [/\b(czechia|czech republic|prague|praha|brno)\b/i, "cz"],
  [/\b(finland|suomi|helsinki|espoo|tampere)\b/i, "fi"],
  [/\b(luxembourg)\b/i, "lu"],
  [/\b(switzerland|schweiz|zurich|zürich|geneva|basel|bern)\b/i, "ch"],
  [/\b(norway|norge|oslo|bergen)\b/i, "no"],
  [/\b(romania|bucharest|bucuresti|cluj)\b/i, "ro"],
  [/\b(hungary|budapest)\b/i, "hu"],
  [/\b(greece|athens|thessaloniki)\b/i, "gr"],
  [/\b(estonia|tallinn)\b/i, "ee"],
  [/\b(lithuania|vilnius)\b/i, "lt"],
  [/\b(latvia|riga)\b/i, "lv"],
  [/\b(bulgaria|sofia)\b/i, "bg"],
  [/\b(croatia|zagreb)\b/i, "hr"],
  [/\b(slovakia|bratislava)\b/i, "sk"],
  [/\b(slovenia|ljubljana)\b/i, "si"],
  [/\b(united states|usa|u\.s\.|new york|san francisco|austin, tx|remote - us)\b/i, "us"],
  [/\b(canada|toronto|vancouver|montreal)\b/i, "ca"],
  [/\b(india|bangalore|bengaluru|mumbai|delhi|hyderabad|pune|chennai)\b/i, "in"],
];

/** Best-effort country from a free-text location string. "" when unclear. */
export function guessCountry(location: string, fallback = ""): string {
  if (!location) return fallback;
  for (const [re, code] of COUNTRY_HINTS) {
    if (re.test(location)) return code;
  }
  return fallback;
}

/** Currency a country's salaries are almost certainly quoted in. */
export function currencyFor(country: string): string {
  const c = country.toLowerCase();
  if (c === "gb") return "GBP";
  if (c === "us") return "USD";
  if (c === "ch") return "CHF";
  if (c === "se") return "SEK";
  if (c === "dk") return "DKK";
  if (c === "no") return "NOK";
  if (c === "pl") return "PLN";
  if (c === "cz") return "CZK";
  if (c === "hu") return "HUF";
  if (c === "ro") return "RON";
  if (c === "ca") return "CAD";
  if (c === "in") return "INR";
  return "EUR";
}
