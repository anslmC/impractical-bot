const MAX_VARIATIONS = 30;
const HANDLE_SEPARATORS = ['', '_', '-', '.'];

export interface AliasGenerationResult {
  base: string[];
  nameShuffle: string[];
  shortenedForms: string[];
  handleVariations: string[];
  valids: string[];
}

function normalizeName(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function splitCamelCase(token: string): string[] {
  return token.replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, '$1 $2').split(/\s+/);
}

function isValidCandidate(candidate: string): boolean {
  const name = candidate.startsWith('@') ? candidate.slice(1) : candidate;
  const components = name.split(/[\s_.-]+/).filter(Boolean);
  const nameParts = components.map(component => component.replace(/[^\p{L}\p{N}]/gu, ''));
  return nameParts.length > 0 && nameParts.every(Boolean) &&
    nameParts.some(component => Array.from(component).length > 1);
}

function getShortenedParts(parts: string[]): string[] {
  const shortened: string[] = [];
  for (const part of parts) {
    const characters = Array.from(part);
    if (characters.length < 6 || !/[bcdfghjklmnpqrstvwxyz]o$/iu.test(part)) {
      continue;
    }

    const prefix = characters.slice(0, -2).join('');
    if (Array.from(prefix).length >= 4) {
      shortened.push(prefix);
    }
  }
  return [...new Set(shortened)];
}

function forEachCombination(
  items: string[],
  size: number,
  callback: (selected: string[]) => boolean,
): boolean {
  function visit(startIndex: number, selected: string[]): boolean {
    if (selected.length === size) {
      return callback(selected);
    }
    if (items.length - startIndex < size - selected.length) {
      return true;
    }

    for (let index = startIndex; index < items.length; index += 1) {
      selected.push(items[index]);
      if (visit(index + 1, selected) === false) {
        return false;
      }
      selected.pop();
    }
    return true;
  }

  return visit(0, []);
}

function forEachPermutation(
  items: string[],
  callback: (selected: string[]) => boolean,
): boolean {
  function visit(selected: string[], remaining: string[]): boolean {
    if (remaining.length === 0) {
      return callback(selected);
    }

    const used = new Set<string>();
    for (let index = 0; index < remaining.length; index += 1) {
      const item = remaining[index];
      if (used.has(item)) {
        continue;
      }
      used.add(item);
      if (visit([...selected, item], remaining.filter((_, itemIndex) => itemIndex !== index)) === false) {
        return false;
      }
    }
    return true;
  }

  return visit([], items);
}

function addUnique(variations: string[], candidate: string): boolean {
  const normalized = normalizeName(candidate);
  if (isValidCandidate(normalized) && !variations.includes(normalized) &&
      variations.length < MAX_VARIATIONS) {
    variations.push(normalized);
  }
  return variations.length < MAX_VARIATIONS;
}

function generateNameShuffle(name: string): string[] {
  const tokens = name.split(' ');
  const variations: string[] = [];

  for (let size = tokens.length; size > 0 && variations.length < MAX_VARIATIONS; size -= 1) {
    forEachCombination(tokens, size, combination =>
      forEachPermutation(combination, arrangement =>
        addUnique(variations, arrangement.join(' '))));
  }

  return variations;
}

function generateShortenedForms(name: string): string[] {
  const originalTokens = name.split(' ');
  const parts = originalTokens.flatMap(splitCamelCase);
  const shortenedParts = getShortenedParts(parts);
  const variations: string[] = [];

  for (let size = originalTokens.length; size > 0 && variations.length < MAX_VARIATIONS; size -= 1) {
    forEachCombination(originalTokens, size, combination =>
      addUnique(variations, combination.join(' ')));
  }

  for (let size = parts.length; size > 0 && variations.length < MAX_VARIATIONS; size -= 1) {
    forEachCombination(parts, size, combination => {
      if (!addUnique(variations, combination.join(' '))) {
        return false;
      }

      const initials = combination.map(part => part.match(/[\p{L}\p{N}]/u)?.[0] ?? '');
      if (!addUnique(variations, initials.join(''))) {
        return false;
      }

      for (let index = 0; index < combination.length; index += 1) {
        const abbreviated = [...combination];
        abbreviated[index] = initials[index];
        if (!addUnique(variations, abbreviated.join(' '))) {
          return false;
        }
      }
      return true;
    });
  }

  for (let size = shortenedParts.length; size > 0 && variations.length < MAX_VARIATIONS; size -= 1) {
    forEachCombination(shortenedParts, size, combination =>
      addUnique(variations, combination.join(' ')));
  }

  return variations;
}

function generateHandleVariations(name: string): string[] {
  const originalTokens = name.split(' ');
  const camelCaseParts = originalTokens.flatMap(splitCamelCase);
  const tokenSets = [originalTokens, camelCaseParts, getShortenedParts(camelCaseParts)]
    .map(parts => parts.map(part => part.replace(/[^\p{L}\p{N}]/gu, '')).filter(Boolean))
    .filter(parts => parts.length > 0);
  const variations: string[] = [];

  for (const tokens of tokenSets) {
    for (let size = tokens.length; size > 0 && variations.length < MAX_VARIATIONS; size -= 1) {
      forEachCombination(tokens, size, combination =>
        forEachPermutation(combination, arrangement => {
          for (const separator of HANDLE_SEPARATORS) {
            if (!addUnique(variations, `@${arrangement.join(separator)}`)) {
              return false;
            }
          }
          return true;
        }));
    }
  }

  return variations;
}

export function generateAliases(baseName: string): AliasGenerationResult {
  const base = [`@${baseName}`];
  const name = normalizeName(baseName);
  const nameShuffle = generateNameShuffle(name);
  const shortenedForms = generateShortenedForms(name);
  const handleVariations = generateHandleVariations(name);
  const valids = [...new Set([
    ...base,
    ...nameShuffle,
    ...shortenedForms,
    ...handleVariations,
  ])];

  return { base, nameShuffle, shortenedForms, handleVariations, valids };
}