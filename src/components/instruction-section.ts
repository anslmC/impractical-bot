export function appendOrReplaceInstructionSection(
  systemInstruction: string,
  instruction: string,
  marker: string,
): string {
  const sections = systemInstruction.split(/\n{2,}/u);
  const index = sections.findIndex(section =>
    section.trimStart().startsWith(marker)
  );
  if (index >= 0) {
    sections[index] = instruction;
    return sections.join('\n\n');
  }
  return [systemInstruction.trim(), instruction].filter(Boolean).join('\n\n');
}
