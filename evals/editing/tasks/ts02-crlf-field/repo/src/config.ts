export interface Config {
  host: string;
  port: number;
}

export function parseConfig(raw: Record<string, string>): Config {
  return {
    host: raw.host ?? 'localhost',
    port: Number(raw.port ?? 80),
  };
}
