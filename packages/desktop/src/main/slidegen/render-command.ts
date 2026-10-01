import { app, session } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderSlideSourceFile } from './render-file.js';
import { contained } from './source-file.js';

let sent = false;
let deadline: ReturnType<typeof setTimeout> | undefined;
function finish(report: { status: string }) {
  if (sent) return;
  sent = true;
  clearTimeout(deadline);
  process.stdout.write(JSON.stringify(report) + '\n', () => app.exit(report.status === 'file-generated' ? 0 : 1));
}
function failure(code: string) {
  return {
    schemaVersion: 1,
    status: 'render-failed',
    diagnostics: [{ code }],
    fileCreated: false,
    artifactIndexed: false,
    visualReview: 'not-performed',
  };
}

const flag = process.argv.indexOf('--royin-render-slidegen');
const args = process.argv.slice(flag + 1);
if (flag < 0 || args.length !== 1 || args[0].startsWith('--')) {
  finish({ ...failure('source-argument-invalid'), status: 'source-invalid' });
} else {
  try {
    const workspace = fs.realpathSync(process.cwd());
    const profile = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'royin-slidegen-')));
    for (const name of ['appData', 'userData', 'sessionData', 'logs', 'temp', 'cache', 'crashDumps'] as const) {
      const directory = path.join(profile, name);
      fs.mkdirSync(directory);
      app.setPath(name, directory);
    }
    process.env.TEMP = path.join(profile, 'temp');
    process.env.TMP = process.env.TEMP;
    app.disableHardwareAcceleration();
    deadline = setTimeout(() => finish(failure('render-command-timeout')), 120_000);
    app
      .whenReady()
      .then(async () => {
        session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
          let allowed = /^(data:|devtools:)/.test(details.url);
          if (details.url.startsWith('file:')) {
            try {
              const file = fs.realpathSync(fileURLToPath(details.url));
              allowed = contained(workspace, file) || contained(profile, file);
            } catch {
              allowed = false;
            }
          }
          callback({ cancel: !allowed });
        });
        session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
        session.defaultSession.setPermissionCheckHandler(() => false);
        try {
          finish(await renderSlideSourceFile(args[0], workspace));
        } catch {
          finish(failure('render-command-failed'));
        }
      })
      .catch(() => finish(failure('render-runtime-unavailable')));
  } catch {
    finish(failure('render-runtime-unavailable'));
  }
}
