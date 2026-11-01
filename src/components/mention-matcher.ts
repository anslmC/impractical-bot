export interface MentionIdentity {
  name?: string;
  aliases?: readonly string[];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function mentionForms({ name = '', aliases = [] }: MentionIdentity): string[] {
  const forms = new Set<string>();
  const add = (value: string): void => {
    const normalized = value.trim().replace(/\s+/gu, ' ');
    const bare = normalized.replace(/^@+/u, '').trim();
    if (!bare) {
      return;
    }
    forms.add(bare);
    forms.add(`@${bare}`);
  };

  add(name);
  for (const alias of aliases) {
    add(alias);
  }
  return [...forms].sort((left, right) => right.length - left.length);
}

export function createMentionMatcher(
  identity: MentionIdentity,
): (message: string) => boolean {
  const patterns = mentionForms(identity).map(form => {
    const body = form.split(' ')
      .map(part => escapeRegExp(part))
      .join('\\s+');
    const leadingBoundary = form.startsWith('@')
      ? ''
      : '(?<![\\p{L}\\p{N}_])';
    return `${leadingBoundary}${body}(?![\\p{L}\\p{N}_])`;
  });
  if (patterns.length === 0) {
    return () => false;
  }
  const matcher = new RegExp(patterns.join('|'), 'iu');
  return message => matcher.test(message);
}
