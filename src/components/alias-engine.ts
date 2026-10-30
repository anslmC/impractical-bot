const MAX_ALIASES = 5;
const HANDLE_SEPARATORS = ['', '_'];

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

export function generateAliases(baseName: string): AliasGenerationResult {
  const base = [`@${baseName}`];
  const handleVariations = generateHandleVariations(baseName);
  const valids = [...new Set([...base, ...handleVariations])].slice(0, MAX_ALIASES);

  return { base, handleVariations, valids };
}
