const PLAYER_SUFFIXES = new Set(['ii', 'iii', 'iv', 'v', 'jr', 'sr']);

export function normalizePlayerName(value: string): string {
  const reordered = reorderCommaName(value.trim());
  const words = normalizeWords(reordered).split(' ').filter(Boolean);
  while (words.length > 1 && PLAYER_SUFFIXES.has(words.at(-1) ?? '')) {
    words.pop();
  }
  return words.join(' ');
}

export function normalizeTeamText(value: string): string {
  return normalizeWords(value);
}

export function normalizePosition(value: string | null | undefined): string | null {
  const normalized = value?.trim().toUpperCase();
  return normalized || null;
}

export function sourceIdentityKey(identity: {
  id: string;
  provider: string;
}): string {
  return `${identity.provider.trim().toLowerCase()}:${identity.id.trim()}`;
}

function normalizeWords(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[.'‘’`]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function reorderCommaName(value: string): string {
  const parts = value.split(',').map((part) => part.trim());
  return parts.length === 2 && parts[0] && parts[1]
    ? `${parts[1]} ${parts[0]}`
    : value;
}
