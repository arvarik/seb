import type { DataSourceRecord } from '../sources.js';
import type { SebIconMode, SebThemeName } from './theme.js';

export class InteractiveUiState {
  iconMode: SebIconMode = 'unicode';
  latestAnswer = '';
  latestPrompt = '';
  notification = '';
  recentCommands: string[] = [];
  showSuggestions = true;
  sources: DataSourceRecord[] = [];
  suggestions: string[] = [];
  theme: SebThemeName = 'default';

  recordCommand(name: string): void {
    this.recentCommands = [name, ...this.recentCommands.filter((value) => value !== name)].slice(0, 8);
  }
}
