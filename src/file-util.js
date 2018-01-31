import promisify from 'es6-promisify';
import * as shell from 'shelljs';
import * as tmp from 'tmp';

import * as fs from 'fs';
import * as path from 'path';

const tempDirAsync = promisify(tmp.dir);
const readFileAsync = promisify(fs.readFile);
const writeFileAsync = promisify(fs.writeFile);

let rootTempDir = null;

export async function readTextFile(file) {
  return await readFileAsync(file, 'utf8');
}

export async function writeTextFile(file, data) {
  await writeFileAsync(file, data, 'utf8');
}

export async function readFileLines(file) {
  const data = await readTextFile(file);
  return data.split(/\r?\n/);
}

export async function writeFileLines(file, lines) {
  const data = lines.join('\n');
  await writeTextFile(file, data);
}

export async function updateFileLines(file, update) {
  const lines = await readFileLines(file);
  let result = update(lines);
  if (!result) {
    result = lines;
  }
  await writeFileLines(file, result);
}

export function searchLastLine(lines, regexp) {
  for (let i = lines.length - 1; i >= 0; --i) {
    if (lines[i].search(regexp) >= 0) {
      return i;
    }
  }
  return -1;
}

export function matchLastLine(lines, regexp) {
  for (let i = lines.length - 1; i >= 0; --i) {
    const match = lines[i].match(regexp);
    if (match) {
      return match;
    }
  }
  return null;
}

export function replaceLastLine(lines, regexp, replace) {
  for (let i = lines.length - 1; i >= 0; --i) {
    if (lines[i].match(regexp)) {
      lines[i] = lines[i].replace(regexp, replace);
      return true;
    }
  }
  return false;
}

export function replaceLine(lines, regexp, replace) {
  let found = false;
  for (let i = 0; i < lines.length; ++i) {
    if (lines[i].match(regexp)) {
      lines[i] = lines[i].replace(regexp, replace);
      found = true;
    }
  }
  return found;
}

export function insertAfterLastLine(lines, regexp, newLine) {
  for (let i = lines.length - 1; i >= 0; --i) {
    if (lines[i].match(regexp)) {
      lines.splice(i + 1, 0, newLine);
      return true;
    }
  }
  return false;
}

export async function makeTempDir() {
  if (!rootTempDir) {
    rootTempDir = await tempDirAsync();
  }
  return tempDirAsync({ dir: rootTempDir });
}

export async function backupCopy(src, dir, prefix = '.') {
  src = path.resolve(src);
  prefix = path.resolve(prefix) + path.sep;
  if (!src.startsWith(prefix)) {
    throw new Error(`Invalid path prefix: ${prefix}`);
  }
  const dest = path.join(dir, src.substr(prefix.length, src.length - prefix.length));
  shell.mkdir('-p', path.dirname(dest));
  shell.cp('-R', src, dest);
}

export async function restoreBackup(dir, prefix = '.') {
  try {
    const src = path.join(dir, '*');
    shell.cp('-R', src, prefix);
  } catch (err) {
  }
}
