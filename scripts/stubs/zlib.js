// node:zlib for just-bash in the browser (scripts/vendor.mjs): its gzip/gunzip/zcat and tar.gz support need Node.
// The shell still runs; those commands say they aren't available.
const no = () => { throw new Error('gzip is not available in the browser shell'); };
export const gzipSync = no;
export const gunzipSync = no;
export const constants = {};
export default { gzipSync, gunzipSync, constants };
