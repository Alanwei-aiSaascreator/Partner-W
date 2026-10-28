import { execFile as nodeExecFile } from 'node:child_process';

const SSH_TIMEOUT_MS = 60_000;
const SFTP_TIMEOUT_MS = 600_000;
const PUBLIC_FETCH_TIMEOUT_MS = 60_000;

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
  if (/^[A-Za-z0-9._/:@+-]+$/u.test(value)) return value;
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
    '-o',
    'GlobalKnownHostsFile=/dev/null',
  ];
}

function assertPinnedHost(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new FeedTransportError('the ssh host must be a non empty string');
  }
  if (value.startsWith('-') || /[\s\u0000-\u001f]/u.test(value)) {
    throw new FeedTransportError('the ssh host must not start with a dash or carry whitespace or control characters');
  }
  return value;
}

function assertPinnedKnownHostsPath(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new FeedTransportError('the known hosts file must be a non empty string');
  }
  return value;
}

export function mapExecFileOutcome(error, stdout, stderr) {
  if (error !== null && error !== undefined) {
    return {
      status: typeof error.code === 'number' ? error.code : -1,
      stdout: String(stdout ?? ''),
      stderr: String(stderr ?? error.message ?? ''),
    };
  }
  return { status: 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') };
}

export function createFeedTransport(input) {
  const host = input.host;
  const knownHostsPath = input.knownHostsPath;
  assertPinnedHost(host);
  assertPinnedKnownHostsPath(knownHostsPath);

  const runner =
    input.execFile ??
    ((command, args, options) =>
      new Promise((resolve) => {
        nodeExecFile(command, args, options, (error, stdout, stderr) => {
          resolve(mapExecFileOutcome(error, stdout, stderr));
        });
      }));

  async function sshRun(request) {
    const callHost = assertPinnedHost(request.host ?? host);
    const callKnownHostsPath = assertPinnedKnownHostsPath(request.knownHostsPath ?? knownHostsPath);
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
    if ((request.writeBatch === undefined) !== (request.batchFile === undefined)) {
      throw new FeedTransportError(
        'a per call sftp writer and its batch file must be overridden together, or the writer appends to a file that the sftp batch never reads',
      );
    }
    const writeBatch = request.writeBatch ?? input.writeBatch;
    if (typeof writeBatch !== 'function') throw new FeedTransportError('the sftp batch writer is required');
    const batchFile = request.batchFile ?? input.batchFile;
    if (typeof batchFile !== 'string' || batchFile.length === 0) {
      throw new FeedTransportError('the sftp batch file path is required');
    }
    const callHost = assertPinnedHost(request.host ?? host);
    const callKnownHostsPath = assertPinnedKnownHostsPath(request.knownHostsPath ?? knownHostsPath);
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
      const response = await fetch(url, {
        redirect: 'error',
        signal: AbortSignal.timeout(PUBLIC_FETCH_TIMEOUT_MS),
      });
      return { status: response.status, arrayBuffer: () => response.arrayBuffer() };
    });

  const defaultFetchStream =
    input.fetchPublicStream ??
    (async (url, budgets = {}) => {
      const headerTimeoutMs = budgets.headerTimeoutMs ?? PUBLIC_FETCH_TIMEOUT_MS;
      const bodyTimeoutMs = budgets.bodyTimeoutMs ?? PUBLIC_FETCH_TIMEOUT_MS;
      const controller = new AbortController();
      const headerTimer = setTimeout(
        () => controller.abort(new Error(`the public fetch did not answer within ${headerTimeoutMs} ms`)),
        headerTimeoutMs,
      );
      let response;
      try {
        response = await fetch(url, { redirect: 'error', signal: controller.signal });
      } finally {
        clearTimeout(headerTimer);
      }
      const bodyTimer = setTimeout(
        () => controller.abort(new Error(`the public body did not finish within ${bodyTimeoutMs} ms`)),
        bodyTimeoutMs,
      );
      return {
        status: response.status,
        contentLength: response.headers.get('content-length'),
        body: response.body,
        dispose: () => clearTimeout(bodyTimer),
      };
    });

  const fetchPublicStream = async (url, budgets) => {
    if (input.fetchPublicStream === undefined && input.fetchPublic !== undefined) {
      const response = await input.fetchPublic(url);
      let bytes = response?.bodyBytes;
      if (bytes === undefined && typeof response?.arrayBuffer === 'function') {
        bytes = new Uint8Array(await response.arrayBuffer());
      }
      return { status: response?.status ?? 0, contentLength: null, body: [bytes ?? new Uint8Array()] };
    }
    return defaultFetchStream(url, budgets);
  };

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
    fetchPublicStream,
  };
}
