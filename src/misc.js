import * as util from 'util';

export function dump(val) {
  console.log(util.inspect(val, { depth: null }));
}
