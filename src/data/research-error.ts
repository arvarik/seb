/** An expected data limitation with a user-safe explanation. */
export class ResearchDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResearchDataError';
  }
}
