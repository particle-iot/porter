import simpleGit from 'simple-git/promise';

const FIRMWARE_SSH = 'git@github.com:particle-iot/firmware.git';
const FIRMWARE_HTTPS = 'https://github.com/particle-iot/firmware.git';

export const git = simpleGit(); // Use current working directory

// Disable console output
git.silent(true);

// Returns absolute path to the firmware directory
export async function firmwarePath() {
  const remotes = await git.getRemotes(true); // verbose: true
  const isFirmware = remotes.some(remote => {
    const { fetch, push } = remote.refs;
    return (fetch == FIRMWARE_SSH || fetch == FIRMWARE_HTTPS || push == FIRMWARE_SSH || push == FIRMWARE_HTTPS);
  });
  if (!isFirmware) {
    throw new Error('Not a firmware repository');
  }
  const path = await git.revparse(['--show-toplevel']);
  return path.trim();
}
