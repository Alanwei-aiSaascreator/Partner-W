import { PortableLauncherBuildError, buildPortableLauncher } from './lib/portable-launcher-build.mjs';

try {
  const result = buildPortableLauncher({
    env: process.env,
    log: (message) => console.log(message),
  });
  console.log(`portable launcher ready: ${result.size} bytes`);
} catch (error) {
  console.error(error instanceof PortableLauncherBuildError ? error.message : error);
  process.exit(1);
}
