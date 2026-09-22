import { execFile as nodeExecFile } from 'node:child_process';

const SSH_TIMEOUT_MS = 60_000;
const SFTP_TIMEOUT_MS = 600_000;

export class FeedTransportError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FeedTransportError';
  }
}

export function quoteBatchPath(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new FeedTransportError('an sftp batch path is required');
  }
  if (/[\r\n\u0000]/u.test(value)) {
    throw new FeedTransportError('an sftp batch path must not contain a carriage return, a newline or a nul byte');
  }
  if (!/[\s"]/u.test(value)) return value;
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function pinnedOptions(knownHostsPath) {
  return [
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=yes',
    '-o',
    `UserKnownHostsFile=${knownHostsPath}`,
    '-o',
    'ConnectTimeout=15',
  ];
}

export function createFeedTransport(input) {
  const host = input.host;
  const knownHostsPath = input.knownHostsPath;
  if (typeof host !== 'string' || host.length === 0) throw new FeedTransportError('the ssh host is required');
  if (typeof knownHostsPath !== 'string' || knownHostsPath.length === 0) {
    throw new FeedTransportError('the pinned known hosts file is required');
  }

  const runner =
    input.execFile ??
    ((command, args, options) =>
      new Promise((resolve) => {
        nodeExecFile(command, args, options, (error, stdout, stderr) => {
          if (error !== null && error !== undefined) {
            resolve({
              status: typeof error.code === 'number' ? error.code : -1,
              stdout: String(stdout ?? ''),
              stderr: String(stderr ?? error.message ?? ''),
            });
            return;
          }
          resolve({ status: 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
        });
      }));

  async function sshRun(request) {
    const callHost = request.host ?? host;
    const callKnownHostsPath = request.knownHostsPath ?? knownHostsPath;
    const result = await runner('ssh', [...pinnedOptions(callKnownHostsPath), callHost, request.script], {
      encoding: 'utf8',
      timeout: SSH_TIMEOUT_MS,
      windowsHide: true,
    });
    return {
      status: typeof result?.status === 'number' ? result.status : -1,
      stdout: result?.stdout ?? '',
      stderr: result?.stderr ?? '',
    };
  }

  async function sftpUpload(request) {
    const writeBatch = request.writeBatch ?? input.writeBatch;
    if (typeof writeBatch !== 'function') throw new FeedTransportError('the sftp batch writer is required');
    const batchFile = input.batchFile;
    if (typeof batchFile !== 'string' || batchFile.length === 0) {
      throw new FeedTransportError('the sftp batch file path is required');
    }
    const callHost = request.host ?? host;
    const callKnownHostsPath = request.knownHostsPath ?? knownHostsPath;
    const command = request.resume === true ? 'reput' : 'put';
    writeBatch(`${command} ${quoteBatchPath(request.localPath)} ${quoteBatchPath(request.remotePath)}\n`);
    const result = await runner('sftp', [...pinnedOptions(callKnownHostsPath), '-b', batchFile, callHost], {
      encoding: 'utf8',
      timeout: SFTP_TIMEOUT_MS,
      windowsHide: true,
    });
    return {
      status: typeof result?.status === 'number' ? result.status : -1,
      stdout: result?.stdout ?? '',
      stderr: result?.stderr ?? '',
    };
  }

  const publicFetch =
    input.fetchPublic ??
    (async (url) => {
      const response = await fetch(url, { redirect: 'error' });
      return { status: response.status, arrayBuffer: () => response.arrayBuffer() };
    });

  return {
    readOnly: { sshRun },
    write: { sshRun, sftpUpload },
    fetchPublic: async (url) => {
      const response = await publicFetch(url);
      if (typeof response?.arrayBuffer !== 'function') {
        return { status: response?.status ?? 0, bodyBytes: new Uint8Array() };
      }
      return { status: response.status, bodyBytes: new Uint8Array(await response.arrayBuffer()) };
    },
  };
}
