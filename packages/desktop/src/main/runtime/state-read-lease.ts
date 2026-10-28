import { spawn } from 'node:child_process';

export interface StateReadLease {
  assertHeld(): void;
  release(): Promise<void>;
}

export async function acquireStateReadLease(files: string[]): Promise<StateReadLease> {
  if (process.platform !== 'win32') throw new Error('Portable state migration requires a Windows read lease');
  const script = `
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
$taskStreams = [System.Collections.Generic.List[System.IO.FileStream]]::new()
try {
  $taskFiles = ConvertFrom-Json ([Console]::In.ReadLine())
  foreach ($taskFile in $taskFiles) {
    $taskStreams.Add([System.IO.File]::Open($taskFile, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read))
  }
  [Console]::Out.WriteLine('READY')
  [Console]::Out.Flush()
  [Console]::In.ReadLine() | Out-Null
} catch {
  [Console]::Error.WriteLine('Could not hold a read-only snapshot; close the previous gateway and retry.')
  exit 1
} finally {
  foreach ($taskStream in $taskStreams) { $taskStream.Dispose() }
}
`;
  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  let exited = false;
  let ready = false;
  const completion = new Promise<void>((resolve) => {
    child.once('exit', () => {
      exited = true;
      resolve();
    });
    child.once('error', () => {
      exited = true;
      resolve();
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out acquiring the portable state read lease')), 30_000);
      let output = '';
      const fail = () => {
        clearTimeout(timer);
        reject(
          new Error('State is busy or its read lease could not be verified; close the previous gateway and retry'),
        );
      };
      child.once('error', fail);
      child.once('exit', () => {
        if (!ready) fail();
      });
      child.stdin.once('error', fail);
      child.stderr.resume();
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString();
        if (output.includes('READY')) {
          ready = true;
          clearTimeout(timer);
          resolve();
        }
      });
      child.stdin.write(`${JSON.stringify(files)}\n`);
    });
  } catch (error) {
    child.kill();
    await completion;
    throw error;
  }
  return {
    assertHeld: () => {
      if (exited || child.exitCode !== null) throw new Error('Portable state read lease ended before publication');
    },
    release: async () => {
      if (!exited) child.stdin.end('release\n');
      await completion;
    },
  };
}
