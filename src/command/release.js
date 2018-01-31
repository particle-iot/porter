import { Command } from './command';
import { github, rateLimited, ORG_NAME, FIRMWARE_REPO } from '../github';
import { git, firmwarePath } from '../git';
import { readTextFile, writeTextFile, readFileLines, updateFileLines, searchLastLine, matchLastLine, replaceLastLine,
    replaceLine, insertAfterLastLine, makeTempDir, backupCopy, restoreBackup } from '../file-util';

import semver from 'semver';

import path from 'path';

const CHANGELOG_FILE = 'CHANGELOG.md';

// Recognized issue labels
const LABELS = [
  {
    name: 'feature', // Label name
    section: 'FEATURES' // Changelog section
  },
  {
    name: 'enhancement',
    section: 'ENHANCEMENTS'
  },
  {
    name: 'bug',
    section: 'BUGFIXES'
  },
  {
    name: 'internal',
    section: 'INTERNAL'
  }
];

async function checkLabels() {
  for (let { name } of LABELS) {
    try {
      await github.issues.getLabel({
        owner: ORG_NAME,
        repo: FIRMWARE_REPO,
        name: name
      });
    } catch (err) {
      if (err.code == 404) {
        throw new Error(`Unknown issue label: '${name}'`);
      }
      throw err;
    }
  }
}

async function getFirmwareVersion(rootPath) {
  const file = `${rootPath}/build/version.mk`;
  const lines = await readFileLines(file);
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
      yargs.command('changelog', 'Generate changelog', yargs => {
        yargs.option('token', {
          alias: 't',
          describe: 'GitHub authentication token',
          type: 'string'
        });
      },argv => this.changelog(argv));
      yargs.command('show', 'Show release info', yargs => {
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
    await updateFileLines(file, lines => {
      if (!update(lines)) {
        throw new Error('Unexpected file format');
      }
    });
  }

  async changelog(argv) {
    if (argv.token) {
      github.authenticate({
        type: 'oauth',
        token: argv.token
      });
    }
    // Get current firmware version
    const rootPath = await firmwarePath();
    const curVer = await getFirmwareVersion(rootPath);
    this.log.info(`Current version: ${curVer}`);
    // Get previous version
    const tagInfo = await git.tags();
    const vers = [];
    for (let tag of tagInfo.all) {
      if (tag.startsWith('v')) {
        const ver = tag.substr(1);
        if (semver.valid(ver) && semver.compare(ver, curVer) < 0) {
          vers.push(ver);
        }
      }
    }
    if (vers.length == 0) {
      throw new Error('Unable to determine previous firmware version');
    }
    vers.sort(semver.compare);
    const prevVer = vers[vers.length - 1];
    this.log.info(`Previous version: ${prevVer}`);
    // Find a common ancestor
    const curCommit = (await git.revparse(['HEAD'])).trim();
    const prevCommit = (await git.revparse([`v${prevVer}`])).trim();
    const baseCommit = (await git.raw(['merge-base', prevCommit, curCommit])).trim();
    // Collect all merged PRs
    this.log.info('Getting list of merged PRs');
    const logInfo = await git.log({ from: baseCommit, to: curCommit, '--merges': true });
    const prs = [];
    const regexp = /^Merge pull request #(\d+) from (.*)$/;
    for (let log of logInfo.all) {
      const match = log.message.match(regexp);
      if (!match) {
        continue;
      }
      prs.push(match[1]);
    }
    // Ensure that the recognized labels are still registered
    await checkLabels();
    // Get list of merged PRs and arrange them by labels
    let prsByLabel = {};
    for (let label of LABELS) {
      prsByLabel[label.name] = [];
    }
    let prCount = 0;
    for (let prNum of prs) {
      const pr = await github.issues.get({
        owner: ORG_NAME,
        repo: FIRMWARE_REPO,
        number: prNum
      });
      let labelCount = 0;
      if (pr.data.labels) {
        for (let { name } of pr.data.labels) {
          const prs = prsByLabel[name];
          if (prs) {
            prs.push(pr);
            ++labelCount;
            ++prCount;
          }
        }
      }
      if (labelCount == 0) {
        this.log.warn(`PR has no recognized labels assigned: ${pr.data.html_url}`);
      }
    }
    if (prCount == 0) {
      this.log.info('No labeled PRs found');
      return;
    }
    // Generate changelog
    this.log.info('Generating changelog');
    let data = `## ${curVer}\n\n`;
    for (let label of LABELS) {
      const prs = prsByLabel[label.name];
      if (prs.length == 0) {
        continue;
      }
      data += `### ${label.section}\n\n`;
      for (let pr of prs) {
        data += `- ${pr.data.title} [#${pr.data.number}](${pr.data.html_url})\n`;
      }
      data += '\n';
    }
    this.log.trace(`Updating file: ${CHANGELOG_FILE}`);
    const file = `${rootPath}/${CHANGELOG_FILE}`;
    const srcData = await readTextFile(file);
    await writeTextFile(file, data + srcData);
    this.log.info('Use `git diff` to review the changes');
  }

  async showVersion(argv) {
    const rootPath = await firmwarePath();
    const version = await getFirmwareVersion(rootPath);
    this.log.info(version);
  }
}
