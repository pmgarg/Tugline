export interface Config {
  host: string;
  port: number;
  secure: boolean;
}

export function parseConfig(raw: Record<string, string>): Config {
  return {
    host: raw.host ?? 'localhost',
    port: Number(raw.port ?? 80),
    secure: raw.secure === 'true',
  };
}
