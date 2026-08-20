import { describe, expect, it } from 'vitest';

import {
  formatElapsed,
  osc52,
  renderAnalysisText,
  sourceBadge,
  stripAnsi,
  terminalLink,
} from '../src/interactive/presentation.js';
import { createTheme } from '../src/interactive/theme.js';

describe('interactive presentation', () => {
  it('renders decision bars and trend charts', () => {
    const theme = createTheme({ NO_COLOR: '1', SEB_ICONS: 'ascii' });
    const output = renderAnalysisText([
      '## Decision',
      'Confidence: 72%',
      'Win probability: 61%',
      'Weekly points: 8, 14, 10, 19',
    ].join('\n'), theme);

    expect(output).toContain('DECISION');
    expect(output).toContain('72% #######---');
    expect(output).toContain('61% ############--------');
    expect(output).toContain('8 -> 14 -> 10 -> 19');
  });

  it('formats source freshness and elapsed time', () => {
    expect(sourceBadge({
      accessedAt: '2026-08-20T12:00:00Z',
      cacheOutcome: 'cache-fresh',
      id: 'nflverse:weekly',
      label: 'nflverse 2025 weekly stats',
      retrievedAt: '2026-08-20T11:56:00Z',
      url: 'https://github.com/nflverse/nflverse-data/releases',
    }, new Date('2026-08-20T12:00:00Z'))).toBe('CACHED 4m');
    expect(sourceBadge({
      accessedAt: '2026-08-20T12:00:00Z',
      id: 'nflverse:weekly',
      label: 'nflverse 2025 weekly stats',
      url: 'https://github.com/nflverse/nflverse-data/releases',
    })).toBe('2025 STATS');
    expect(formatElapsed(1_250)).toBe('1.3s');
  });

  it('creates terminal links and clipboard output', () => {
    const link = terminalLink('NWS', 'https://weather.gov');
    const clipboard = osc52('answer');

    expect(stripAnsi(link)).toBe('NWS');
    expect(clipboard).toContain(Buffer.from('answer').toString('base64'));
  });

  it('keeps links in no-color mode and supports accessible themes', () => {
    const noColor = createTheme({ NO_COLOR: '1' });
    const contrast = createTheme({ SEB_THEME: 'high-contrast' });
    const compact = createTheme({ SEB_THEME: 'compact', TERM: 'dumb' });

    expect(noColor.color).toBe(false);
    expect(noColor.links).toBe(true);
    expect(contrast.name).toBe('high-contrast');
    expect(compact.compact).toBe(true);
    expect(compact.links).toBe(false);
  });
});
