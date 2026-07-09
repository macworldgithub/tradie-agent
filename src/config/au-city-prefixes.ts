export const AU_CITY_PREFIXES = [
  { state: "ACT", city: "Canberra",       code: "canberra",       prefix: "+61251"  },
  { state: "NSW", city: "Sydney",         code: "sydney",         prefix: "+61272"  },
  { state: "NSW", city: "Newcastle",      code: "newcastle",      prefix: "+61240"  },
  { state: "NSW", city: "Gosford",        code: "gosford",        prefix: "+61243"  },
  { state: "NSW", city: "Nowra",          code: "nowra",          prefix: "+61244"  },
  { state: "NSW", city: "Campbelltown",   code: "campbelltown",   prefix: "+61246"  },
  { state: "NSW", city: "Penrith",        code: "penrith",        prefix: "+61247"  },
  { state: "NSW", city: "Taree",          code: "taree",          prefix: "+61255"  },
  { state: "NSW", city: "Coffs Harbour",  code: "coffs-harbour",  prefix: "+612563" },
  { state: "NSW", city: "Albury",         code: "albury",         prefix: "+61260"  },
  
  { state: "QLD", city: "Brisbane",       code: "brisbane",       prefix: "+61735"  },
  { state: "QLD", city: "Cairns",         code: "cairns",         prefix: "+61742"  },
  { state: "QLD", city: "Townsville",     code: "townsville",     prefix: "+61744"  },
  { state: "QLD", city: "Toowoomba",      code: "toowoomba",      prefix: "+61745"  },
  { state: "QLD", city: "Rockhampton",    code: "rockhampton",    prefix: "+617488" },
  { state: "QLD", city: "Maryborough",    code: "maryborough",    prefix: "+61741"  },
  { state: "QLD", city: "Southport",      code: "southport",      prefix: "+617566" },
  { state: "QLD", city: "Beaudesert",     code: "beaudesert",     prefix: "+617567" },
  
  { state: "VIC", city: "Melbourne",      code: "melbourne",      prefix: "+61370"  },
  { state: "VIC", city: "Geelong",        code: "geelong",        prefix: "+61342"  },
  
  { state: "SA",  city: "Adelaide",       code: "adelaide",       prefix: "+61883"  },
  
  { state: "WA",  city: "Perth",          code: "perth",          prefix: "+61894"  },
  { state: "WA",  city: "Bunbury",        code: "bunbury",        prefix: "+61897"  },
  { state: "WA",  city: "Pinjarra",       code: "pinjarra",       prefix: "+618952" },
  
  { state: "TAS", city: "Hobart",         code: "hobart",         prefix: "+61361"  },
  { state: "TAS", city: "Launceston",     code: "launceston",     prefix: "+61367"  },
  
  { state: "NT",  city: "Darwin",         code: "darwin",         prefix: "+61879"  },
] as const;

export class InvalidCityError extends Error {
  constructor(code: string) {
    super(`Invalid city code: ${code}`);
    this.name = 'InvalidCityError';
  }
}

export class NoNumbersAvailableError extends Error {
  constructor(code: string) {
    super(`No numbers available for city code: ${code}`);
    this.name = 'NoNumbersAvailableError';
  }
}

export function getPrefixForCity(input: string): string {
  const normalizedInput = input.toLowerCase().trim();
  const city = AU_CITY_PREFIXES.find(
    (c) => c.code === normalizedInput || c.city.toLowerCase() === normalizedInput
  );
  if (!city) {
    throw new InvalidCityError(input);
  }
  return city.prefix;
}

export function getCityNameForCode(input: string): string {
  const normalizedInput = input.toLowerCase().trim();
  const city = AU_CITY_PREFIXES.find(
    (c) => c.code === normalizedInput || c.city.toLowerCase() === normalizedInput
  );
  if (!city) {
    throw new InvalidCityError(input);
  }
  return city.city;
}

export function listCities() {
  const grouped = AU_CITY_PREFIXES.reduce((acc, curr) => {
    if (!acc[curr.state]) {
      acc[curr.state] = [];
    }
    acc[curr.state].push({ code: curr.code, name: curr.city });
    return acc;
  }, {} as Record<string, { code: string; name: string }[]>);

  // Define the preferred order of states (as specified)
  const stateOrder = ['ACT', 'NSW', 'QLD', 'VIC', 'SA', 'WA', 'TAS', 'NT'];

  return stateOrder.map(state => ({
    state,
    cities: grouped[state] || []
  }));
}
