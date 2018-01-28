import { Command } from './command';
import { readTextFile, updateTextFile, searchLastLine, matchLastLine, replaceLastLine, replaceLine, insertAfterLastLine,
    makeTempDir, backupCopy, restoreBackup } from '../file-util';
import { git, firmwarePath } from '../git';

import { dump } from '../misc'; // FIXME

import semver from 'semver';

import path from 'path';

async function getFirmwareVersion(rootPath) {
  const file = `${rootPath}/build/version.mk`;
  const lines = await readTextFile(file);
  const match = matchLastLine(lines, /^\s*VERSION_STRING\s*=\s*(\S+)\s*$/)
  if (!match) {
    throw new Error(`Unable to determine firmware version`);
  }
  const ver = match[1];
  if (!semver.valid(ver)) {
    throw new Error(`Invalid version number: ${ver}`);
  }
  return ver;
}

function nextModuleVersion(newVer, curVer, moduleVer) {
  if (typeof moduleVer == 'string') {
    moduleVer = Number.parseInt(moduleVer);
    if (Number.isNaN(moduleVer)) {
      throw new Error('Invalid module version');
    }
  }
  let inc = 0;
  if (semver.major(newVer) > semver.major(curVer)) {
    inc = 10000; // TODO: We don't have a convention for a major version increment
  } else if (semver.minor(newVer) > semver.minor(curVer)) {
    inc = 100;
  } else {
    inc = 1;
  }
  return (Math.floor(moduleVer / inc) + 1) * inc;
}

export class ReleaseCommand extends Command {
  constructor(yargs, log) {
    super(yargs, log);
    yargs.command('release', 'Commands specific to the firmware release process', yargs => {
      yargs.command('init <version>', 'Check out a new release branch and update the firmware version', yargs => {
        yargs.positional('version', {
          describe: 'Version number',
          type: 'string'
        });
      }, argv => this.init(argv));
      yargs.command(['show', '*'], 'Show release info', yargs => {
        yargs.command(['version', '*'], 'Show current firmware version', yargs => {}, argv => this.showVersion(argv));
      });
    });
  }

  async init(argv) {
    const newVer = argv.version;
    if (!semver.valid(newVer)) {
      throw new Error(`Invalid version number: ${newVer}`);
    }
    this.log.info(`Release version: ${newVer}`);
    // Get current firmware version
    const rootPath = await firmwarePath();
    const curVer = await getFirmwareVersion(rootPath);
    this.log.info(`Current version: ${curVer}`);
    if (semver.compare(newVer, curVer) <= 0) {
      throw new Error('Release version should be larger than the current version');
    }
    // Check out a new release branch
    const branchInfo = await git.branchLocal();
    if (branchInfo.detached) {
      throw new Error('Current branch is detached');
    }
    const origBranch = branchInfo.current;
    const branch = `release/v${newVer}`;
    this.log.info(`Checking out a new branch: ${branch}`);
    await git.checkoutLocalBranch(branch);
    // Update source files
    const backupDir = await makeTempDir();
    try {
      this.log.info('Updating source files');
      await this._updateFirmwareVersion(newVer, curVer, rootPath, backupDir);
    } catch (err) {
      // Rollback source tree changes
      await restoreBackup(backupDir, rootPath);
      await git.checkout(origBranch);
      await git.deleteLocalBranch(branch);
      throw err;
    }
    this.log.info('Use `git diff` to review the changes');
  }

  async _updateFirmwareVersion(newVer, curVer, rootPath, backupDir) {
    // build/release.sh
    await this._updateSourceFile('build/release.sh', rootPath, backupDir, lines => {
      return replaceLastLine(lines, /^\s*VERSION="?\S+"?\s*$/, `VERSION="${newVer}"`);
    });
    // build/version.mk
    await this._updateSourceFile('build/version.mk', rootPath, backupDir, lines => {
      if (!replaceLastLine(lines, /^\s*VERSION_STRING\s*=\s*\S+\s*$/, `VERSION_STRING = ${newVer}`)) {
        return false;
      }
      return replaceLastLine(lines, /^\s*VERSION\s*=\s*(\S+)\s*$/, (match, moduleVer) => {
        return `VERSION = ${nextModuleVersion(newVer, curVer, moduleVer)}`;
      });
    });
    // modules/shared/system_module_version.mk
    await this._updateSourceFile('modules/shared/system_module_version.mk', rootPath, backupDir, lines => {
      return replaceLine(lines, /^\s*SYSTEM_PART(\d+)_MODULE_VERSION\s*\?=\s*(\S+)\s*$/, (match, index, moduleVer) => {
        return `SYSTEM_PART${index}_MODULE_VERSION ?= ${nextModuleVersion(newVer, curVer, moduleVer)}`;
      });
    });
    // system/inc/system_version.h
    await this._updateSourceFile('system/inc/system_version.h', rootPath, backupDir, lines => {
      // #define SYSTEM_VERSION_vXXX 0xXXXXXXXX
      const major = semver.major(newVer);
      const minor = semver.minor(newVer);
      const patch = semver.patch(newVer);
      let id = major.toString(); // Version ID, e.g. '070RC2' for 0.7.0-rc.2
      if (minor < 10 && patch < 10) {
        id += minor.toString() + patch.toString();
      } else {
        id += minor.toString().padStart(2, '0') + patch.toString().padStart(2, '0');
      }
      const tags = semver.prerelease(newVer);
      let prerelease = 0;
      if (tags) {
        for (let tag of tags) {
          if (typeof tag == 'string') {
            id += tag.toUpperCase();
          } else {
            if (!prerelease) {
              prerelease = tag;
            }
            id += tag.toString();
          }
        }
      }
      const value = '0x' + major.toString().padStart(2, '0') + minor.toString().padStart(2, '0') +
          patch.toString().padStart(2, '0') + prerelease.toString().padStart(2, '0');
      if (!insertAfterLastLine(lines, /^\s*#\s*define\s+SYSTEM_VERSION_v\w+\s+0x\d+\s*$/,
          `#define SYSTEM_VERSION_v${id} ${value}`)) {
        return false;
      }
      // #define SYSTEM_VERSION SYSTEM_VERSION_vXXX
      if (!replaceLastLine(lines, /^\s*#\s*define\s+SYSTEM_VERSION\s+\w+\s*$/,
          `#define SYSTEM_VERSION SYSTEM_VERSION_v${id}`)) {
        return false;
      }
      // #define SYSTEM_VERSION_XXX
      return insertAfterLastLine(lines, /^\s*#\s*define\s+SYSTEM_VERSION_\d\w+\s*$/, `#define SYSTEM_VERSION_${id}`);
    });
  }

  async _updateSourceFile(file, rootPath, backupDir, update) {
    this.log.trace(`Updating file: ${file}`);
    file = path.join(rootPath, file);
    await backupCopy(file, backupDir, rootPath);
    await updateTextFile(file, lines => {
      if (!update(lines)) {
        throw new Error('Unexpected file format');
      }
    });
  }

  async showVersion(argv) {
    const rootPath = await firmwarePath();
    const version = await getFirmwareVersion(rootPath);
    this.log.info(version);
  }
}
