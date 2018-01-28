import chalk from 'chalk';

export const LogLevel = {
  TRACE: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
  NONE: 4
};

export class ConsoleLogger {
  constructor(level = LogLevel.INFO) {
    this.level = level;
  }

  trace(msg) {
    this._log(LogLevel.TRACE, chalk.dim(msg));
  }

  info(msg) {
    this._log(LogLevel.INFO, msg);
  }

  warn(msg) {
    this._log(LogLevel.WARN, `${chalk.yellow('Warning:')} ${msg}`);
  }

  error(msg) {
    this._log(LogLevel.ERROR, `${chalk.red('Error:')} ${msg}`);
  }

  _log(level, msg) {
    if (level >= this.level) {
      console.log(msg);
    }
  }
}
