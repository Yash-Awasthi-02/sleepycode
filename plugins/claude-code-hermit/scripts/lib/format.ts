function kStr(n: number): string {
  const k = (n || 0) / 1000;
  if (k === 0) return '0';
  return k < 100 ? k.toFixed(1) : String(Math.round(k));
}

function formatTokens(n: number): string {
  return kStr(n) + 'K tokens';
}

export { kStr, formatTokens };
