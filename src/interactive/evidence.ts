export interface EvidenceTextSection {
  content: string;
  evidence: boolean;
}

/** Separates source appendices while preserving the complete text for copying. */
export function splitEvidenceText(text: string): EvidenceTextSection[] {
  const sections: EvidenceTextSection[] = [];
  let evidence = false;
  let fence: { marker: string; length: number } | undefined;
  for (const line of text.split(/(?<=\n)/u)) {
    const trimmed = line.trim();
    const marker = trimmed.match(/^(`{3,}|~{3,})/u)?.[1];
    if (!fence) {
      const heading = trimmed
        .replace(/^#{1,6}\s+|^[━─═-]{2,}\s*/u, '')
        .replace(/\*\*|__/gu, '')
        .replace(/\s+#+$/u, '')
        .trim();
      if (/^(?:evidence|(?:web )?sources)\s*:?$/iu.test(heading) ||
        /^Web sources:/iu.test(heading) ||
        /^Evidence:\s*\d+\s+sources?\s*·\s*\/sources\s*$/iu.test(heading)) {
        evidence = true;
      } else if (/^(?:#{1,6}\s+|[━─═]{2,}\s*|\*\*[^*]+\*\*\s*$)/u.test(trimmed)) {
        evidence = false;
      }
      if (marker) fence = { marker: marker[0]!, length: marker.length };
    } else if (marker?.[0] === fence.marker && marker.length >= fence.length &&
      new RegExp(`^${fence.marker === '`' ? '`' : '~'}+\\s*$`, 'u').test(trimmed)) {
      fence = undefined;
    }
    const last = sections.at(-1);
    if (last?.evidence === evidence) last.content += line;
    else sections.push({ content: line, evidence });
  }
  return sections.filter((section) => section.content.trim());
}
