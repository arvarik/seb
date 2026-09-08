type EscapeState = 'text' | 'escape' | 'intermediate' | 'csi' | 'string' | 'string-escape';

/** Removes terminal commands from untrusted text, including commands split across chunks. */
export class TerminalTextSanitizer {
  private state: EscapeState = 'text';

  push(chunk: string): string {
    let output = '';
    for (const character of chunk) {
      const code = character.codePointAt(0)!;
      if (this.state === 'string' || this.state === 'string-escape') {
        if (code === 0x07 || code === 0x9c || (this.state === 'string-escape' && character === '\\')) {
          this.state = 'text';
        } else this.state = code === 0x1b ? 'string-escape' : 'string';
        continue;
      }
      if (code === 0x1b) { this.state = 'escape'; continue; }
      if (code === 0x9b) { this.state = 'csi'; continue; }
      if ([0x90, 0x98, 0x9d, 0x9e, 0x9f].includes(code)) { this.state = 'string'; continue; }
      if (this.state === 'escape') {
        if (character === '[') this.state = 'csi';
        else if (']PX^_'.includes(character)) this.state = 'string';
        else this.state = code >= 0x20 && code <= 0x2f ? 'intermediate' : 'text';
        continue;
      }
      if (this.state === 'intermediate') {
        if (code >= 0x30 && code <= 0x7e) this.state = 'text';
        continue;
      }
      if (this.state === 'csi') {
        if (code >= 0x40 && code <= 0x7e) this.state = 'text';
        continue;
      }
      if (character === '\n') output += character;
      else if (character === '\t') output += '    ';
      else if (code >= 0x20 && !(code >= 0x7f && code <= 0x9f)) output += character;
    }
    return output;
  }
}

export function sanitizeTerminalText(value: string): string {
  return new TerminalTextSanitizer().push(value);
}
