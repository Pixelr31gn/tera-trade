// Sets (or changes) the dashboard login password -- see core/auth.ts and
// api/routes/auth.ts. Run with `npm run auth:set-password` (backend/).
//
// Deliberately the only thing allowed to write AUTH_PASSWORD_HASH/
// SESSION_SECRET into backend/.env: CLAUDE.md's rule is "never commit or
// modify .env" for the AI assistant specifically, so this exists as the
// human-run tool that does it instead. Only ever stores the scrypt hash,
// never the plaintext password -- same "salt:hash" hex format as
// core/auth.ts's hashPassword/verifyPassword and scripts/exe-setup.cjs
// (the packaged .exe's equivalent of this script); keep all three in sync.
import { randomBytes, scryptSync } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const envPath = path.join(import.meta.dirname, "..", ".env");

const ENTER_CODES = new Set([0x0a, 0x0d]); // \n, \r
const EOF_CODE = 0x04; // Ctrl-D
const INTERRUPT_CODE = 0x03; // Ctrl-C
const BACKSPACE_CODES = new Set([0x7f, 0x08]); // DEL, BS

function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

// No masked-input dependency in this project -- raw-mode stdin is a Node
// builtin, so echo `*` per keystroke by hand instead of adding one just for
// this prompt.
function promptHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(question);
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    let value = "";
    const onData = (char: string) => {
      const code = char.charCodeAt(0);

      if (ENTER_CODES.has(code) || code === EOF_CODE) {
        stdin.setRawMode?.(wasRaw ?? false);
        stdin.pause();
        stdin.removeListener("data", onData);
        process.stdout.write("\n");
        resolve(value);
        return;
      }
      if (code === INTERRUPT_CODE) {
        process.stdout.write("\n");
        process.exit(1);
      }
      if (BACKSPACE_CODES.has(code)) {
        if (value.length > 0) {
          value = value.slice(0, -1);
          process.stdout.write("\b \b");
        }
        return;
      }
      value += char;
      process.stdout.write("*");
    };
    stdin.on("data", onData);
  });
}

function setEnvValue(lines: string[], key: string, value: string): string[] {
  const idx = lines.findIndex((l) => l.startsWith(`${key}=`));
  const line = `${key}=${value}`;
  if (idx >= 0) lines[idx] = line;
  else lines.push(line);
  return lines;
}

function getEnvValue(lines: string[], key: string): string {
  const line = lines.find((l) => l.startsWith(`${key}=`));
  return line ? line.slice(key.length + 1).trim() : "";
}

async function main(): Promise<void> {
  if (!existsSync(envPath)) {
    console.error("backend/.env doesn't exist yet -- copy .env.example to .env first.");
    process.exitCode = 1;
    return;
  }

  const password = await promptHidden("New dashboard login password (min 8 characters): ");
  if (password.length < 8) {
    console.error("Password must be at least 8 characters -- nothing was changed.");
    process.exitCode = 1;
    return;
  }
  const confirm = await promptHidden("Confirm password: ");
  if (confirm !== password) {
    console.error("Passwords didn't match -- nothing was changed.");
    process.exitCode = 1;
    return;
  }

  let lines = readFileSync(envPath, "utf-8").split(/\r?\n/);
  lines = setEnvValue(lines, "AUTH_PASSWORD_HASH", hashPassword(password));

  if (!getEnvValue(lines, "SESSION_SECRET")) {
    lines = setEnvValue(lines, "SESSION_SECRET", randomBytes(32).toString("hex"));
  }

  writeFileSync(envPath, lines.join("\n"));
  console.log("\nDashboard login password set. Restart the backend for it to take effect.");
}

main();
