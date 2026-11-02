const MAX_ALIASES = 5;
const HANDLE_SEPARATORS = ['', '_'];
const MIN_SHORT_NAME_LENGTH = 3;

export interface AliasGenerationResult {
  base: string[];
  handleVariations: string[];
  valids: string[];
}

function normalizeName(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function generateHandleVariations(name: string): string[] {
  const tokens = normalizeName(name).split(' ').filter(Boolean);
  if (tokens.length === 0) {
    return [];
  }

  const variations: string[] = [];
  for (const separator of HANDLE_SEPARATORS) {
    const candidate = `@${tokens.join(separator)}`;
    if (!variations.includes(candidate)) {
      variations.push(candidate);
    }
  }
  return variations;
}

function generateShortNameVariations(name: string): string[] {
  const tokens = normalizeName(name).split(' ').filter(Boolean);
  if (tokens.length < 2 || tokens[0].length < MIN_SHORT_NAME_LENGTH) {
    return [];
  }
  return [`@${tokens[0]}`];
}

export function generateAliases(baseName: string): AliasGenerationResult {
  const base = [`@${baseName}`];
  const shortNameVariations = generateShortNameVariations(baseName);
  const handleVariations = generateHandleVariations(baseName);
  const valids = [
    ...new Set([...base, ...shortNameVariations, ...handleVariations]),
  ].slice(0, MAX_ALIASES);

  return { base, handleVariations, valids };
}
