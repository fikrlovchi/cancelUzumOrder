const fs = require("fs");
const path = require("path");

const logDir = path.join(__dirname, "..", "logs");
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

const logFile = path.join(logDir, `${new Date().toISOString().slice(0, 10)}.log`);

let buffer = [];

function write(level, message) {
  const loggedAt = new Date().toISOString();
  const line = `[${loggedAt}] [${level}] ${message}`;
  console.log(line);
  fs.appendFileSync(logFile, line + "\n");
  buffer.push({ level, message, loggedAt });
}

function getBufferAndClear() {
  const current = buffer;
  buffer = [];
  return current;
}

module.exports = {
  info: (msg) => write("INFO", msg),
  error: (msg) => write("ERROR", msg),
  getBufferAndClear,
};
