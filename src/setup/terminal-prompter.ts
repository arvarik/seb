import { createInterface, type Interface } from 'node:readline/promises';

import type { SetupPrompter, SetupPromptChoice } from './wizard.js';

export interface TerminalPrompterStreams {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
}

export class TerminalSetupPrompter implements SetupPrompter {
  private readonly readline: Interface;
  private readonly output: NodeJS.WritableStream;

  constructor(streams: TerminalPrompterStreams) {
    this.output = streams.output;
    this.readline = createInterface({
      input: streams.input,
      output: streams.output,
      terminal: true,
    });
  }

  async input(request: {
    defaultValue?: string;
    label: string;
    validate?: (value: string) => string | null;
  }): Promise<string> {
    while (true) {
      const suffix = request.defaultValue ? ` [${request.defaultValue}]` : '';
      const answer = (await this.readline.question(`${request.label}${suffix}: `)).trim() ||
        request.defaultValue || '';
      const error = request.validate?.(answer);
      if (!error) return answer;
      this.output.write(`${error}\n`);
    }
  }

  async select<T extends string | number>(request: {
    choices: readonly SetupPromptChoice<T>[];
    label: string;
  }): Promise<T> {
    if (request.choices.length === 0) {
      throw new Error(`The setup selection ${request.label} has no choices.`);
    }
    this.output.write(`\n${request.label}:\n`);
    request.choices.forEach((choice, index) => {
      const detail = choice.description ? `, ${choice.description}` : '';
      this.output.write(`  ${index + 1}. ${choice.label}${detail}\n`);
    });
    while (true) {
      const answer = await this.readline.question(`Select 1-${request.choices.length}: `);
      const index = Number(answer.trim()) - 1;
      const selected = request.choices[index];
      if (selected) return selected.value;
      this.output.write(`Enter a number from 1 through ${request.choices.length}.\n`);
    }
  }

  close(): void {
    this.readline.close();
  }
}
