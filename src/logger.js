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
    if (this.level <= LogLevel.TRACE) {
      console.log(chalk.dim(msg));
    }
  }

  info(msg) {
    if (this.level <= LogLevel.INFO) {
      console.log(msg);
    }
  }

  warn(msg) {
    if (this.level <= LogLevel.WARN) {
      console.error(`${chalk.yellow('Warning:')} ${msg}`);
    }
  }

  error(msg) {
    if (this.level <= LogLevel.ERROR) {
      console.error(`${chalk.red('Error:')} ${msg}`);
    }
  }
}
