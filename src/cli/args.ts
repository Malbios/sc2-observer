export function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token?.startsWith("--")) {
      // A flag followed by another flag is a switch with no value.
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        args[token.slice(2)] = "";
      } else {
        args[token.slice(2)] = next;
        i++;
      }
    }
  }
  return args;
}
