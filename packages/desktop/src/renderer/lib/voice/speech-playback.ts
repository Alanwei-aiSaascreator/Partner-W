export function speechBillingUnits(text: string): number {
  return Array.from(text.trim()).reduce((total, char) => total + (/\p{Script=Han}/u.test(char) ? 2 : 1), 0);
}

export function splitSpeechText(text: string, maxCharacters = 600): string[] {
  const characters = Array.from(text.trim());
  if (characters.length > 6000) throw new Error('voice-answer-too-long');
  const chunks: string[] = [];
  while (characters.length > 0) {
    const candidate = characters.slice(0, maxCharacters).join('');
    const sentenceEnd = Math.max(
      candidate.lastIndexOf('。'),
      candidate.lastIndexOf('！'),
      candidate.lastIndexOf('？'),
      candidate.lastIndexOf('\n'),
      candidate.lastIndexOf('. '),
    );
    const length =
      characters.length > maxCharacters && sentenceEnd > maxCharacters / 2
        ? Array.from(candidate.slice(0, sentenceEnd + 1)).length
        : Math.min(maxCharacters, characters.length);
    chunks.push(characters.splice(0, length).join(''));
  }
  return chunks;
}
interface SpeechDependencies {
  speak: (text: string) => Promise<ArrayBuffer>;
  play: (audio: ArrayBuffer) => Promise<void>;
  cancel: () => void;
}
export function createSpeechPlayback(deps: SpeechDependencies) {
  let epoch = 0;
  const stop = () => {
    epoch++;
    deps.cancel();
  };
  return {
    stop,
    async start(text: string): Promise<void> {
      stop();
      const current = epoch;
      const chunks = splitSpeechText(text);
      for (const chunk of chunks) {
        if (current !== epoch) return;
        const audio = await deps.speak(chunk);
        if (current !== epoch) return;
        await deps.play(audio);
      }
    },
  };
}
