/*
 * Echoing user-typed text. Anything a user typed comes back inside a code span, so it shows exactly as
 * typed and can't change the formatting of the rest of the message.
 */

/** Text shown inside an inline code span. A backtick would end the span early, so it's swapped for a look-alike. */
export const code = (text: string) => `\`${text.replace(/`/g, 'ˋ')}\``;
