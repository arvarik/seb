import type {
  DataSourceRecord,
  SourceEvidenceSnapshot,
} from '../sources.js';
import type { SebIconMode, SebThemeName } from './theme.js';

export class InteractiveUiState {
  private readonly evidenceByAnswerId = new Map<string, SourceEvidenceSnapshot>();

  iconMode: SebIconMode = 'unicode';
  latestAnswer = '';
  latestAnswerId = '';
  latestPrompt = '';
  notification = '';
  recentCommands: string[] = [];
  showSuggestions = true;
  sources: DataSourceRecord[] = [];
  suggestions: string[] = [];
  theme: SebThemeName = 'default';

  recordAnswerEvidence(snapshot: SourceEvidenceSnapshot): void {
    this.evidenceByAnswerId.set(snapshot.answerId, snapshot);
    this.latestAnswerId = snapshot.answerId;
    this.sources = snapshot.sources.map((source) => ({
      ...source,
      ...(source.warnings ? { warnings: [...source.warnings] } : {}),
    }));
  }

  evidenceForAnswer(answerId: string): SourceEvidenceSnapshot | null {
    return this.evidenceByAnswerId.get(answerId) ?? null;
  }

  latestEvidence(): SourceEvidenceSnapshot | null {
    return this.evidenceForAnswer(this.latestAnswerId);
  }

  clearAnswerEvidence(): void {
    this.evidenceByAnswerId.clear();
    this.latestAnswerId = '';
    this.sources = [];
  }

  recordCommand(name: string): void {
    this.recentCommands = [name, ...this.recentCommands.filter((value) => value !== name)].slice(0, 8);
  }
}
