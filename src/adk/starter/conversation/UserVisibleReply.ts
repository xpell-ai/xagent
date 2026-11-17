/** A reserved planning header is not a final-answer delimiter. Reject the whole
 * assistant reply; never guess where planning ends or strip a user's words. */
export function hasPlanningEnvelope(text: string): boolean {
  return /^\s*(?:(?:\*\*)?(?:THINK|THOUGHT)(?:\*\*)?\s*:?\s*(?:\r?\n|$)|<think(?:ing)?>)/u.test(text);
}

export const WITHHELD_ASSISTANT_REPLY = "[Assistant reply withheld: internal planning was detected.]";
export function displayedAssistantReply(text: string): string {
  return hasPlanningEnvelope(text) ? WITHHELD_ASSISTANT_REPLY : text;
}
