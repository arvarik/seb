import { emitKeypressEvents } from 'node:readline';
import { createInterface } from 'node:readline/promises';

export interface SetupPromptChoice<T extends string = string> {
  description?: string;
  label: string;
  value: T;
}

export interface SetupTextPromptOptions {
  defaultValue?: string;
  required?: boolean;
  secret?: boolean;
}

export interface SetupPrompt {
  confirm(message: string, defaultValue?: boolean): Promise<boolean>;
  select<T extends string>(
    message: string,
    choices: readonly SetupPromptChoice<T>[],
    defaultValue?: T,
  ): Promise<T>;
  text(message: string, options?: SetupTextPromptOptions): Promise<string>;
}

export class TerminalSetupPrompt implements SetupPrompt {
  constructor(
    private readonly input: NodeJS.ReadStream = process.stdin,
    private readonly output: NodeJS.WriteStream = process.stdout,
  ) {}

  async confirm(message: string, defaultValue = true): Promise<boolean> {
    const suffix = defaultValue ? '[Y/n]' : '[y/N]';
    while (true) {
      const answer = (await this.text(`${message} ${suffix}`)).toLowerCase();
      if (!answer) return defaultValue;
      if (answer === 'y' || answer === 'yes') return true;
      if (answer === 'n' || answer === 'no') return false;
      this.output.write('Enter yes or no.\n');
    }
  }

  async select<T extends string>(
    message: string,
    choices: readonly SetupPromptChoice<T>[],
    defaultValue?: T,
  ): Promise<T> {
    if (choices.length === 0) {
      throw new Error('The setup prompt needs at least one choice.');
    }
    this.output.write(`${message}\n`);
    choices.forEach((choice, index) => {
      const detail = choice.description ? `: ${choice.description}` : '';
      const selected = choice.value === defaultValue ? ' (current)' : '';
      this.output.write(`  ${index + 1}. ${choice.label}${selected}${detail}\n`);
    });
    const defaultIndex = defaultValue
      ? choices.findIndex((choice) => choice.value === defaultValue)
      : -1;
    while (true) {
      const answer = await this.text('Select a number', {
        ...(defaultIndex >= 0 ? { defaultValue: String(defaultIndex + 1) } : {}),
        required: true,
      });
      const index = Number(answer) - 1;
      const selected = choices[index];
      if (selected) return selected.value;
      this.output.write(`Enter a number from 1 through ${choices.length}.\n`);
    }
  }

  async text(
    message: string,
    options: SetupTextPromptOptions = {},
  ): Promise<string> {
    while (true) {
      const answer = options.secret
        ? await this.readSecret(message, options.defaultValue !== undefined)
        : await this.readLine(message, options.defaultValue);
      const normalized = answer.trim() || options.defaultValue?.trim() || '';
      if (normalized || !options.required) return normalized;
      this.output.write('This value is required.\n');
    }
  }

  private async readLine(
    message: string,
    defaultValue?: string,
  ): Promise<string> {
    const suffix = defaultValue ? ` [${defaultValue}]` : '';
    const readline = createInterface({
      input: this.input,
      output: this.output,
      terminal: true,
    });
    try {
      return await readline.question(`${message}${suffix}: `);
    } finally {
      readline.close();
    }
  }

  private async readSecret(message: string, hasSavedValue: boolean): Promise<string> {
    if (this.input.isTTY !== true || typeof this.input.setRawMode !== 'function') {
      throw new Error('The private key prompt needs an interactive terminal.');
    }
    const suffix = hasSavedValue ? ' [press Enter to keep the saved key]' : '';
    this.output.write(`${message}${suffix}: `);
    emitKeypressEvents(this.input);
    const wasRaw = this.input.isRaw === true;
    this.input.setRawMode(true);
    this.input.resume();

    return await new Promise<string>((resolve, reject) => {
      let value = '';
      const finish = (error?: Error): void => {
        this.input.off('keypress', onKeypress);
        this.input.setRawMode?.(wasRaw);
        this.output.write('\n');
        if (error) reject(error);
        else resolve(value);
      };
      const onKeypress = (
        text: string,
        key: { ctrl?: boolean; meta?: boolean; name?: string },
      ): void => {
        if (key.ctrl && key.name === 'c') {
          finish(new Error('Setup stopped.'));
          return;
        }
        if (key.name === 'return' || key.name === 'enter') {
          finish();
          return;
        }
        if (key.name === 'backspace') {
          const characters = [...value];
          if (characters.length > 0) {
            characters.pop();
            value = characters.join('');
            this.output.write('\b \b');
          }
          return;
        }
        if (key.ctrl || key.meta || !text || /[\u0000-\u001F\u007F]/u.test(text)) {
          return;
        }
        value += text;
        this.output.write('*'.repeat([...text].length));
      };
      this.input.on('keypress', onKeypress);
    });
  }
}
