import { readFile as defaultReadFile } from "node:fs/promises";

export class TokenConfigurationError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "TokenConfigurationError";
  }
}

export function createTokenProvider({ token, tokenFile, readFile = defaultReadFile } = {}) {
  const direct = typeof token === "string" ? token.trim() : "";
  if (direct) return async () => direct;
  if (!tokenFile) return async () => null;

  return async () => {
    let contents;
    try {
      contents = await readFile(tokenFile, "utf8");
    } catch (error) {
      throw new TokenConfigurationError("configured token file could not be read", { cause: error });
    }
    const resolved = String(contents).trim();
    if (!resolved) throw new TokenConfigurationError("configured token file is empty");
    return resolved;
  };
}
