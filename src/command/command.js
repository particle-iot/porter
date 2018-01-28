import { ConsoleLogger } from '../logger';

// Base class for a CLI command handler
export class Command {
  constructor(yargs, log) {
    this.log = log;
  }
}
