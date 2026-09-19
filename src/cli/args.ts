export function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token?.startsWith("--")) {
      args[token.slice(2)] = argv[i + 1] ?? "";
      i++;
    }
  }
  return args;
}
