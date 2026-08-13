import { readFileSync } from "node:fs";
import path from "node:path";

export function readEnvFile(filePath) {
  try {
    return Object.fromEntries(
      readFileSync(filePath, "utf8")
        .split(/\r?\n/)
        .map((line) => line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/))
        .filter(Boolean)
        .map((match) => {
          const value = match[2];
          const quoted =
            value.length >= 2 &&
            ((value.startsWith('"') && value.endsWith('"')) ||
              (value.startsWith("'") && value.endsWith("'")));
          return [match[1], quoted ? value.slice(1, -1) : value];
        }),
    );
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
}

export function environmentFrom(directory, processEnvironment = process.env) {
  const fileEnvironment = {
    ...readEnvFile(path.join(directory, ".env")),
    ...readEnvFile(path.join(directory, ".env.local")),
  };
  return (name) => processEnvironment[name] ?? fileEnvironment[name];
}
