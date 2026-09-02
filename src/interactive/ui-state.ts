import type {
  DataSourceRecord,
  SourceEvidenceSnapshot,
} from '../sources.js';
import { createSourceEvidenceSnapshot } from '../sources.js';
import type { SebIconMode, SebThemeName } from './theme.js';

const MAX_RECORDED_ANSWER_EVIDENCE = 50;

export interface InteractiveModelState {
  model: string;
  provider: string;
  providerLabel: string;
}

export class InteractiveUiState {
  private readonly evidenceByAnswerId = new Map<string, SourceEvidenceSnapshot>();

  iconMode: SebIconMode = 'unicode';
  activeModel: InteractiveModelState | null = null;
  latestAnswer = '';
  latestAnswerId = '';
  latestPrompt = '';
  notification = '';
  recentCommands: string[] = [];
  showSuggestions = true;
  sources: DataSourceRecord[] = [];
  suggestions: string[] = [];
  theme: SebThemeName = 'default';

  setActiveModel(model: InteractiveModelState): void {
    this.activeModel = {
      model: model.model.trim(),
      provider: model.provider.trim(),
      providerLabel: model.providerLabel.trim(),
    };
  }

  recordAnswerEvidence(snapshot: SourceEvidenceSnapshot): void {
    const capturedAt = new Date(snapshot.capturedAt);
    const boundedSnapshot = createSourceEvidenceSnapshot(
      snapshot.answerId,
      snapshot.sources,
      Number.isFinite(capturedAt.getTime()) ? capturedAt : new Date(),
    );
    this.evidenceByAnswerId.delete(boundedSnapshot.answerId);
    this.evidenceByAnswerId.set(boundedSnapshot.answerId, boundedSnapshot);
    while (this.evidenceByAnswerId.size > MAX_RECORDED_ANSWER_EVIDENCE) {
      const oldestAnswerId = this.evidenceByAnswerId.keys().next().value;
      if (typeof oldestAnswerId !== 'string') break;
      this.evidenceByAnswerId.delete(oldestAnswerId);
    }
    this.latestAnswerId = boundedSnapshot.answerId;
    this.sources = boundedSnapshot.sources.map((source) => ({
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
