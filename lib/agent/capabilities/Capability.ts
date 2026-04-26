export class Capability {
  get name(): string {
    throw new Error('Subclass must implement name');
  }

  get promptFragment(): string {
    throw new Error('Subclass must implement promptFragment');
  }

  get tools(): string[] {
    return [];
  }

  buildContext(_context: unknown): string | null {
    return null;
  }

  onBeforeStep(_stepState: unknown) {}

  onAfterStep(_stepResult: unknown) {}
}
