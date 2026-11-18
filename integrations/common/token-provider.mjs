import { readFile as defaultReadFile } from "node:fs/promises";
import { homedir as defaultHomedir } from "node:os";

// "~/" at the start of a token file path resolves to the user home
// directory (node does not expand it; the home injection point stays a
// parameter so tests can pin the resolved path). Windows home is
// "C:\\Users\\<user>", so expansion is cross-platform.
function resolveTokenPath(path, homedir) {
  if (path.startsWith("~/")) return `${homedir()}/${path.slice(2)}`;
  return path;
}

export class TokenConfigurationError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "TokenConfigurationError";
  }
}

export function createTokenProvider({
  token,
  tokenFile,
  readFile = defaultReadFile,
  homedir = defaultHomedir,
} = {}) {
  const direct = typeof token === "string" ? token.trim() : "";
  if (direct) return async () => direct;
  if (!tokenFile) return async () => null;

  return async () => {
    let contents;
    try {
      contents = await readFile(resolveTokenPath(tokenFile, homedir), "utf8");
    } catch (error) {
      throw new TokenConfigurationError("configured token file could not be read", { cause: error });
    }
    const resolved = String(contents).trim();
    if (!resolved) throw new TokenConfigurationError("configured token file is empty");
    return resolved;
  };
}
