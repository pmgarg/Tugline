export function greet(name: string, count: number): string {
  const noun = count === 1 ? 'message' : 'messages';
  return `Hello, "${name}"! You have ${count} new ${noun}.`;
}

export function shout(s: string): string {
  return `${s.toUpperCase()}!`;
}
