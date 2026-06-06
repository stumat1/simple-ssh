// Custom electron-builder signing hook for SSL.com **eSigner cloud** (CodeSignTool).
//
// Wired but inert by default: if the ES_* environment variables are not set it
// skips signing and the build succeeds unsigned. Enable later by:
//   1. Installing SSL.com CodeSignTool (needs Java) and setting CODESIGNTOOL_PATH
//      to its CodeSignTool.bat (or putting it on PATH).
//   2. Setting ES_USERNAME, ES_PASSWORD, ES_TOTP_SECRET, ES_CREDENTIAL_ID.
//   3. Uncommenting `sign: ./sign.cjs` under `win:` in electron-builder.yml.
//
// NOTE: only needed for the eSigner *cloud* path. A .pfx file (CSC_LINK +
// CSC_KEY_PASSWORD) or a hardware token (win.certificateSubjectName) is signed
// natively by electron-builder and does NOT use this hook.
//
// Never hard-code credentials here — always pass them via the environment.

const { execFileSync } = require('node:child_process')
const path = require('node:path')

/** @param {{ path: string }} configuration File electron-builder wants signed. */
exports.default = async function sign(configuration) {
  const filePath = configuration.path
  const name = path.basename(filePath)

  const { ES_USERNAME, ES_PASSWORD, ES_TOTP_SECRET, ES_CREDENTIAL_ID } = process.env
  if (!ES_USERNAME || !ES_PASSWORD || !ES_TOTP_SECRET) {
    console.log(`[sign] ES_* not set — skipping signing of ${name} (unsigned build)`)
    return
  }

  // CodeSignTool.bat on Windows; allow an explicit override.
  const tool = process.env.CODESIGNTOOL_PATH || 'CodeSignTool.bat'
  const args = [
    'sign',
    `-username=${ES_USERNAME}`,
    `-password=${ES_PASSWORD}`,
    `-totp_secret=${ES_TOTP_SECRET}`,
    `-input_file_path=${filePath}`,
    // sign in place; CodeSignTool otherwise writes to an output dir
    '-override'
  ]
  if (ES_CREDENTIAL_ID) args.push(`-credential_id=${ES_CREDENTIAL_ID}`)

  console.log(`[sign] CodeSignTool signing ${name}`)
  execFileSync(tool, args, { stdio: 'inherit' })
}
