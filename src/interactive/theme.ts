export type SebThemeName = 'default' | 'high-contrast' | 'compact';
export type SebIconMode = 'unicode' | 'ascii';

export interface SebTheme {
  color: boolean;
  compact: boolean;
  iconMode: SebIconMode;
  links: boolean;
  name: SebThemeName;
  palette: {
    accent: string;
    assistant: string;
    danger: string;
    dim: string;
    source: string;
    success: string;
    tool: string;
    warning: string;
  };
}

export interface ThemePreferences {
  iconMode: SebIconMode;
  name: SebThemeName;
}

const RESET = '\x1b[0m';

export function createTheme(
  environment: NodeJS.ProcessEnv,
  preferences?: Partial<ThemePreferences>,
): SebTheme {
  const requestedName = preferences?.name ?? parseThemeName(environment.SEB_THEME);
  const iconMode = preferences?.iconMode ?? parseIconMode(environment.SEB_ICONS);
  const color = environment.NO_COLOR === undefined && environment.TERM !== 'dumb';
  const contrast = requestedName === 'high-contrast';
  return {
    color,
    compact: requestedName === 'compact',
    iconMode,
    links: environment.TERM !== 'dumb',
    name: requestedName,
    palette: {
      accent: color ? (contrast ? '\x1b[97;44m' : '\x1b[96m') : '',
      assistant: color ? (contrast ? '\x1b[97m' : '\x1b[92m') : '',
      danger: color ? '\x1b[91m' : '',
      dim: color ? (contrast ? '\x1b[37m' : '\x1b[2m') : '',
      source: color ? '\x1b[94m' : '',
      success: color ? '\x1b[92m' : '',
      tool: color ? '\x1b[95m' : '',
      warning: color ? '\x1b[93m' : '',
    },
  };
}

export function paint(theme: SebTheme, color: keyof SebTheme['palette'], value: string): string {
  const prefix = theme.palette[color];
  return prefix ? `${prefix}${value}${RESET}` : value;
}

export function symbol(
  theme: SebTheme,
  name: 'active' | 'assistant' | 'bullet' | 'danger' | 'done' | 'prompt' | 'source',
): string {
  const unicode = {
    active: '◌',
    assistant: '◆',
    bullet: '•',
    danger: '▲',
    done: '✓',
    prompt: '❯',
    source: '↗',
  } as const;
  const ascii = {
    active: '*',
    assistant: '#',
    bullet: '-',
    danger: '!',
    done: '+',
    prompt: '>',
    source: '^',
  } as const;
  return (theme.iconMode === 'unicode' ? unicode : ascii)[name];
}

export function parseThemeName(value: string | undefined): SebThemeName {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'contrast' || normalized === 'high-contrast') return 'high-contrast';
  if (normalized === 'compact') return normalized;
  return 'default';
}

export function parseIconMode(value: string | undefined): SebIconMode {
  return value?.trim().toLowerCase() === 'ascii' ? 'ascii' : 'unicode';
}
