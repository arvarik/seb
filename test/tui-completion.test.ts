import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import { createSessionState } from '../src/interactive/session.js';
import {
  renderPaletteOverlay,
  SlashCommandInput,
  SlashCommandPalette,
} from '../src/interactive/tui.js';

describe('interactive slash command palette', () => {
  it('shows fuzzy command matches and contextual argument values', () => {
    const session = createSessionState(new Date('2026-08-20T12:00:00Z'));
    session.team = 'SEA';
    session.user = 'arvarik';
    session.leagueId = '123456789';
    const palette = new SlashCommandPalette(session);

    palette.setInput('/te');
    expect(palette.rows(8).map((row) => row.value)).toContain('/team');

    palette.setInput('/team ');
    expect(palette.rows(8)[0]?.value).toBe('/team SEA');

    palette.setInput('/leagues ');
    expect(palette.rows(8)[0]?.value).toBe('/leagues arvarik');

    palette.setInput('/rosters ');
    expect(palette.rows(8)[0]?.value).toBe('/rosters 123456789');
  });

  it('renders a selected command and keyboard instructions', () => {
    const palette = new SlashCommandPalette(createSessionState());
    palette.setInput('/ref');

    const overlay = renderPaletteOverlay(palette, 100, 24);

    expect(overlay).toContain('❯ /refresh');
    expect(overlay).toContain('Tab/→ fill');
  });

  it('fills the selected command with Tab before submission', () => {
    const source = new FakeInput();
    const repaintPalette = vi.fn();
    const palette = new SlashCommandPalette(createSessionState());
    const input = new SlashCommandInput(source, palette, { repaintPalette });
    let renderedInput = '';
    input.on('data', (chunk) => {
      const value = chunk.toString('utf8');
      if (value === '\u007f') {
        renderedInput = renderedInput.slice(0, -1);
      } else if (value >= ' ') {
        renderedInput += value;
      }
    });

    source.type('/he\t');

    expect(renderedInput).toBe('/help');
    expect(palette.value()).toBe('/help');
  });

  it('uses arrows for the menu and Escape only closes the menu', () => {
    const source = new FakeInput();
    const repaintPalette = vi.fn();
    const palette = new SlashCommandPalette(createSessionState());
    const input = new SlashCommandInput(source, palette, { repaintPalette });
    const forwarded: string[] = [];
    input.on('data', (chunk) => forwarded.push(chunk.toString('utf8')));

    source.type('/');
    const first = palette.accept();
    source.type('\x1b[B');
    const second = palette.accept();
    source.type('\x1b');

    expect(second).not.toBe(first);
    expect(repaintPalette).toHaveBeenCalledOnce();
    expect(palette.isActive()).toBe(false);
    expect(forwarded).not.toContain('\x1b');
    expect(forwarded).toContain('\u000c');
  });
});

class FakeInput extends EventEmitter {
  isTTY = true;

  pause(): this {
    return this;
  }

  resume(): this {
    return this;
  }

  setRawMode(): this {
    return this;
  }

  type(value: string): void {
    this.emit('data', Buffer.from(value));
  }
}
