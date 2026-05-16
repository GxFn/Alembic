import fs from 'node:fs';
import path from 'node:path';
import { redactValue } from './Redaction.js';
import type { CodexSessionTranscriptEvent } from './ScenarioTypes.js';

export class TranscriptWriter {
  readonly events: CodexSessionTranscriptEvent[] = [];
  readonly filePath: string;
  readonly secrets: string[];

  constructor(options: { filePath: string; secrets?: string[] }) {
    this.filePath = options.filePath;
    this.secrets = options.secrets || [];
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, '');
  }

  record(event: CodexSessionTranscriptEvent): void {
    const redacted = redactValue(event, this.secrets);
    this.events.push(redacted);
    fs.appendFileSync(this.filePath, `${JSON.stringify(redacted)}\n`);
  }
}
