import { ReleaseCommand } from './command/release';
import { ConsoleLogger, LogLevel } from './logger';

import yargs from 'yargs';

const log = new ConsoleLogger();

// Global options
yargs.option('verbose', {
  alias: 'v',
  describe: 'Enable verbose output',
  boolean: true
}).option('quiet', {
  alias: 'q',
  describe: 'Disable console output',
  boolean: true
}).check(argv => {
  // FIXME: Is there a better way to handle global options with yargs?
  if (argv.quiet) {
    log.level = LogLevel.NONE
  } else if (argv.verbose) {
    log.level = LogLevel.TRACE
  }
  return true;
}).fail((msg, err, yargs) => {
  log.error(err ? err.message : msg);
  process.exit(1);
}).strict().wrap(null).version(false); // FIXME

// Register commands
new ReleaseCommand(yargs, log);

// Parse arguments and run a command handler
yargs.parse();
